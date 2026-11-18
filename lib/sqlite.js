const fs = require('fs')
const { DatabaseSync, constants } = require('node:sqlite')
const { pathToFileURL } = require('url')

// What a read-only database may do: read, call a function, recurse in a CTE.
// Anything else (write, DDL, ATTACH, VACUUM INTO, BEGIN, ...) is denied by
// default: the immutable flag alone still lets VACUUM INTO write a new file.
const READ_ACTIONS = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE])
// The pragmas a read-only database may run: schema introspection only, to
// read the columns of a backup (`pragma_table_info('templates')`), and
// data_version, that full-text search (FTS5) reads
const READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'data_version'])

// Largest value a read-only database may build, as a multiple of its size,
// never under the floor: a generated column of the file cannot allocate
// gigabytes, a json_group_array() of a whole table still fits
const VALUE_LENGTH_FACTOR = 4
const VALUE_LENGTH_FLOOR = 1 << 24

/**
 * Authorizer of a read-only database. SQL stored in the untrusted file never
 * runs: a view could loop forever, the event loop blocked with it. Each view
 * authorizes its SELECT in its own name; a CTE of the query, in the CTE's.
 * @param {Set} views Names of the views of the file
 * @return {Function} (action, name, arg2, schema, context) => SQLITE_OK or SQLITE_DENY
 */
function readAuthorizer (views) {
  return (action, name, arg2, schema, context) => {
    const _allowed = views.has(context) === false && (READ_ACTIONS.has(action) || (action === constants.SQLITE_PRAGMA && READ_PRAGMAS.has(String(name).toLowerCase())))

    return _allowed ? constants.SQLITE_OK : constants.SQLITE_DENY
  }
}

// Prepared statements kept per connection, the oldest evicted: a
// registered SQL file renders to a handful of variants, each compiled once
const STATEMENT_CACHE_SIZE = 200

// What may follow the first statement of a single-statement query
const TRAILING_NOTHING = /^(\s|;|--[^\n]*(\n|$)|\/\*[\s\S]*?(\*\/|$))*$/

// busy_timeout has no "no limit": 0 would fail at once on a locked database
const NO_TIMEOUT = 2147483647

/**
 * node:sqlite binds floats, strings, bigints, a Buffer or Uint8Array (BLOB),
 * booleans (1/0) and undefined (NULL) itself, and refuses a symbol or a
 * function with an error. A Date is bound as its ISO string, an array, a
 * plain object or an object with toJSON() as JSON, like pg does. Any other
 * object is refused: node:sqlite would bind a Float64Array or a DataView as
 * raw bytes, and JSON would turn a Map or a Set into a silent "{}".
 * @param {*} value
 * @return {*}
 */
function toBindable (value) {
  // node:sqlite binds every number as REAL: 2 would read '2.0' in a TEXT
  // column, a concatenation or JSON. A BigInt binds an INTEGER.
  if (Number.isSafeInteger(value)) {
    return BigInt(value)
  }

  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  const _proto = Object.getPrototypeOf(value)

  if (Array.isArray(value) || _proto === Object.prototype || _proto === null || typeof value.toJSON === 'function') {
    return JSON.stringify(value)
  }

  throw new TypeError(`a ${value.constructor?.name ?? 'value'} cannot be bound`)
}

/**
 * Open a SQLite database through node:sqlite. Its API is synchronous, so the
 * query callback is deferred to keep hearthjs's callbacks always async.
 * @param {Object} conf { filename | buffer, readOnly, timeout }
 * @return {Object} { db, query, close }, `db` being the DatabaseSync handle
 */
function open (conf) {
  // A buffer is loaded in a private in-memory database: the source is never
  // written, whatever runs on it
  let _location = (conf.buffer !== undefined) ? ':memory:' : conf.filename

  // Read-only opens a snapshot no process writes (a backup) as immutable: no
  // lock, no -wal/-shm created beside it, the file is never touched, and a
  // missing one throws instead of being created
  if (conf.readOnly === true && conf.buffer === undefined) {
    // Immutable ignores a -wal: its commits would be silently missing
    if (fs.statSync(`${conf.filename}-wal`, { throwIfNoEntry: false })?.size > 0) {
      throw new Error('a -wal file is beside it: copy a closed database or a backup()')
    }

    _location = pathToFileURL(conf.filename)
    _location.searchParams.set('immutable', '1')
  }

  const db = new DatabaseSync(_location, {
    readOnly: conf.readOnly === true,
    enableForeignKeyConstraints: true,
    // No SQL can corrupt the file (writable_schema, journal_mode=OFF, ...)
    defensive: true,
    timeout: (conf.timeout === 0) ? NO_TIMEOUT : conf.timeout
  })
  const statements = new Map()

  try {
    // The bytes of a WAL database (a backup() of one keeps the flag) cannot be
    // loaded in memory, where SQLite has no WAL. Its pages are those of a
    // rollback-journal database: flip the header's two version bytes, only
    // while deserialize() copies them.
    if (conf.buffer !== undefined) {
      const _bytes = conf.buffer
      const _wal = _bytes[18] === 2 && _bytes[19] === 2

      if (_wal === true) {
        _bytes[18] = _bytes[19] = 1
      }

      try {
        db.deserialize(_bytes)
      } finally {
        if (_wal === true) {
          _bytes[18] = _bytes[19] = 2
        }
      }
    }

    // Changing the journal mode writes the file: never on a read-only one. In
    // memory, WAL does not apply.
    if (conf.readOnly !== true && conf.buffer === undefined) {
      db.exec('PRAGMA journal_mode = WAL;')
    }

    // SQLite reads a file lazily: fail at open, not at the first query, when
    // it is not a database
    const _views = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'view';").all()

    // The connection's read-only flag does not survive deserialize(), and a
    // `PRAGMA query_only` could be turned off by SQL: an authorizer cannot
    if (conf.readOnly === true) {
      const _size = conf.buffer?.length ?? fs.statSync(conf.filename).size

      db.setAuthorizer(readAuthorizer(new Set(_views.map(view => view.name))))
      db.limits.length = Math.min(db.limits.length, Math.max(_size * VALUE_LENGTH_FACTOR, VALUE_LENGTH_FLOOR))
    }
  } catch (err) {
    db.close()
    throw err
  }

  // Same name as Postgres, so `NOW()` reads the same in both dialects
  db.function('NOW', () => new Date().toISOString())

  /**
   * Compile a query once. null marks a script: several statements, that
   * prepare() would silently cut to the first one, or none.
   * @param {String} sql
   * @return {Object|null} { statement, reader }
   */
  const prepare = (sql) => {
    let _entry = statements.get(sql)

    if (_entry !== undefined) {
      return _entry
    }

    // An empty or comment-only query (an empty migration file) is a script
    // too: prepare() would refuse it
    _entry = null

    if (TRAILING_NOTHING.test(sql) === false) {
      const _statement = db.prepare(sql)

      if (TRAILING_NOTHING.test(sql.slice(_statement.sourceSQL.length)) === true) {
        _entry = { statement: _statement, reader: _statement.columns().length > 0 }
      }
    }

    if (statements.size >= STATEMENT_CACHE_SIZE) {
      const [_oldestSql, _oldest] = statements.entries().next().value

      statements.delete(_oldestSql)
      // Free it now rather than at garbage collection
      _oldest?.statement.close()
    }

    statements.set(sql, _entry)
    return _entry
  }

  /**
   * Run a query and return a pg-like result
   * @param {String} sql Query, with $1, $2 placeholders
   * @param {Array} params
   * @return {Object} { rows, rowCount }
   */
  const run = (sql, params) => {
    const _entry = prepare(sql)

    if (_entry === null) {
      // Like pg: a script runs without parameters only
      if (params.length > 0) {
        throw new Error('cannot insert multiple commands into a prepared statement')
      }

      // Read-only, nothing to undo (and the authorizer denies a savepoint)
      if (conf.readOnly === true) {
        db.exec(sql)
        return { rows: [], rowCount: 0 }
      }

      // All or nothing, like Postgres: a statement that fails undoes the ones
      // before it. A savepoint, so it nests in the caller's transaction.
      db.exec('SAVEPOINT hearthjs_script;')

      try {
        db.exec(sql)
        db.exec('RELEASE hearthjs_script;')
      } catch (err) {
        // Not in a transaction any more: the script ended it (COMMIT)
        if (db.isTransaction === true) {
          db.exec('ROLLBACK TO hearthjs_script; RELEASE hearthjs_script;')
        }

        throw err
      }

      return { rows: [], rowCount: 0 }
    }

    // `$1` is a named parameter to SQLite: bind it by name, never by position
    const _named = {}

    for (let i = 0; i < params.length; i++) {
      try {
        _named[i + 1] = toBindable(params[i])
      } catch (err) {
        throw new TypeError(`Cannot bind parameter $${i + 1}: ${err.message}`)
      }
    }

    if (_entry.reader === true) {
      const _rows = _entry.statement.all(_named)
      return { rows: _rows, rowCount: _rows.length }
    }

    return { rows: [], rowCount: _entry.statement.run(_named).changes }
  }

  return {
    db,

    /**
     * Same callback as the pg path: (err, res, rows)
     * @param {String} sql
     * @param {Array} params
     * @param {Function} callback
     */
    query: function (sql, params, callback) {
      let _res = null

      try {
        if (typeof sql !== 'string') {
          throw new TypeError('A query must be a string')
        }

        if (params !== undefined && params !== null && Array.isArray(params) === false) {
          throw new TypeError('Query parameters must be an array')
        }

        _res = run(sql, params ?? [])
      } catch (err) {
        return process.nextTick(callback, err, undefined, [])
      }

      return process.nextTick(callback, null, _res, _res.rows)
    },

    close: function () {
      statements.clear()
      db.close()
    }
  }
}

module.exports = { open }
