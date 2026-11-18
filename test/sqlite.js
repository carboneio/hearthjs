const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite')
const app = require('../lib/')
const db = require('../lib/database')
const datasets = require('../lib/datasets')
const migration = require('../lib/migration')
const logger = require('../lib/logger')
const hearthTest = require('../lib/test')
const suppose = require('./helpers/suppose')

const pgConf = { user: 'postgres', host: 'localhost', database: 'hearth_test', password: 'password', port: 5432 }

// Spread a row: node:sqlite rows have a null prototype
const plain = (rows) => rows.map(row => ({ ...row }))
// A new database, opened
const open = (conf) => {
  const _db = db.create()
  return new Promise((resolve, reject) => _db.init(conf, (err) => err ? reject(err) : resolve(_db)))
}
const close = (database) => new Promise(resolve => database.close(resolve))

/**
 * The bytes of a backup like carbone's: a WAL database copied with the online
 * backup API, the one better-sqlite3's db.backup() uses
 * @param {String} dir Directory for the source database and its copy
 * @param {String} name
 * @return {Promise<Buffer>}
 */
const makeWalBackup = async (dir, name) => {
  const _source = new DatabaseSync(path.join(dir, `${name}.source.db`))
  _source.exec('PRAGMA journal_mode = WAL;')
  _source.exec('CREATE TABLE "templates" ("id" TEXT PRIMARY KEY, "name" TEXT, "size" INTEGER);')
  _source.exec('CREATE TABLE "templates_patches" ("id" INTEGER PRIMARY KEY, "templateId" TEXT REFERENCES "templates" ("id"), "patch" TEXT);')
  _source.exec('INSERT INTO "templates" VALUES (\'t1\', \'Invoice\', 10), (\'t2\', \'Quote\', 20);')
  _source.exec('INSERT INTO "templates_patches" ("templateId", "patch") VALUES (\'t1\', \'{}\');')
  await sqliteBackup(_source, path.join(dir, `${name}.backup`))
  _source.close()
  return fs.readFileSync(path.join(dir, `${name}.backup`))
}

describe('SQLite', function () {
  this.timeout(20000)
  let tmpDir = null

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearthjs-sqlite-'))
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('Init', () => {
    let lite = null

    beforeEach(() => {
      lite = db.create()
    })

    afterEach((done) => {
      lite.close(done)
    })

    it('should open an in-memory database', (done) => {
      lite.init({ client: 'sqlite', filename: ':memory:' }, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(lite.dialect.migrationTable, '"hearthjs_migration"')
        lite.query('SELECT 1 AS "one";', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.deepStrictEqual(plain(rows), [{ one: 1 }])
          done()
        })
      })
    })

    it('should open a file with WAL, foreign keys and a busy timeout from the timeout', (done) => {
      const _file = path.join(tmpDir, 'init.db')

      lite.init({ client: 'sqlite', filename: _file, timeout: 1234 }, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(fs.existsSync(_file), true)
        const _pragma = (name) => Object.values(lite.sqlite.db.prepare(`PRAGMA ${name}`).get())[0]
        assert.strictEqual(_pragma('journal_mode'), 'wal')
        assert.strictEqual(_pragma('foreign_keys'), 1)
        assert.strictEqual(_pragma('busy_timeout'), 1234)
        done()
      })
    })

    it('should default the busy timeout to 10s', (done) => {
      lite.init({ client: 'sqlite', filename: ':memory:' }, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(lite.sqlite.db.prepare('PRAGMA busy_timeout').get().timeout, 10000)
        done()
      })
    })

    it('should fail closed on an unknown client', (done) => {
      lite.init({ client: 'mysql', filename: ':memory:' }, (err) => {
        assert.match(err.message, /Unknown database client "mysql"/)
        assert.strictEqual(lite.sqlite, null)
        assert.strictEqual(lite._pool, null)
        lite.query('SELECT 1;', (err) => {
          assert.notStrictEqual(err, null)
          done()
        })
      })
    })

    it('should not read a client from the prototype chain', (done) => {
      lite.init({ client: 'toString' }, (err) => {
        assert.match(err.message, /Unknown database client/)
        done()
      })
    })

    it('should fail without a filename', (done) => {
      lite.init({ client: 'sqlite' }, (err) => {
        assert.match(err.message, /needs either a filename or a buffer/)
        done()
      })
    })

    it('should not answer once closed', (done) => {
      lite.init({ client: 'sqlite', filename: ':memory:' }, (err) => {
        assert.strictEqual(err, null)
        lite.close(() => {
          assert.strictEqual(lite.sqlite, null)
          lite.query('SELECT 1;', (err) => {
            assert.notStrictEqual(err, null)
            done()
          })
        })
      })
    })
  })

  describe('Query', () => {
    const lite = db.create()

    before((done) => {
      lite.init({ client: 'sqlite', filename: ':memory:' }, (err) => {
        assert.strictEqual(err, null)
        lite.query('CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "label" TEXT, "value");', done)
      })
    })

    beforeEach((done) => {
      lite.query('DELETE FROM "item";', done)
    })

    after((done) => {
      lite.close(done)
    })

    it('should answer with a callback, asynchronously', (done) => {
      let _returned = false

      lite.query('INSERT INTO "item" ("label") VALUES ($1);', ['a'], (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(_returned, true)
        assert.strictEqual(res.rowCount, 1)
        assert.deepStrictEqual(rows, [])
        done()
      })
      _returned = true
    })

    it('should answer with a promise', async () => {
      await lite.query('INSERT INTO "item" ("label") VALUES ($1), ($2);', ['a', 'b'])
      const { result, rows } = await lite.query('SELECT "label" FROM "item" ORDER BY "label";')
      assert.strictEqual(result.rowCount, 2)
      assert.deepStrictEqual(result.rows, rows)
      assert.deepStrictEqual(plain(rows), [{ label: 'a' }, { label: 'b' }])
    })

    it('should bind $N by number, repeated and out of order, not inside a string', async () => {
      const { rows } = await lite.query('SELECT $2 AS "b", $1 AS "a", $1 AS "a2", \'$1\' AS "literal";', ['x', 'y'])
      assert.deepStrictEqual(plain(rows), [{ b: 'y', a: 'x', a2: 'x', literal: '$1' }])
    })

    it('should normalise the types node:sqlite rejects', async () => {
      const _date = new Date('2026-01-02T03:04:05.006Z')
      const { rows } = await lite.query(
        'SELECT $1 AS "t", $2 AS "f", $3 AS "u", $4 AS "n", $5 AS "d", $6 AS "o", $7 AS "a", $8 AS "b", $9 AS "big", $10 AS "num";',
        [true, false, undefined, null, _date, { k: 'v' }, [1, 'x'], Buffer.from('hi'), 2n ** 40n, 1.5]
      )
      assert.deepStrictEqual({ ...rows[0], b: Buffer.from(rows[0].b) }, {
        t: 1, f: 0, u: null, n: null, d: '2026-01-02T03:04:05.006Z', o: '{"k":"v"}', a: '[1,"x"]', b: Buffer.from('hi'), big: 2 ** 40, num: 1.5
      })
    })

    it('should keep a SQL injection in a parameter inert', async () => {
      const _attack = '\'); DROP TABLE "item"; --'
      await lite.query('INSERT INTO "item" ("label") VALUES ($1);', [_attack])
      const { rows } = await lite.query('SELECT "label" FROM "item" WHERE "label" = $1;', [_attack])
      assert.deepStrictEqual(plain(rows), [{ label: _attack }])

      const { rows: _none } = await lite.query('SELECT * FROM "item" WHERE "id" = $1;', ['1 OR 1=1'])
      assert.deepStrictEqual(_none, [])
    })

    it('should refuse several statements with parameters, instead of running only the first', async () => {
      await assert.rejects(lite.query('INSERT INTO "item" ("label") VALUES ($1); DELETE FROM "item";', ['a']), /multiple commands/)
      const { rows } = await lite.query('SELECT * FROM "item";')
      assert.deepStrictEqual(rows, [])
    })

    it('should run a whole script without parameters', async () => {
      await lite.query('INSERT INTO "item" ("label") VALUES (\'a\');\n-- comment\nINSERT INTO "item" ("label") VALUES (\'b\');\n')
      const { rows } = await lite.query('SELECT COUNT(*) AS "nb" FROM "item";  -- trailing comment\n')
      assert.strictEqual(rows[0].nb, 2)
    })

    it('should run a script all or nothing, like Postgres', async () => {
      await assert.rejects(lite.query('INSERT INTO "item" ("label") VALUES (\'a\'); INSERT INTO "nope" VALUES (1);'), /no such table/)
      assert.strictEqual(lite.sqlite.db.isTransaction, false)
      assert.deepStrictEqual((await lite.query('SELECT * FROM "item";')).rows, [])
    })

    it('should refuse a script that begins its own transaction, leaving none open', async () => {
      await assert.rejects(lite.query('BEGIN; INSERT INTO "item" ("label") VALUES (\'a\'); COMMIT;'), /cannot start a transaction within a transaction/)
      assert.strictEqual(lite.sqlite.db.isTransaction, false)
      assert.deepStrictEqual((await lite.query('SELECT * FROM "item";')).rows, [])
    })

    it('should undo only a failing script inside the caller\'s transaction', async () => {
      await lite.query('BEGIN;')
      await lite.query('INSERT INTO "item" ("label") VALUES ($1);', ['kept'])
      await assert.rejects(lite.query('INSERT INTO "item" ("label") VALUES (\'undone\'); INSERT INTO "nope" VALUES (1);'), /no such table/)
      assert.strictEqual(lite.sqlite.db.isTransaction, true)
      await lite.query('INSERT INTO "item" ("label") VALUES (\'a\'); INSERT INTO "item" ("label") VALUES (\'b\');')
      await lite.query('COMMIT;')
      assert.deepStrictEqual(plain((await lite.query('SELECT "label" FROM "item" ORDER BY "id";')).rows), [{ label: 'kept' }, { label: 'a' }, { label: 'b' }])
    })

    it('should report a script that ends the transaction itself, with what it committed kept', async () => {
      await assert.rejects(lite.query('INSERT INTO "item" ("label") VALUES (\'a\'); COMMIT; INSERT INTO "nope" VALUES (1);'), /no such table/)
      assert.strictEqual(lite.sqlite.db.isTransaction, false)
      assert.strictEqual((await lite.query('SELECT COUNT(*) AS "nb" FROM "item";')).rows[0].nb, 1)
    })

    it('should read a query ending in an unterminated comment as one statement', async () => {
      const { rows } = await lite.query('SELECT $1 AS "a" /* unterminated', [1])
      assert.deepStrictEqual(plain(rows), [{ a: 1 }])
    })

    it('should surface an error as an error, with a callback and a promise', (done) => {
      lite.query('SELEC 1;', (err, res, rows) => {
        assert.match(err.message, /syntax error/)
        assert.strictEqual(res, undefined)
        assert.deepStrictEqual(rows, [])
        lite.query('SELECT * FROM "nope";').then(() => done(new Error('should reject')), (err) => {
          assert.match(err.message, /no such table/)
          done()
        })
      })
    })

    it('should not call back twice when the callback throws', (done) => {
      const _listeners = process.listeners('uncaughtException')
      let _calls = 0

      process.removeAllListeners('uncaughtException')
      process.once('uncaughtException', (err) => {
        _listeners.forEach(listener => process.on('uncaughtException', listener))
        assert.strictEqual(err.message, 'from callback')
        assert.strictEqual(_calls, 1)
        done()
      })

      lite.query('SELECT 1;', () => {
        _calls++
        throw new Error('from callback')
      })
    })

    it('should count changed rows and return RETURNING rows', async () => {
      const { result } = await lite.query('INSERT INTO "item" ("label") VALUES (\'a\'), (\'b\'), (\'c\');')
      assert.strictEqual(result.rowCount, 3)
      const { result: _update } = await lite.query('UPDATE "item" SET "value" = 1 WHERE "label" <> $1;', ['a'])
      assert.strictEqual(_update.rowCount, 2)
      const { rows } = await lite.query('DELETE FROM "item" WHERE "label" = $1 RETURNING "label";', ['a'])
      assert.deepStrictEqual(plain(rows), [{ label: 'a' }])
    })

    it('should provide NOW()', async () => {
      const { rows } = await lite.query('SELECT NOW() AS "now";')
      assert.ok(Math.abs(Date.parse(rows[0].now) - Date.now()) < 5000)
    })

    it('should refuse SQL that would corrupt the database file (defensive mode)', async () => {
      await lite.query('PRAGMA writable_schema = ON;')
      await assert.rejects(lite.query('UPDATE sqlite_master SET "sql" = $1;', ['garbage']))
      const { rows } = await lite.query('SELECT count(*) AS "n" FROM "item";')
      assert.strictEqual(typeof rows[0].n, 'number')
    })

    it('should keep answering once the statement cache evicts and closes old statements', async () => {
      for (let i = 0; i < 210; i++) {
        await lite.query(`SELECT ${i} AS "n";`)
      }
      const { rows } = await lite.query('SELECT 0 AS "n";')
      assert.strictEqual(rows[0].n, 0)
    })

    it('should commit and roll back a transaction', async () => {
      await lite.query('BEGIN;')
      await lite.query('INSERT INTO "item" ("label") VALUES ($1);', ['rolled back'])
      await lite.query('ROLLBACK;')
      await lite.query('BEGIN;')
      await lite.query('INSERT INTO "item" ("label") VALUES ($1);', ['committed'])
      await lite.query('COMMIT;')
      const { rows } = await lite.query('SELECT "label" FROM "item";')
      assert.deepStrictEqual(plain(rows), [{ label: 'committed' }])
    })
  })

  describe('Exec', () => {
    const lite = db.create()

    before((done) => {
      fs.writeFileSync(path.join(tmpDir, 'getUser.sql'), 'SELECT "id", "name" FROM "user" {# data.id #} WHERE "id" = {{ data.id }} {{#}} ORDER BY "id";')
      lite.init({ client: 'sqlite', filename: ':memory:' }, (err) => {
        assert.strictEqual(err, null)
        lite.registerSQLFile(path.join(tmpDir, 'getUser.sql'))
        lite.query('CREATE TABLE "user" ("id" INTEGER PRIMARY KEY, "name" TEXT); INSERT INTO "user" VALUES (1, \'Ann\'), (2, \'Bob\');', done)
      })
    })

    after((done) => {
      lite.close(done)
    })

    it('should exec a registered file, with a callback and a promise', (done) => {
      lite.exec('getUser', { id: 2 }, (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(plain(rows), [{ id: 2, name: 'Bob' }])
        lite.exec('getUser', {}).then(({ result, object }) => {
          assert.strictEqual(result.rowCount, 2)
          assert.strictEqual(object.length, 2)
          done()
        }, done)
      })
    })

    it('should convert rows with a model', async () => {
      const { object } = await lite.exec('getUser', {}, [{ id: ['<<id>>'], name: ['<name>'] }])
      assert.deepStrictEqual(object, [{ id: 1, name: 'Ann' }, { id: 2, name: 'Bob' }])
    })

    it('should keep its own SQL files, apart from the main database', () => {
      assert.notStrictEqual(lite._sqlFiles.getUser, undefined)
      assert.strictEqual(db._sqlFiles.getUser, undefined)
    })
  })

  describe('Migration', () => {
    const migrationDir = () => path.join(tmpDir, 'server', 'migration')
    const write = (name, content) => fs.writeFileSync(path.join(migrationDir(), name), content)
    const step = (fn, ...args) => new Promise((resolve, reject) => migration[fn](...args, (err, res) => err ? reject(err) : resolve(res)))
    let lite = null

    // What the migration CLI does, without its prompts
    const migrate = async (version) => {
      Object.assign(migration, { _state: [], _toExecute: [], _toAdd: [], _toDelete: [] })
      await step('analyze')
      const _toExecute = await step('getExecuteOrder', version)
      await step('beginTransaction')
      await step('executeAllState', () => {})
      await step('updateMigrationTable')
      await step('commitTransaction')
      return (_toExecute ?? []).map(state => state.filename)
    }

    before(async () => {
      fs.mkdirSync(migrationDir(), { recursive: true })
      write('1_up.sql', '/* Create item */\nCREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "label" TEXT);\nINSERT INTO "item" ("label") VALUES (\'first\');\n')
      write('1_down.sql', '/* Create item */\nDROP TABLE "item";\n')
      lite = await open({ client: 'sqlite', filename: path.join(tmpDir, 'migration.db') })
      await step('init', path.join(tmpDir, 'server'), lite)
    })

    after(async () => {
      Object.assign(migration, { _state: [], _toExecute: [], _toAdd: [], _toDelete: [] })
      await close(lite)
    })

    it('should create the migration table', async () => {
      const { rows } = await lite.query('SELECT "name" FROM sqlite_schema WHERE "name" = \'hearthjs_migration\';')
      assert.strictEqual(rows.length, 1)
    })

    it('should apply and record a migration in a transaction', async () => {
      assert.deepStrictEqual(await migrate(), ['1_up.sql'])
      const { rows } = await lite.query('SELECT "filename", "dateApplied" FROM "hearthjs_migration";')
      assert.strictEqual(rows[0].filename, '1')
      assert.ok(Date.parse(rows[0].dateApplied) > 0)
      const { rows: _items } = await lite.query('SELECT "label" FROM "item";')
      assert.deepStrictEqual(plain(_items), [{ label: 'first' }])
    })

    it('should see the migration as applied, without conflict', async () => {
      Object.assign(migration, { _state: [] })
      await step('analyze')
      assert.deepStrictEqual(migration._state, [{ filenameId: '1', description: 'Create item', new: false, conflict: false, conflictType: null }])
    })

    it('should up a new migration, then down it with the script stored in the database', async () => {
      write('2_up.sql', '/* Add value */\nALTER TABLE "item" ADD COLUMN "value" INTEGER;\n')
      write('2_down.sql', '/* Add value */\nALTER TABLE "item" DROP COLUMN "value";\n')
      assert.deepStrictEqual(await migrate(), ['2_up.sql'])
      assert.strictEqual((await lite.query('SELECT COUNT(*) AS "nb" FROM pragma_table_info(\'item\') WHERE "name" = \'value\';')).rows[0].nb, 1)

      assert.deepStrictEqual(await migrate('1'), ['2_down.sql'])
      assert.strictEqual((await lite.query('SELECT COUNT(*) AS "nb" FROM pragma_table_info(\'item\') WHERE "name" = \'value\';')).rows[0].nb, 0)
      const { rows } = await lite.query('SELECT "filename" FROM "hearthjs_migration";')
      assert.deepStrictEqual(plain(rows), [{ filename: '1' }])
    })

    it('should roll back a migration that fails, leaving no transaction open', async () => {
      write('3_up.sql', '/* Broken */\nCREATE TABLE "broken" ("id" INTEGER);\nINSERT INTO "nope" VALUES (1);\n')
      write('3_down.sql', '/* Broken */\nDROP TABLE "broken";\n')
      Object.assign(migration, { _state: [], _toExecute: [], _toAdd: [], _toDelete: [] })
      await step('analyze')
      await step('getExecuteOrder', undefined)
      await step('beginTransaction')
      await assert.rejects(step('executeAllState', () => {}), /no such table: nope/)
      await step('rollbackTransaction')
      assert.strictEqual(lite.sqlite.db.isTransaction, false)
      const { rows } = await lite.query('SELECT "name" FROM sqlite_schema WHERE "name" = \'broken\';')
      assert.deepStrictEqual(rows, [])
    })
  })

  describe('Read-only backup file', () => {
    const backupPath = () => path.join(tmpDir, '.metadata.db.0.backup')
    let original = null

    // A WAL database renamed to .backup, like the ones carbone makes with db.backup()
    before(async () => {
      const _source = path.join(tmpDir, 'source.db')
      const _writer = await open({ client: 'sqlite', filename: _source })
      await _writer.query('CREATE TABLE "templates" ("id" TEXT PRIMARY KEY, "name" TEXT, "size" INTEGER); CREATE TABLE "templates_patches" ("id" INTEGER PRIMARY KEY, "templateId" TEXT, "patch" TEXT);')
      await _writer.query('INSERT INTO "templates" VALUES ($1, $2, $3), ($4, $5, $6);', ['t1', 'Invoice', 10, 't2', 'Quote', 20])
      await _writer.query('INSERT INTO "templates_patches" ("templateId", "patch") VALUES ($1, $2);', ['t1', '{}'])
      await close(_writer)
      fs.renameSync(_source, backupPath())
      original = { bytes: fs.readFileSync(backupPath()), mtimeMs: fs.statSync(backupPath()).mtimeMs }
    })

    it('should read a backup file, refuse writes and leave the file untouched', async () => {
      const backup = await open({ client: 'sqlite', filename: backupPath(), readOnly: true })
      const { rows } = await backup.query('SELECT "id", "name" FROM "templates" ORDER BY "id";')
      assert.deepStrictEqual(plain(rows), [{ id: 't1', name: 'Invoice' }, { id: 't2', name: 'Quote' }])

      // A large table: iterate on the raw handle, one row in memory at a time
      let _nb = 0
      for (const _row of backup.sqlite.db.prepare('SELECT * FROM "templates_patches"').iterate()) {
        assert.strictEqual(_row.templateId, 't1')
        _nb++
      }
      assert.strictEqual(_nb, 1)

      await assert.rejects(backup.query('DELETE FROM "templates";'), /not authorized/)
      await assert.rejects(backup.query('CREATE TABLE "x" ("a");'), /not authorized/)
      // The immutable flag alone let VACUUM INTO write a whole copy elsewhere
      const _copy = path.join(tmpDir, 'vacuum-copy.db')
      await assert.rejects(backup.query(`VACUUM INTO '${_copy}';`), /authorization denied/)
      assert.strictEqual(fs.existsSync(_copy), false)
      await close(backup)

      assert.deepStrictEqual(fs.readFileSync(backupPath()), original.bytes)
      assert.strictEqual(fs.statSync(backupPath()).mtimeMs, original.mtimeMs)
      assert.deepStrictEqual(fs.readdirSync(tmpDir).filter(file => file.startsWith('.metadata')), ['.metadata.db.0.backup'])
    })

    it('should fail on a missing file without creating it', async () => {
      const _missing = path.join(tmpDir, 'missing.backup')
      await assert.rejects(open({ client: 'sqlite', filename: _missing, readOnly: true }), /Cannot open the sqlite database .*missing\.backup: unable to open database file/)
      assert.strictEqual(fs.existsSync(_missing), false)
    })

    it('should open several files at once, each closing on its own', async () => {
      const _first = await open({ client: 'sqlite', filename: backupPath(), readOnly: true })
      const _second = await open({ client: 'sqlite', filename: backupPath(), readOnly: true })
      const _third = await open({ client: 'sqlite', filename: ':memory:' })
      await close(_first)
      await assert.rejects(_first.query('SELECT 1;'))
      assert.strictEqual((await _second.query('SELECT COUNT(*) AS "nb" FROM "templates";')).rows[0].nb, 2)
      assert.strictEqual((await _third.query('SELECT 3 AS "nb";')).rows[0].nb, 3)
      await close(_second)
      await close(_third)
    })
  })

  // A backup downloaded in memory (from S3), never written to disk
  describe('Backup in a buffer', () => {
    let walBackup = null

    // Built like carbone's: a WAL database copied with the online backup API
    // (better-sqlite3's db.backup() and node:sqlite's backup() both use it)
    before(async () => {
      walBackup = await makeWalBackup(tmpDir, 'buffer')
    })

    it('should keep the WAL flag in a backup, which SQLite cannot load in memory as is', () => {
      assert.deepStrictEqual([walBackup[18], walBackup[19]], [2, 2])
      const _raw = new DatabaseSync(':memory:')
      _raw.deserialize(walBackup)
      assert.throws(() => _raw.prepare('SELECT COUNT(*) FROM "templates";').get(), /unable to open database file/)
      _raw.close()
    })

    it('should open a WAL backup from a buffer, read-only, and leave the buffer untouched', async () => {
      const _before = Buffer.from(walBackup)
      const backup = await open({ client: 'sqlite', buffer: walBackup, readOnly: true })
      const { rows } = await backup.query('SELECT "id", "name", "size" FROM "templates" ORDER BY "id";')
      assert.deepStrictEqual(plain(rows), [{ id: 't1', name: 'Invoice', size: 10 }, { id: 't2', name: 'Quote', size: 20 }])
      await assert.rejects(backup.query('DELETE FROM "templates";'), /not authorized/)
      await close(backup)
      assert.deepStrictEqual(walBackup, _before)
    })

    it('should open a rollback-journal image and a plain Uint8Array', async () => {
      const _source = new DatabaseSync(':memory:')
      _source.exec('CREATE TABLE "t" ("a"); INSERT INTO "t" VALUES (1), (2);')
      const _image = _source.serialize()
      _source.close()
      assert.strictEqual(_image instanceof Buffer, false)

      const backup = await open({ client: 'sqlite', buffer: _image, readOnly: true })
      assert.strictEqual((await backup.query('SELECT COUNT(*) AS "nb" FROM "t";')).rows[0].nb, 2)
      await close(backup)
    })

    it('should write only to its own in-memory copy when not read-only', async () => {
      const _before = Buffer.from(walBackup)
      const _copy = await open({ client: 'sqlite', buffer: walBackup })
      await _copy.query('DELETE FROM "templates_patches"; DELETE FROM "templates";')
      assert.strictEqual((await _copy.query('SELECT COUNT(*) AS "nb" FROM "templates";')).rows[0].nb, 0)
      await close(_copy)
      assert.deepStrictEqual(walBackup, _before)

      const _again = await open({ client: 'sqlite', buffer: walBackup, readOnly: true })
      assert.strictEqual((await _again.query('SELECT COUNT(*) AS "nb" FROM "templates";')).rows[0].nb, 2)
      await close(_again)
    })

    it('should exec registered SQL files with a model on a buffer', async () => {
      fs.writeFileSync(path.join(tmpDir, 'bufferTemplates.sql'), 'SELECT "id", "name" FROM "templates" {# data.id #} WHERE "id" = {{ data.id }} {{#}} ORDER BY "id";')
      const backup = await open({ client: 'sqlite', buffer: walBackup, readOnly: true })
      backup.registerSQLFile(path.join(tmpDir, 'bufferTemplates.sql'))
      const { object } = await backup.exec('bufferTemplates', { id: 't2' }, [{ id: ['<<id>>'], name: ['<name>'] }])
      assert.deepStrictEqual(object, [{ id: 't2', name: 'Quote' }])
      await close(backup)
    })

    it('should keep the parsed SQL files of another database when one closes', async () => {
      const mustache = require('../lib/mustache')
      const _kept = path.join(tmpDir, 'keptFile.sql')
      const _dropped = path.join(tmpDir, 'droppedFile.sql')
      fs.writeFileSync(_kept, 'SELECT 1 AS "a";')
      fs.writeFileSync(_dropped, 'SELECT 2 AS "a";')
      const _first = await open({ client: 'sqlite', buffer: walBackup, readOnly: true })
      const _second = await open({ client: 'sqlite', buffer: walBackup, readOnly: true })
      _first.registerSQLFile(_kept)
      _second.registerSQLFile(_dropped)
      await _first.exec('keptFile')
      await _second.exec('droppedFile')
      await close(_second)
      assert.strictEqual(mustache._fileCache.has(_kept), true)
      assert.strictEqual(mustache._fileCache.has(_dropped), false)
      await close(_first)
      assert.strictEqual(mustache._fileCache.has(_kept), false)
    })

    it('should open several buffers at once, each closing on its own', async () => {
      const _first = await open({ client: 'sqlite', buffer: walBackup, readOnly: true })
      const _second = await open({ client: 'sqlite', buffer: walBackup })
      await close(_first)
      await assert.rejects(_first.query('SELECT 1;'), /not connected/)
      assert.strictEqual((await _second.query('SELECT COUNT(*) AS "nb" FROM "templates";')).rows[0].nb, 2)
      await close(_second)
    })

    it('should fail at open, not at the first query, on bytes that are not a database', async () => {
      const _cases = [
        [Buffer.from('not a database, just some text'.repeat(40)), /Cannot open the sqlite database from a buffer: file is not a database/],
        [walBackup.subarray(0, 100), /Cannot open the sqlite database from a buffer: database disk image is malformed/],
        [walBackup.subarray(0, Math.floor(walBackup.length / 2)), /Cannot open the sqlite database from a buffer: database disk image is malformed/],
        [Buffer.alloc(4096), /Cannot open the sqlite database from a buffer/]
      ]

      for (const [_bytes, _expected] of _cases) {
        const lite = db.create()
        await assert.rejects(lite.init({ client: 'sqlite', buffer: _bytes, readOnly: true }), _expected)
        assert.strictEqual(lite.sqlite, null)
        assert.strictEqual(lite.dialect, db.DIALECTS.postgresql)
      }
      // The WAL flag flipped for deserialize() is restored, even on a failure
      assert.deepStrictEqual([walBackup[18], walBackup[19]], [2, 2])
    })
  })

  // A backup comes from outside: whatever it holds, it must not hang, exhaust
  // the memory of, or silently mislead the process reading it
  describe('Hostile backup', () => {
    const image = (sql) => {
      const _source = new DatabaseSync(':memory:')
      _source.exec(sql)
      const _bytes = _source.serialize()
      _source.close()
      return _bytes
    }
    const both = async (bytes, test) => {
      const _file = path.join(tmpDir, `hostile-${Date.now()}-${Math.random()}.db`)
      fs.writeFileSync(_file, bytes)
      for (const _conf of [{ buffer: bytes }, { filename: _file }]) {
        const backup = await open({ client: 'sqlite', readOnly: true, ..._conf })
        try {
          await test(backup)
        } finally {
          await close(backup)
        }
      }
    }

    it('should refuse to run a view of the file, that could block the event loop forever', async () => {
      const _bytes = image('CREATE TABLE "t" ("a"); INSERT INTO "t" VALUES (1); ' +
        'CREATE VIEW "templates" AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x AS "id" FROM c WHERE x < 0; ' +
        'CREATE VIEW "plain" AS SELECT "a" FROM "t";')
      await both(_bytes, async (backup) => {
        const _start = Date.now()
        await assert.rejects(backup.query('SELECT "id" FROM "templates";'), /not authorized/)
        await assert.rejects(backup.query('SELECT "a" FROM "plain";'), /not authorized|prohibited/)
        await assert.rejects(backup.query('WITH "q" AS (SELECT "a" FROM "plain") SELECT * FROM "q";'), /not authorized|prohibited/)
        assert.ok(Date.now() - _start < 1000)
        // Its tables, and the query's own CTEs, still read
        assert.strictEqual((await backup.query('SELECT "a" FROM "t";')).rows[0].a, 1)
        assert.strictEqual((await backup.query('WITH RECURSIVE "c"(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM "c" WHERE x < 3) SELECT COUNT(*) AS "nb" FROM "c";')).rows[0].nb, 3)
        // Fail closed: a CTE named like a view of the file is denied too
        await assert.rejects(backup.query('WITH "plain"(x) AS (SELECT 1) SELECT x FROM "plain";'), /not authorized/)
      })
    })

    it('should refuse a value far larger than the file, that a generated column could build', async () => {
      const _bytes = image('CREATE TABLE "templates" ("id" INTEGER PRIMARY KEY, "name" TEXT GENERATED ALWAYS AS (printf(\'%.*c\', 400000000, \'x\')) VIRTUAL); INSERT INTO "templates" ("id") VALUES (1), (2);')
      await both(_bytes, async (backup) => {
        await assert.rejects(backup.query('SELECT "name" FROM "templates";'), /string or blob too big/)
        assert.deepStrictEqual(plain((await backup.query('SELECT "id" FROM "templates";')).rows), [{ id: 1 }, { id: 2 }])
        // A value built from the whole file still fits
        assert.ok((await backup.query('SELECT json_group_array(hex(zeroblob(1000))) AS "j" FROM "templates";')).rows[0].j.length > 1000)
      })
    })

    it('should keep the default value limit on a database it may write', async () => {
      const _lite = await open({ client: 'sqlite', filename: ':memory:' })
      assert.strictEqual(_lite.sqlite.db.limits.length, 1000000000)
      await close(_lite)
    })

    it('should refuse a file with a live -wal beside it, whose commits it would miss', async () => {
      const _file = path.join(tmpDir, 'live.db')
      const _writer = new DatabaseSync(_file)
      _writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE "t" ("a"); INSERT INTO "t" VALUES (1);')
      await assert.rejects(open({ client: 'sqlite', filename: _file, readOnly: true }), /a -wal file is beside it/)
      _writer.close()
      // Closed, its -wal is checkpointed and removed
      const backup = await open({ client: 'sqlite', filename: _file, readOnly: true })
      assert.strictEqual((await backup.query('SELECT COUNT(*) AS "nb" FROM "t";')).rows[0].nb, 1)
      await close(backup)
      fs.writeFileSync(`${_file}-wal`, '')
      const _empty = await open({ client: 'sqlite', filename: _file, readOnly: true })
      await close(_empty)
    })

    it('should search a full-text (FTS5) table, read-only', async () => {
      const _bytes = image('CREATE VIRTUAL TABLE "docs" USING fts5("body"); INSERT INTO "docs" VALUES (\'hello world\'), (\'other\');')
      await both(_bytes, async (backup) => {
        assert.deepStrictEqual(plain((await backup.query('SELECT "body" FROM "docs" WHERE "docs" MATCH $1;', ['hello'])).rows), [{ body: 'hello world' }])
        await assert.rejects(backup.query('INSERT INTO "docs" VALUES (\'x\');'), /not authorized/)
      })
    })

    it('should run a read-only script and an empty query, and deny a script that writes', async () => {
      await both(image('CREATE TABLE "t" ("a"); INSERT INTO "t" VALUES (1);'), async (backup) => {
        assert.deepStrictEqual((await backup.query('SELECT 1; SELECT "a" FROM "t";')).rows, [])
        assert.deepStrictEqual((await backup.query('-- nothing')).rows, [])
        await assert.rejects(backup.query('SELECT 1; DELETE FROM "t";'), /not authorized/)
        assert.strictEqual((await backup.query('SELECT COUNT(*) AS "nb" FROM "t";')).rows[0].nb, 1)
      })
    })
  })

  describe('Read-only allow-list', () => {
    const sources = {}
    const statements = {
      allowed: [
        'SELECT "id", "name" FROM "templates" WHERE "size" > 1 ORDER BY "id";',
        'SELECT t."id", COUNT(p."id") AS "nb", upper(t."name") AS "u" FROM "templates" t LEFT JOIN "templates_patches" p ON p."templateId" = t."id" GROUP BY t."id";',
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT COUNT(*) AS "nb" FROM c;',
        'SELECT "id" FROM "templates" UNION SELECT "templateId" FROM "templates_patches";',
        'SELECT "id", row_number() OVER (ORDER BY "id") AS "n" FROM "templates";',
        'SELECT json_object(\'id\', "id") AS "j" FROM "templates";',
        'SELECT NOW() AS "now";',
        'SELECT COUNT(*) AS "nb" FROM sqlite_master;',
        'SELECT "name" FROM pragma_table_info(\'templates\');',
        'PRAGMA table_info("templates");',
        'PRAGMA TABLE_XINFO("templates");',
        'PRAGMA index_list("templates");',
        'PRAGMA foreign_key_list("templates_patches");'
      ],
      denied: [
        'INSERT INTO "templates" VALUES (\'t3\', \'x\', 1);',
        'UPDATE "templates" SET "name" = \'x\';',
        'DELETE FROM "templates";',
        'REPLACE INTO "templates" VALUES (\'t1\', \'x\', 1);',
        'CREATE TABLE "x" ("a");',
        'CREATE TEMP TABLE "x" ("a");',
        'CREATE INDEX "i" ON "templates" ("name");',
        'CREATE VIEW "v" AS SELECT 1;',
        'DROP TABLE "templates";',
        'ALTER TABLE "templates" ADD COLUMN "b";',
        'PRAGMA writable_schema = ON;',
        'PRAGMA query_only = OFF;',
        'PRAGMA journal_mode = DELETE;',
        'PRAGMA user_version = 3;',
        'PRAGMA user_version;',
        'ATTACH DATABASE \':memory:\' AS "other";',
        'DETACH DATABASE "main";',
        'BEGIN;',
        'SAVEPOINT "s";',
        'VACUUM;',
        'ANALYZE;',
        'REINDEX;',
        'SELECT load_extension(\'x\');'
      ]
    }

    before(async () => {
      const _bytes = await makeWalBackup(tmpDir, 'allowList')
      const _file = path.join(tmpDir, 'allowList.backup')
      fs.writeFileSync(_file, _bytes)
      sources.file = await open({ client: 'sqlite', filename: _file, readOnly: true })
      sources.buffer = await open({ client: 'sqlite', buffer: _bytes, readOnly: true })
    })

    after(async () => {
      await close(sources.file)
      await close(sources.buffer)
    })

    for (const _source of ['file', 'buffer']) {
      for (const _sql of statements.allowed) {
        it(`should allow on a ${_source}: ${_sql}`, async () => {
          const { rows } = await sources[_source].query(_sql)
          assert.ok(rows.length > 0 || _sql.startsWith('PRAGMA foreign_key_list'))
        })
      }

      for (const _sql of statements.denied) {
        it(`should deny on a ${_source}: ${_sql}`, async () => {
          await assert.rejects(sources[_source].query(_sql), /not authorized|authorization denied/)
          const { rows } = await sources[_source].query('SELECT COUNT(*) AS "nb" FROM "templates";')
          assert.strictEqual(rows[0].nb, 2)
          assert.strictEqual(sources[_source].sqlite.db.isTransaction, false)
        })
      }
    }
  })

  // Every type an argument can take: an answer or a clean error, never a
  // throw from deep inside, a crash, or a value silently bound as another
  describe('Arguments of every type', () => {
    const lite = db.create()

    before(async () => {
      await lite.init({ client: 'sqlite', filename: ':memory:' })
      await lite.query('CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "label");')
      fs.writeFileSync(path.join(tmpDir, 'typedItem.sql'), 'SELECT "id", "label" FROM "item" {# data.id #} WHERE "id" = {{ data.id }} {{#}} ORDER BY "id";')
      lite.registerSQLFile(path.join(tmpDir, 'typedItem.sql'))
    })

    afterEach(async () => {
      // Whatever a case did, the connection stays healthy and outside a transaction
      assert.strictEqual(lite.sqlite.db.isTransaction, false)
      assert.strictEqual((await lite.query('SELECT 1 AS "one";')).rows[0].one, 1)
    })

    after(async () => {
      await lite.close()
    })

    describe('a parameter value', () => {
      const select = (value) => lite.query('SELECT $1 AS "v", typeof($1) AS "t";', [value])
      class Plain {}
      const circular = {}
      circular.self = circular
      const revoked = Proxy.revocable({}, {})
      revoked.revoke()
      const date = new Date('2026-01-02T03:04:05.006Z')

      const accepted = [
        ['a string', 'text', 'text', 'text'],
        ['an empty string', '', '', 'text'],
        ['a string holding a NUL byte', 'a\u0000b', 'a\u0000b', 'text'],
        ['unicode', '🔥 é 漢字', '🔥 é 漢字', 'text'],
        ['zero', 0, 0, 'integer'],
        ['an integer', 42, 42, 'integer'],
        ['a negative integer', -7, -7, 'integer'],
        ['negative zero, an integer', -0, 0, 'integer'],
        ['a float', -1.5, -1.5, 'real'],
        ['an integer beyond 2^53, kept a float', 2 ** 60, 2 ** 60, 'real'],
        ['the largest safe integer', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'integer'],
        ['the smallest safe integer', Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 'integer'],
        ['the largest number', Number.MAX_VALUE, Number.MAX_VALUE, 'real'],
        ['the smallest number', Number.MIN_VALUE, Number.MIN_VALUE, 'real'],
        ['Infinity', Infinity, Infinity, 'real'],
        ['-Infinity', -Infinity, -Infinity, 'real'],
        ['NaN, which SQLite has no value for', NaN, null, 'null'],
        ['true', true, 1, 'integer'],
        ['false', false, 0, 'integer'],
        ['null', null, null, 'null'],
        ['undefined', undefined, null, 'null'],
        ['a small bigint', 42n, 42, 'integer'],
        ['a Date', date, '2026-01-02T03:04:05.006Z', 'text'],
        ['an empty array', [], '[]', 'text'],
        ['a nested array', [1, ['x', null]], '[1,["x",null]]', 'text'],
        ['a plain object', { a: 1, b: 'x' }, '{"a":1,"b":"x"}', 'text'],
        ['an object with a Date inside', { at: date }, '{"at":"2026-01-02T03:04:05.006Z"}', 'text'],
        ['a null-prototype object', Object.assign(Object.create(null), { a: 1 }), '{"a":1}', 'text'],
        ['an object with toJSON()', { toJSON: () => ({ custom: true }) }, '{"custom":true}', 'text'],
        ['a URL, which has toJSON()', new URL('https://carbone.io/a?b=c'), '"https://carbone.io/a?b=c"', 'text'],
        ['a Proxy of a plain object', new Proxy({ a: 1 }, {}), '{"a":1}', 'text']
      ]

      for (const [_label, _value, _expected, _type] of accepted) {
        it(`should bind ${_label}`, async () => {
          const { rows } = await select(_value)
          assert.ok(Object.is(rows[0].v, _expected), `${String(rows[0].v)} !== ${String(_expected)}`)
          assert.strictEqual(rows[0].t, _type)
        })
      }

      it('should bind a Buffer, a Uint8Array and an empty Buffer as a BLOB', async () => {
        for (const _value of [Buffer.from('hi'), new Uint8Array([1, 2, 3]), Buffer.alloc(0)]) {
          const { rows } = await lite.query('SELECT $1 AS "v", typeof($1) AS "t", length($1) AS "l";', [_value])
          assert.strictEqual(rows[0].t, 'blob')
          assert.strictEqual(rows[0].l, _value.length)
          assert.deepStrictEqual(Buffer.from(rows[0].v), Buffer.from(_value))
        }
      })

      it('should bind an integer as an INTEGER, never as "2.0" in text or JSON', async () => {
        const { rows } = await lite.query('SELECT \'id-\' || $1 AS "c", json_object(\'a\', $1) AS "j", CAST($1 AS TEXT) AS "s", $2 / 2 AS "div";', [2, 5])
        assert.deepStrictEqual({ ...rows[0] }, { c: 'id-2', j: '{"a":2}', s: '2', div: 2 })
        await lite.query('CREATE TABLE "typed" ("t" TEXT, "a");')
        await lite.query('INSERT INTO "typed" VALUES ($1, $2);', [5, 5])
        const { rows: _stored } = await lite.query('SELECT "t", typeof("a") AS "ta" FROM "typed";')
        await lite.query('DROP TABLE "typed";')
        assert.deepStrictEqual({ ..._stored[0] }, { t: '5', ta: 'integer' })
      })

      it('should bind a 1 MB string', async () => {
        const { rows } = await lite.query('SELECT length($1) AS "l";', ['x'.repeat(1 << 20)])
        assert.strictEqual(rows[0].l, 1 << 20)
      })

      it('should bind a 64-bit bigint exactly, and refuse to read it back as a wrong number', async () => {
        const { rows } = await lite.query('SELECT CAST($1 AS TEXT) AS "v", typeof($1) AS "t";', [2n ** 62n])
        assert.deepStrictEqual({ ...rows[0] }, { v: '4611686018427387904', t: 'integer' })
        await assert.rejects(select(2n ** 62n), /too large to be represented as a JavaScript number/)
        await assert.rejects(select(-(2n ** 63n)), /too large to be represented as a JavaScript number/)
      })

      const refused = [
        ['a bigint beyond 64 bits', 2n ** 64n, /BigInt value is too large to bind/],
        ['a symbol', Symbol('s'), /cannot be bound to SQLite parameter 1/],
        ['a function', () => 1, /cannot be bound to SQLite parameter 1/],
        ['an invalid Date', new Date('nope'), /Cannot bind parameter \$1: Invalid time value/],
        ['a Map', new Map([['a', 1]]), /Cannot bind parameter \$1: a Map cannot be bound/],
        ['a Set', new Set([1]), /Cannot bind parameter \$1: a Set cannot be bound/],
        ['a WeakMap', new WeakMap(), /Cannot bind parameter \$1: a WeakMap cannot be bound/],
        ['a RegExp', /x/, /Cannot bind parameter \$1: a RegExp cannot be bound/],
        ['an Error', new Error('x'), /Cannot bind parameter \$1: a Error cannot be bound/],
        ['a Promise', Promise.resolve(1), /Cannot bind parameter \$1: a Promise cannot be bound/],
        ['a boxed string', new String('x'), /Cannot bind parameter \$1: a String cannot be bound/], // eslint-disable-line no-new-wrappers
        ['a boxed number', new Number(1), /Cannot bind parameter \$1: a Number cannot be bound/], // eslint-disable-line no-new-wrappers
        ['a class instance', new Plain(), /Cannot bind parameter \$1: a Plain cannot be bound/],
        ['an object with a prototype but no constructor', Object.create(Object.create(null)), /Cannot bind parameter \$1: a value cannot be bound/],
        ['a Float64Array', new Float64Array([1]), /Cannot bind parameter \$1: a Float64Array cannot be bound/],
        ['an Int8Array', new Int8Array([1]), /Cannot bind parameter \$1: a Int8Array cannot be bound/],
        ['a Uint8ClampedArray', new Uint8ClampedArray([1]), /Cannot bind parameter \$1: a Uint8ClampedArray cannot be bound/],
        ['a DataView', new DataView(new ArrayBuffer(2)), /Cannot bind parameter \$1: a DataView cannot be bound/],
        ['an ArrayBuffer', new ArrayBuffer(2), /Cannot bind parameter \$1: a ArrayBuffer cannot be bound/],
        ['a SharedArrayBuffer', new SharedArrayBuffer(2), /Cannot bind parameter \$1: a SharedArrayBuffer cannot be bound/],
        ['a circular object', circular, /Cannot bind parameter \$1: Converting circular structure to JSON/],
        ['an object holding a bigint', { n: 1n }, /Cannot bind parameter \$1: Do not know how to serialize a BigInt/],
        ['an object whose toJSON() throws', { toJSON: () => { throw new Error('boom') } }, /Cannot bind parameter \$1: boom/],
        ['an object with a throwing getter', { get a () { throw new Error('getter') } }, /Cannot bind parameter \$1: getter/],
        ['a revoked Proxy', revoked.proxy, /Cannot bind parameter \$1: .*revoked/]
      ]

      for (const [_label, _value, _expected] of refused) {
        it(`should refuse ${_label} with an error`, async () => {
          await assert.rejects(select(_value), _expected)
        })
      }

      it('should name the parameter that cannot be bound, and write nothing', async () => {
        await assert.rejects(lite.query('INSERT INTO "item" ("label") VALUES ($1), ($2), ($3);', ['ok', 'ok', new Map()]), /Cannot bind parameter \$3: a Map cannot be bound/)
        assert.strictEqual((await lite.query('SELECT COUNT(*) AS "nb" FROM "item";')).rows[0].nb, 0)
      })

      it('should answer a refused value through the callback, not a throw', (done) => {
        lite.query('SELECT $1;', [new Map()], (err, res, rows) => {
          assert.match(err.message, /a Map cannot be bound/)
          assert.strictEqual(res, undefined)
          assert.deepStrictEqual(rows, [])
          done()
        })
      })
    })

    describe('the query and its parameters', () => {
      for (const _sql of [undefined, null, 1, true, {}, [], Symbol('q'), () => 'SELECT 1;', Buffer.from('SELECT 1;')]) {
        it(`should refuse a query of type ${typeof _sql}${Array.isArray(_sql) ? ' (array)' : ''}${Buffer.isBuffer(_sql) ? ' (Buffer)' : ''}`, async () => {
          await assert.rejects(lite.query(_sql, []), /A query must be a string/)
        })
      }

      for (const _sql of ['', '   ', ';', '-- only a comment', '/* only a comment */']) {
        it(`should accept an empty query ${JSON.stringify(_sql)}, as an empty migration file`, async () => {
          const { result, rows } = await lite.query(_sql)
          assert.strictEqual(result.rowCount, 0)
          assert.deepStrictEqual(rows, [])
        })
      }

      for (const _params of ['x', 1, true, {}, new Set(['x']), { length: 1, 0: 'x' }, Symbol('p')]) {
        it(`should refuse parameters of type ${typeof _params}${_params instanceof Set ? ' (Set)' : ''}`, async () => {
          await assert.rejects(lite.query('SELECT $1;', _params), /Query parameters must be an array/)
        })
      }

      it('should take null and undefined parameters as none', async () => {
        assert.strictEqual((await lite.query('SELECT 2 AS "v";', null)).rows[0].v, 2)
        assert.strictEqual((await lite.query('SELECT 2 AS "v";', undefined)).rows[0].v, 2)
      })

      it('should bind a missing or a hole in the parameters as NULL', async () => {
        const { rows } = await lite.query('SELECT $1 AS "a", $2 AS "b";', [, 'b']) // eslint-disable-line no-sparse-arrays
        assert.deepStrictEqual({ ...rows[0] }, { a: null, b: 'b' })
        const { rows: _missing } = await lite.query('SELECT $1 AS "a", $2 AS "b";', ['a'])
        assert.deepStrictEqual({ ...rows[0], ..._missing[0] }, { a: 'a', b: null })
      })

      it('should refuse more parameters than the query has', async () => {
        await assert.rejects(lite.query('SELECT $1;', ['a', 'b']), /Unknown named parameter '2'/)
      })

      it('should refuse parameters for a script', async () => {
        await assert.rejects(lite.query('SELECT 1; SELECT 2;', ['a']), /multiple commands/)
      })

      for (const _callback of ['x', 1, {}, null, true]) {
        it(`should throw on a ${_callback === null ? 'null' : typeof _callback} callback, before running the query`, async () => {
          assert.throws(() => lite.query('INSERT INTO "item" ("label") VALUES ($1);', ['never'], _callback), /The callback must be a function/)
          assert.throws(() => lite.exec('typedItem', {}, null, _callback), /The callback must be a function/)
          assert.strictEqual((await lite.query('SELECT COUNT(*) AS "nb" FROM "item";')).rows[0].nb, 0)
        })
      }
    })

    describe('exec', () => {
      before(async () => {
        await lite.query('INSERT INTO "item" ("id", "label") VALUES (1, \'a\'), (2, \'b\');')
      })

      after(async () => {
        await lite.query('DELETE FROM "item";')
      })

      for (const _name of [undefined, null, 1, {}, [], Symbol('n'), 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'missing']) {
        it(`should refuse an unknown SQL file named ${String(_name)}`, async () => {
          await assert.rejects(lite.exec(_name, {}), /Unknow SQL file/)
        })
      }

      for (const _data of [undefined, null, {}, 'x', 42, true, [], { id: undefined }, { id: null }]) {
        it(`should answer or fail cleanly with data ${_data === undefined ? 'undefined' : JSON.stringify(_data)}`, async () => {
          const _outcome = await lite.exec('typedItem', _data, null).then(({ object }) => object, err => err)

          if (_outcome instanceof Error) {
            return
          }
          assert.ok(Array.isArray(_outcome))
        })
      }

      it('should bind data of every type through a SQL file, never as SQL', async () => {
        for (const _id of [2, '2', 2n, 2.5, '2 OR 1=1', '1; DROP TABLE "item"', { a: 1 }, [1, 2], true]) {
          const { object } = await lite.exec('typedItem', { id: _id }, null)
          assert.ok(object.length <= 1, `id ${String(_id)} returned ${object.length} rows`)
        }
        // The {# data.id #} block of the file skips its WHERE on a null id
        assert.strictEqual((await lite.exec('typedItem', { id: null }, null)).object.length, 2)
        assert.strictEqual((await lite.query('SELECT COUNT(*) AS "nb" FROM "item";')).rows[0].nb, 2)
      })

      it('should name the SQL file whose query fails', async () => {
        fs.writeFileSync(path.join(tmpDir, 'brokenQuery.sql'), 'SELECT * FROM "nope";')
        lite.registerSQLFile(path.join(tmpDir, 'brokenQuery.sql'))
        await assert.rejects(lite.exec('brokenQuery', {}), /Error while executing query for file brokenQuery\.sql\. Error: no such table: nope/)
      })

      it('should answer an Error, not crash, when the model cannot be read', async () => {
        const _throwing = [{ get id () { throw new Error('model getter') } }]
        await assert.rejects(lite.exec('typedItem', {}, _throwing), (err) => err instanceof Error && /model getter for model/.test(err.message))

        // Converting a circular model overflows the stack; describing it in
        // the error must not throw again, out of the callback
        const _circular = [{ id: ['<<id>>'] }]
        _circular[0].self = _circular
        await assert.rejects(lite.exec('typedItem', {}, _circular), (err) => err instanceof Error && /for model/.test(err.message))
      })

      for (const _model of ['x', 42, true, {}, [{}], [{ id: ['<id>'] }], [{ id: ['<<missing>>'] }]]) {
        it(`should answer or fail with an Error for the model ${JSON.stringify(_model)}`, async () => {
          const _outcome = await lite.exec('typedItem', {}, _model).then(({ object }) => object, err => err)

          if (_outcome instanceof Error) {
            return
          }
          assert.notStrictEqual(_outcome, undefined)
        })
      }
    })

    describe('init', () => {
      const failing = [
        ['no configuration', undefined, /The database configuration must be an object/],
        ['a null configuration', null, /The database configuration must be an object/],
        ['a string configuration', 'sqlite', /The database configuration must be an object/],
        ['a number configuration', 42, /The database configuration must be an object/],
        ['a client in another case', { client: 'SQLite', filename: ':memory:' }, /Unknown database client "SQLite"/],
        ['a client with a space', { client: 'sqlite ', filename: ':memory:' }, /Unknown database client "sqlite "/],
        ['a __proto__ client', { client: '__proto__', filename: ':memory:' }, /Unknown database client "__proto__"/],
        ['a constructor client', { client: 'constructor', filename: ':memory:' }, /Unknown database client "constructor"/],
        ['a number client', { client: 5, filename: ':memory:' }, /Unknown database client "5"/],
        ['an object client', { client: {}, filename: ':memory:' }, /Unknown database client/],
        ['a symbol client', { client: Symbol('sqlite'), filename: ':memory:' }, /Unknown database client "Symbol\(sqlite\)"/],
        ['an empty filename', { client: 'sqlite', filename: '' }, /needs either a filename or a buffer/],
        ['a number filename', { client: 'sqlite', filename: 1 }, /needs either a filename or a buffer/],
        ['an object filename', { client: 'sqlite', filename: {} }, /needs either a filename or a buffer/],
        ['a URL filename', { client: 'sqlite', filename: new URL('file:///tmp/x.db') }, /needs either a filename or a buffer/],
        ['a filename and a buffer', { client: 'sqlite', filename: ':memory:', buffer: Buffer.from('x') }, /needs either a filename or a buffer/],
        ['a string buffer', { client: 'sqlite', buffer: 'x' }, /must be a non-empty Buffer or Uint8Array/],
        ['a null buffer', { client: 'sqlite', buffer: null }, /must be a non-empty Buffer or Uint8Array/],
        ['an array buffer', { client: 'sqlite', buffer: [1, 2] }, /must be a non-empty Buffer or Uint8Array/],
        ['an ArrayBuffer', { client: 'sqlite', buffer: new ArrayBuffer(8) }, /must be a non-empty Buffer or Uint8Array/],
        ['a Float64Array buffer', { client: 'sqlite', buffer: new Float64Array(8) }, /must be a non-empty Buffer or Uint8Array/],
        ['an empty buffer', { client: 'sqlite', buffer: Buffer.alloc(0) }, /must be a non-empty Buffer or Uint8Array/],
        ['a "true" readOnly', { client: 'sqlite', filename: ':memory:', readOnly: 'true' }, /readOnly must be a boolean/],
        ['a 1 readOnly', { client: 'sqlite', filename: ':memory:', readOnly: 1 }, /readOnly must be a boolean/],
        ['a null readOnly', { client: 'sqlite', filename: ':memory:', readOnly: null }, /readOnly must be a boolean/],
        ['a read-only :memory:', { client: 'sqlite', filename: ':memory:', readOnly: true }, /unable to open database file/],
        ['a filename with a NUL byte', { client: 'sqlite', filename: 'a\u0000b.db' }, /without null bytes/]
      ]

      for (const [_label, _conf, _expected] of failing) {
        it(`should fail cleanly on ${_label}`, async () => {
          const _lite = db.create()
          await assert.rejects(_lite.init(_conf), _expected)
          assert.strictEqual(_lite.sqlite, null)
          assert.strictEqual(_lite._pool, null)
        })
      }

      it('should fail on a directory, on a file that is not a database, and leave that file as it was', async () => {
        const _text = path.join(tmpDir, 'notADatabase.txt')
        fs.writeFileSync(_text, 'just some text, long enough to look like a header '.repeat(10))
        const _bytes = fs.readFileSync(_text)

        await assert.rejects(db.create().init({ client: 'sqlite', filename: tmpDir }), /unable to open database file/)
        await assert.rejects(db.create().init({ client: 'sqlite', filename: _text }), /file is not a database/)
        await assert.rejects(db.create().init({ client: 'sqlite', filename: _text, readOnly: true }), /file is not a database/)
        assert.deepStrictEqual(fs.readFileSync(_text), _bytes)
      })

      it('should open a read-only file whose name looks like a URL, without reading options from it', async () => {
        const _odd = path.join(tmpDir, 'we#ird ?name%20 é&mode=rwc.db')
        const _writer = await open({ client: 'sqlite', filename: _odd })
        await _writer.query('CREATE TABLE "x" ("a"); INSERT INTO "x" VALUES (1);')
        await close(_writer)

        const _reader = await open({ client: 'sqlite', filename: _odd, readOnly: true })
        assert.strictEqual((await _reader.query('SELECT "a" FROM "x";')).rows[0].a, 1)
        await assert.rejects(_reader.query('INSERT INTO "x" VALUES (2);'), /not authorized/)
        await close(_reader)
      })

      for (const [_timeout, _expected] of [[0, 2147483647], ['2000', 2000], [1.9, 1], [-1, 10000], ['abc', 10000], [NaN, 10000], [Infinity, 10000], [null, 10000], [{}, 10000]]) {
        it(`should turn a timeout of ${String(_timeout)} into a busy timeout of ${_expected}`, async () => {
          const _lite = await open({ client: 'sqlite', filename: ':memory:', timeout: _timeout })
          assert.strictEqual(_lite.sqlite.db.prepare('PRAGMA busy_timeout').get().timeout, _expected)
          await close(_lite)
        })
      }

      it('should fail cleanly on a timeout beyond what SQLite takes', async () => {
        const _outcome = await open({ client: 'sqlite', filename: ':memory:', timeout: 1e12 }).then(_lite => close(_lite).then(() => 'opened'), err => err)
        assert.ok(_outcome === 'opened' || _outcome instanceof Error)
      })

      it('should refuse to open twice without closing, then open again once closed', async () => {
        const _lite = await open({ client: 'sqlite', filename: ':memory:' })
        await assert.rejects(_lite.init({ client: 'sqlite', filename: ':memory:' }), /already open, close it first/)
        assert.strictEqual((await _lite.query('SELECT 1 AS "one";')).rows[0].one, 1)
        await close(_lite)
        await _lite.init({ client: 'sqlite', filename: ':memory:' })
        await close(_lite)
      })

      it('should init and close with promises, and close twice harmlessly', async () => {
        const _lite = db.create()
        assert.strictEqual(await _lite.init({ client: 'sqlite', filename: ':memory:' }), undefined)
        await _lite.close()
        await _lite.close()
        await assert.rejects(_lite.query('SELECT 1;'), /not connected/)
      })

      it('should close a database that was never opened', async () => {
        await db.create().close()
      })

      for (const _callback of ['x', 1, {}, null]) {
        it(`should throw on a ${_callback === null ? 'null' : typeof _callback} callback for init and close`, () => {
          assert.throws(() => db.create().init({ client: 'sqlite', filename: ':memory:' }, _callback), /The callback must be a function/)
          assert.throws(() => db.create().close(_callback), /The callback must be a function/)
        })
      }
    })
  })

  // Needs the hearth_test Postgres database and port 8080
  describe('Alongside Postgres', () => {
    before((done) => {
      db.init({ ...pgConf }, (err) => {
        assert.strictEqual(err, null)
        db.query('DROP TABLE IF EXISTS "templates_sync"; CREATE TABLE "templates_sync" ("id" TEXT PRIMARY KEY, "name" TEXT, "size" INTEGER);', done)
      })
    })

    after((done) => {
      db.query('DROP TABLE IF EXISTS "templates_sync";', () => db.close(done))
    })

    it('should use SQLite and Postgres at the same time, and close SQLite alone', async () => {
      const lite = await open({ client: 'sqlite', filename: ':memory:' })
      const [_pg, _lite] = await Promise.all([
        db.query('SELECT version() AS "v";'),
        lite.query('SELECT sqlite_version() AS "v";')
      ])
      assert.match(_pg.rows[0].v, /PostgreSQL/)
      assert.match(_lite.rows[0].v, /^3\./)
      assert.strictEqual(db.sqlite, null)
      assert.strictEqual(db.dialect.migrationTable, 'hearthjs."migration"')
      await close(lite)
      const { rows } = await db.query('SELECT 1 AS "one";')
      assert.strictEqual(rows[0].one, 1)
    })

    it('should sync a read-only SQLite backup into Postgres', async () => {
      const _file = path.join(tmpDir, 'sync.db.0.backup')
      const _writer = await open({ client: 'sqlite', filename: _file })
      await _writer.query('CREATE TABLE "templates" ("id" TEXT PRIMARY KEY, "name" TEXT, "size" INTEGER); INSERT INTO "templates" VALUES (\'t1\', \'Invoice\', 10), (\'t2\', \'Quote\', 20);')
      await close(_writer)

      await db.query('INSERT INTO "templates_sync" VALUES ($1, $2, $3);', ['t1', 'old name', 1])

      const backup = await open({ client: 'sqlite', filename: _file, readOnly: true })
      const { rows } = await backup.query('SELECT "id", "name", "size" FROM "templates";')

      for (const _row of rows) {
        await db.query('INSERT INTO "templates_sync" ("id", "name", "size") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "size" = EXCLUDED."size";', [_row.id, _row.name, _row.size])
      }
      await close(backup)

      const { rows: _synced } = await db.query('SELECT "id", "name", "size" FROM "templates_sync" ORDER BY "id";')
      assert.deepStrictEqual(_synced, [{ id: 't1', name: 'Invoice', size: 10 }, { id: 't2', name: 'Quote', size: 20 }])
    })

    it('should sync a backup downloaded in memory into Postgres, without a file', async () => {
      await db.query('DELETE FROM "templates_sync";')
      await db.query('INSERT INTO "templates_sync" VALUES ($1, $2, $3);', ['t2', 'stale', 0])

      // What arrives from S3: the bytes of a WAL backup
      const _downloaded = await makeWalBackup(tmpDir, 'downloaded')
      const backup = db.create()
      await backup.init({ client: 'sqlite', buffer: _downloaded, readOnly: true })
      const { rows } = await backup.query('SELECT "id", "name", "size" FROM "templates" ORDER BY "id";')
      await db.query('INSERT INTO "templates_sync" ("id", "name", "size") SELECT * FROM unnest($1::text[], $2::text[], $3::int[]) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "size" = EXCLUDED."size";', [rows.map(r => r.id), rows.map(r => r.name), rows.map(r => r.size)])
      await backup.close()

      const { rows: _synced } = await db.query('SELECT "id", "name", "size" FROM "templates_sync" ORDER BY "id";')
      assert.deepStrictEqual(_synced, [{ id: 't1', name: 'Invoice', size: 10 }, { id: 't2', name: 'Quote', size: 20 }])
      assert.strictEqual(db.sqlite, null)
    })
  })

  // An app on SQLite only, from its config file. Its Postgres keys point at a
  // closed port: any attempt to reach Postgres would fail the start.
  describe('App on SQLite only', () => {
    const serverPath = path.join(__dirname, 'datasets', 'sqliteApp', 'server')
    const dataDir = path.join(serverPath, 'data')
    const dbFile = path.join(dataDir, 'app.db')
    const binPath = path.join(__dirname, '..', 'bin', 'hearthjs')
    const client = new app.httpClient() // eslint-disable-line new-cap
    const call = (method, ...args) => new Promise((resolve, reject) => client[method](...args, (err, response, body) => err ? reject(err) : resolve({ response, body })))
    const run = () => new Promise((resolve, reject) => app.run('test', serverPath, (err) => err ? reject(err) : resolve()))
    const stop = () => new Promise(resolve => app.close(resolve))
    let previousServerPath = null

    before(() => {
      previousServerPath = process.env.HEARTH_SERVER_PATH
      process.env.HEARTH_SERVER_PATH = serverPath
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    after(() => {
      fs.rmSync(dataDir, { recursive: true, force: true })
      const _logFile = path.join(serverPath, 'logs', `${logger._getCurrentDateTime(false)}.log`)

      if (fs.existsSync(_logFile)) {
        fs.unlinkSync(_logFile)
      }

      if (previousServerPath === undefined) {
        delete process.env.HEARTH_SERVER_PATH
      } else {
        process.env.HEARTH_SERVER_PATH = previousServerPath
      }
    })

    it('should not load pg at all', () => {
      const _script = 'require("./lib").db.create().init({ client: "sqlite", filename: ":memory:" }, (err) => { if (err) throw err; process.stdout.write(String(Object.keys(require.cache).some(file => file.includes("/node_modules/pg/")))) })'
      assert.strictEqual(execFileSync(process.execPath, ['-e', _script], { cwd: path.join(__dirname, '..') }).toString(), 'false')
    })

    it('should fail closed when the directory of the file is missing', async () => {
      await assert.rejects(run(), /Cannot open the sqlite database .*data\/app\.db: unable to open database file/)
      await stop()
      assert.strictEqual(fs.existsSync(dataDir), false)
    })

    it('should migrate the file with the CLI, resolved from the server directory', (done) => {
      fs.mkdirSync(dataDir)
      suppose(binPath, ['migrate', 'test'])
        .when('Would you apply changes? [Yn]', 'Y\n')
        .end((code) => {
          assert.strictEqual(code, 0)
          assert.strictEqual(fs.existsSync(dbFile), true)
          done()
        })
    })

    it('should start, log the file, and answer API routes backed by SQL files', async () => {
      const _logs = []
      const _log = logger.log
      logger.log = function (message) {
        _logs.push(String(message))
        return _log.apply(this, arguments)
      }

      try {
        await run()
      } finally {
        logger.log = _log
      }

      assert.strictEqual(db._pool, null)
      assert.notStrictEqual(_logs.find(line => line.includes(`database   sqlite ${dbFile}`)), undefined, _logs.join('\n'))
      assert.strictEqual(_logs.some(line => line.includes('127.0.0.1:1')), false)

      await new Promise((resolve, reject) => datasets.clean((err) => err ? reject(err) : resolve()))
      const { body: _created } = await call('post', '/notes', { text: 'first', done: true, meta: { tag: 'a' } })
      assert.deepStrictEqual(_created.data, { id: 1, text: 'first' })
      await call('post', '/notes', { text: '\'); DROP TABLE "note"; --', done: false })

      const { body } = await call('get', '/notes')
      assert.deepStrictEqual(body.data, [
        { id: 1, text: 'first', done: 1, meta: '{"tag":"a"}' },
        { id: 2, text: '\'); DROP TABLE "note"; --', done: 0, meta: null }
      ])

      const _rows = await new Promise((resolve, reject) => hearthTest.waitForRow('SELECT "createdAt" FROM "note" WHERE "id" = $1;', [1], rows => rows.length === 1, (err, rows) => err ? reject(err) : resolve(rows)))
      assert.ok(Date.parse(_rows[0].createdAt) > 0)
      await stop()
    })

    it('should have kept the data and the migration in the file', async () => {
      const _file = await open({ client: 'sqlite', filename: dbFile, readOnly: true })
      const { rows } = await _file.query('SELECT "text" FROM "note" ORDER BY "id";')
      const { rows: _migrations } = await _file.query('SELECT "filename" FROM "hearthjs_migration";')
      await close(_file)
      assert.deepStrictEqual(plain(rows), [{ text: 'first' }, { text: '\'); DROP TABLE "note"; --' }])
      assert.deepStrictEqual(plain(_migrations), [{ filename: '1' }])
    })

    it('should clean every table whatever the foreign keys, keeping the migration table', async () => {
      process.env.APP_DATABASE_SQLITE_FILENAME = ':memory:'

      try {
        await run()
        await db.query('CREATE TABLE "parent" ("id" INTEGER PRIMARY KEY); CREATE TABLE "child" ("id" INTEGER PRIMARY KEY, "parentId" INTEGER NOT NULL REFERENCES "parent" ("id"));')
        await db.query('INSERT INTO "parent" VALUES (1); INSERT INTO "child" VALUES (1, 1); INSERT INTO "hearthjs_migration" ("filename", "dateApplied") VALUES (\'1\', NOW());')
        await new Promise((resolve, reject) => datasets.clean((err) => err ? reject(err) : resolve()))
        const { rows } = await db.query('SELECT (SELECT COUNT(*) FROM "parent") AS "parent", (SELECT COUNT(*) FROM "child") AS "child", (SELECT COUNT(*) FROM "hearthjs_migration") AS "migration";')
        assert.deepStrictEqual(plain(rows), [{ parent: 0, child: 0, migration: 1 }])
      } finally {
        delete process.env.APP_DATABASE_SQLITE_FILENAME
        await stop()
      }
    })

    it('should fail to start on an unknown client, leaving the config file alone', async () => {
      const _configPath = path.join(serverPath, 'config', 'test.json')
      const _config = fs.readFileSync(_configPath, 'utf8')
      process.env.APP_DATABASE_CLIENT = 'mongodb'

      try {
        await assert.rejects(run(), /Unknown database client "mongodb"/)
        assert.strictEqual(fs.readFileSync(_configPath, 'utf8'), _config)
      } finally {
        delete process.env.APP_DATABASE_CLIENT
        await stop()
      }
    })
  })
})
