const { Pool } = require('pg')
const mustache = require('./mustache')
const converter = require('./converter')
const logger = require('./logger')

// Errors that mean the connection itself failed, so the query either never ran
// or was lost with the socket. Node socket errno's (pg forwards them with their
// `.code`), plus Postgres class 08 (connection exception, all of it) and the
// server-initiated 57P0x terminations. NOT here on purpose: statement_timeout /
// query_canceled (57014), deadlock (40P01), database_dropped (57P04, retry is
// futile), too_many_connections (53300, retry adds load) and any real query
// error — those ran (or must not be hammered) and must never be replayed.
const CONNECTION_ERROR_CODES = new Set([
  // Node socket / DNS
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN',
  // Postgres class 08 — connection exception
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  // Postgres 57P0x — server shut the connection: admin, crash, starting up,
  // idle-session timeout
  '57P01', '57P02', '57P03', '57P05'
])

// Connection failures node-postgres surfaces without a code. Anchored to the
// exact messages it emits on a genuine drop: NOT the bare "Connection
// terminated" (that is an intentional close, this._ending), NOT "Connection
// terminated due to connection timeout" and NOT "timeout exceeded when trying
// to connect" (pool saturation — retrying would just double the wait), and NOT
// "Client was closed" (deliberate).
const CONNECTION_ERROR_MESSAGE = /connection terminated unexpectedly|connection error and is not queryable/i

const database = {
  _pool: null,
  // Null prototype: a file named toString.sql would otherwise resolve to
  // Object.prototype.toString instead of undefined
  _sqlFiles: Object.create(null),
  _defaultTimeout: 10000,
  // Fail a request fast when the pool is saturated, instead of pg's default
  // of waiting forever
  _defaultConnectionTimeout: 10000,
  _defaultPoolMax: 10,
  // Close a connection idle for this long, so a stale one is not handed out
  _defaultIdleTimeout: 10000,
  _defaultApplicationName: 'hearthjs',
  // Start TCP keepalive probes after 10s idle: the OS default (often ~2h) is
  // far too long to notice a connection a NAT or load balancer dropped
  _keepAliveInitialDelay: 10000,

  /**
   * Read a numeric pool option: the env var wins, then the config file, then
   * the default. An invalid value falls back to the default.
   * @param {String} envKey Environment variable name
   * @param {*} confValue Value from the config file
   * @param {Number} defaultValue
   * @param {Number} min Smallest accepted value
   * @return {Number}
   */
  _poolInt: function (envKey, confValue, defaultValue, min) {
    const _raw = (process.env[envKey] !== undefined) ? process.env[envKey] : confValue

    if (_raw === undefined) {
      return defaultValue
    }

    const _parsed = (typeof _raw === 'number') ? _raw : parseInt(_raw, 10)
    return (Number.isInteger(_parsed) && _parsed >= min) ? _parsed : defaultValue
  },

  /**
   * Connect the database pool
   * @param {String} user Database user
   * @param {String} host Database host
   * @param {String} database Database name
   * @param {String} password Database password
   * @param {INteger} port Database port
   * @param {Integer} timeout Database timeout
   * @param {Function} callback
   */
  init: function (conf, callback) {
    // statement_timeout cannot be a bound parameter: force an integer so
    // nothing else reaches the SQL string below.
    const _timeout = parseInt(conf.timeout, 10)
    conf.timeout = (Number.isInteger(_timeout) && _timeout >= 0) ? _timeout : this._defaultTimeout

    this._pool = new Pool({
      user: (process.env.APP_DATABASE_USER === undefined) ? conf.user : process.env.APP_DATABASE_USER,
      host: (process.env.APP_DATABASE_HOST === undefined) ? conf.host : process.env.APP_DATABASE_HOST,
      database: (process.env.APP_DATABASE_NAME === undefined) ? conf.database : process.env.APP_DATABASE_NAME,
      password: (process.env.APP_DATABASE_PASSWORD === undefined) ? conf.password : process.env.APP_DATABASE_PASSWORD,
      port: (process.env.APP_DATABASE_PORT === undefined) ? conf.port : process.env.APP_DATABASE_PORT,
      max: this._poolInt('APP_DATABASE_POOL_MAX', conf.poolMax, this._defaultPoolMax, 1),
      // Pool option, so pg applies it to every backend. A session-scoped `SET`
      // on one client left the connections opened later under load unbounded.
      // 0 means no limit, like `SET statement_timeout TO 0`.
      statement_timeout: conf.timeout,
      connectionTimeoutMillis: this._poolInt('APP_DATABASE_CONNECTION_TIMEOUT', conf.connectionTimeout, this._defaultConnectionTimeout, 0),
      // Explicit, but the same as pg-pool's own default (10s): a connection idle
      // longer is closed and recreated on demand
      idleTimeoutMillis: this._poolInt('APP_DATABASE_IDLE_TIMEOUT', conf.idleTimeout, this._defaultIdleTimeout, 0),
      // Client-side TCP keepalive (socket.setKeepAlive): detects a connection a
      // NAT/firewall/load balancer silently dropped, so the dead socket errors
      // out and is evicted instead of being handed to a request. Server-agnostic
      // (PostgreSQL, TimescaleDB, PgBouncer): it is a property of our own socket.
      keepAlive: true,
      keepAliveInitialDelayMillis: this._keepAliveInitialDelay,
      // Identify this app in pg_stat_activity, for debugging a slow query or a
      // stuck connection
      application_name: (process.env.APP_DATABASE_APPLICATION_NAME !== undefined)
        ? process.env.APP_DATABASE_APPLICATION_NAME
        : (typeof conf.applicationName === 'string' && conf.applicationName.length > 0 ? conf.applicationName : this._defaultApplicationName)
    })

    // Connectivity probe: confirm the pool round-trips a query before the
    // server reports itself ready
    this._pool.connect((err, client, done) => {
      if (err) {
        return callback(err)
      }

      done()

      this.query('SELECT 1;', (err, res) => {
        if (err) {
          return callback(err)
        }

        return callback(null)
      })
    })

    this._pool.on('error', (err) => {
      const _code = (err !== null && err !== undefined && err.code !== undefined) ? ` (${err.code})` : ''

      logger.log(`Database pool error: ${err}${_code}`, 'error')
    })
  },

  /**
   * Close pool
   * @param {Function} callback
   */
  close: function (callback) {
    this._sqlFiles = Object.create(null)
    mustache._clearFileCache()

    if (this._pool !== null) {
      this._pool.end(() => {
        this._pool = null
        return callback()
      })
    } else {
      return callback()
    }
  },

  /**
   * Register a SQL file
   * @param {String} filePath SQL file to register
   */
  registerSQLFile: function (filePath) {
    let splitted = filePath.split('/')
    let name = splitted[splitted.length - 1].split('.')[0]

    if (this._sqlFiles[name] !== undefined) {
      logger.log(`${name}.sql already exists. Skipping it...`, 'warn', { logDate: false })
    } else {
      this._sqlFiles[name] = filePath
    }
  },

  /**
   * Register a SQL file if it does not already exists
   * @param {String} filePath SQL file to register
   */
  registerSQLFileIfNotExists: function (filePath) {
    let splitted = filePath.split('/')
    let name = splitted[splitted.length - 1].split('.')[0]

    if (this._sqlFiles[name] === undefined) {
      this._sqlFiles[name] = filePath
    }
  },

  /**
   * Exec query of a registered SQL file with callback if provided, else it uses promise
   * @param {String} name Filename
   * @param {Object} data Query params
   * @param {Object} model Model of data to return
   * @param {Function} callback
   */
  exec: function (name, data, model, callback) {
    if (typeof data === 'function') {
      callback = data
      data = {}
      model = null
    } else if (typeof model === 'function') {
      callback = model
      model = null
    }

    if (callback === undefined) {
      return new Promise((resolve, reject) => {
        this.execCallback(name, data, model, (err, result, object) => {
          if (err) {
            return reject(err)
          }

          return resolve({ result, object })
        })
      })
    }

    return this.execCallback(name, data, model, callback)
  },

  /**
   * Exec query of a registered SQL file
   * @param {String} name Filename
   * @param {Object} data Query params
   * @param {Object} model Model of data to return
   * @param {Function} callback
   */
  execCallback: function (name, data, model, callback) {
    if (this._sqlFiles[name] === undefined) {
      return callback(new Error(`Unknow SQL file ${name}`))
    }

    // Content and parsed tokens are cached and revalidated by mtime, instead
    // of re-reading and re-tokenizing on every request.
    mustache.renderFile(this._sqlFiles[name], data, model, this._sqlFiles, (err, obj) => {
      if (err) {
        return callback(err)
      }

      if (obj.print_ready) {
        console.log('-- SQL Request --')
        console.log(this.prepareRequestToPrint(obj.string, obj.data))
      }

      // Print for debug
      if (obj.print !== undefined && obj.print === true) {
        console.log('-- SQL Request --')
        console.log(obj.string)
        console.log('-- Transform data --')
        console.log(JSON.stringify(obj.data))
      }

      this.query(obj.string, obj.data, (err, res, rows) => {
        if (err) {
          const _hint = (err.hint === undefined || err.hint === null) ? '' : ` (${err.hint})`

          return callback(new Error(`Error while executing query for file ${name}.sql. ${err.toString()}${_hint}`))
        }

        let formattedObject = rows
        if (model !== undefined && model !== null) {
          try {
            formattedObject = converter.sqlToJson(model, rows)
          } catch (e) {
            return callback(e + ` for model ${JSON.stringify(model)}`)
          }
        }

        return callback(null, res, formattedObject)
      })
    })
  },

  /**
   * Execute a SQL query with callback if provided, else it uses promise
   * @param {String} query Query
   * @param {Array} params Params
   * @param {Function} callback
   */
  query: function (query, params, callback) {
    if (typeof params === 'function') {
      callback = params
      params = []
    }

    if (callback === undefined) {
      return new Promise((resolve, reject) => {
        this.queryCallback(query, params, (err, result, rows) => {
          if (err) {
            return reject(err)
          }

          return resolve({ result, rows })
        })
      })
    }

    return this.queryCallback(query, params, callback)
  },

  /**
   * Execute a SQL query
   * @param {String} query Query
   * @param {Array} params Params
   * @param {Function} callback
   */
  queryCallback: function (query, params, callback) {
    return this._queryOnce(query, params, callback, false)
  },

  /**
   * Whether an error means the connection itself failed (as opposed to the
   * query being rejected by a healthy connection)
   * @param {Error} err
   * @return {Boolean}
   */
  _isConnectionError: function (err) {
    if (err === null || err === undefined) {
      return false
    }

    if (err.code !== undefined && CONNECTION_ERROR_CODES.has(err.code)) {
      return true
    }

    return typeof err.message === 'string' && CONNECTION_ERROR_MESSAGE.test(err.message)
  },

  /**
   * Whether a query is a plain read that is safe to replay. Conservative on
   * purpose: only a statement that starts with SELECT, and not a locking read
   * (`FOR UPDATE`/`SHARE`) nor `SELECT ... INTO` (both write). A `WITH` CTE is
   * never retried, since it can wrap an INSERT/UPDATE/DELETE. Any doubt errs
   * toward not retrying, so a write is never replayed.
   * @param {String} query
   * @return {Boolean}
   */
  _isIdempotentRead: function (query) {
    if (typeof query !== 'string') {
      return false
    }

    // Drop leading whitespace and SQL comments before reading the verb
    const _q = query.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')

    if (/^select\b/i.test(_q) === false) {
      return false
    }

    const _lower = _q.toLowerCase()

    if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(_lower)) {
      return false
    }

    return /\binto\b/.test(_lower) === false
  },

  /**
   * Run a query, retrying it once on a connection-level error. A failed
   * connect() means the query never ran, so any query is safe to retry; a
   * connection lost mid-query is only retried for an idempotent read.
   * @param {String} query Query
   * @param {Array} params Params
   * @param {Function} callback
   * @param {Boolean} retried Whether this is already the retry
   */
  _queryOnce: function (query, params, callback, retried) {
    if (this._pool === null) {
      return callback(new Error('Pool is not connected'))
    }

    this._pool.connect((err, client, done) => {
      if (err) {
        // connect() failed, so the query never reached a backend: safe to retry
        // once whatever the query was
        if (retried === false && this._isConnectionError(err)) {
          logger.log(`Database connection error (${err.code || err.message}), retrying once`, 'warn')
          return this._queryOnce(query, params, callback, true)
        }

        return callback(err)
      }

      client.query(query, params, (err, res) => {
        const _connectionError = this._isConnectionError(err)

        // Destroy a broken client instead of returning it to the pool; a normal
        // query error leaves the connection healthy, so it goes back untouched
        done(_connectionError ? err : undefined)

        // Connection lost mid-query: retry once, but only a read — replaying a
        // write could double-apply it
        if (_connectionError === true && retried === false && this._isIdempotentRead(query)) {
          logger.log(`Database connection lost mid-query (${err.code || err.message}), retrying the read`, 'warn')
          return this._queryOnce(query, params, callback, true)
        }

        // Check query return rows else return an empty array
        let rows = []
        if (res !== undefined && res.rows !== undefined) {
          rows = res.rows
        }
        return callback(err, res, rows)
      })
    })
  },

  /**
   * Inline the parameters into a query, to print it while debugging
   * @param {String} query Query with $1, $2 placeholders
   * @param {Array} params Query parameters
   */
  prepareRequestToPrint: function (query, params) {
    let tmpQuery = query

    for (let i = 0; i < params.length; i++) {
      if (typeof params[i] === 'string') {
        tmpQuery = tmpQuery.replace(`$${i + 1}`, `'${params[i]}'`)
      } else {
        tmpQuery = tmpQuery.replace(`$${i + 1}`, params[i])
      }
    }

    const newLines = []
    const lines = tmpQuery.split('\n')

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) {
        newLines.push(lines[i])
      }
    }

    return newLines.join('\n')
  }
}

module.exports = database
