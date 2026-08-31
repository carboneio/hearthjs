const db = require('../lib/database')
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const logger = require('../lib/logger')
const mustache = require('../lib/mustache')

const host = 'localhost'
const password = 'password'
const user = 'postgres'
const database = 'hearth_test'
const port = 5432

describe('Database', function () {
  this.timeout(100000)
  before(() => {
    process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'myApp', 'server')
  })

  after((done) => {
    const _logFile = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

    if (fs.existsSync(_logFile)) {
      fs.unlinkSync(_logFile)
    }

    delete process.env.HEARTH_SERVER_PATH
    delete process.env.APP_DATABASE_NAME
    done()
  })

  describe('Connection', () => {
    afterEach((done) => {
      db.close(done)
    })

    it('should not connect if database does not exists', (done) => {
      delete process.env.APP_DATABASE_NAME
      db.init({
        user,
        host,
        database: 'Unknown',
        password,
        port
      }, (err) => {
        assert.notStrictEqual(err, null)
        process.env.APP_DATABASE_NAME = database
        done()
      })
    })

    it('should not connect if ID are wrong', (done) => {
      delete process.env.APP_DATABASE_USER
      delete process.env.APP_DATABASE_PASSWORD
      db.init({
        user: 'toto',
        host,
        database,
        password: 'pass',
        port
      }, (err) => {
        assert.notStrictEqual(err, null)
        process.env.APP_DATABASE_USER = user
        process.env.APP_DATABASE_PASSWORD = password
        done()
      })
    })

    it('should take env variable if exists instead of conf', (done) => {
      delete process.env.APP_DATABASE_USER
      db.init({
        user: 'bad',
        host: 'bad',
        database: 'bad',
        password: 'bad',
        port
      }, (err) => {
        assert.notStrictEqual(err, null)
        process.env.APP_DATABASE_USER = 'postgres'
        process.env.APP_DATABASE_PASSWORD = 'password'
        process.env.APP_DATABASE_NAME = 'hearth_test'

        db.init({
          user: 'bad',
          host: 'localhost',
          database: 'bad',
          password: 'bad',
          port
        }, (err) => {
          assert.strictEqual(err, null)
          done()
        })
      })
    })

    it('should set a default timeout of 10s', (done) => {
      db.init({
        user,
        host,
        database,
        password,
        port
      }, (err) => {
        assert.strictEqual(err, null)
        db.query('SHOW statement_timeout;', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows[0].statement_timeout, '10s')
          done()
        })
      })
    })

    it('should set timeout of 30s', (done) => {
      db.init({
        user,
        host,
        database,
        password,
        port,
        timeout: 30000
      }, (err) => {
        assert.strictEqual(err, null)
        db.query('SHOW statement_timeout;', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows[0].statement_timeout, '30s')
          done()
        })
      })
    })

    it('should apply the timeout to every pooled connection, not just the first', (done) => {
      // SECURITY: a session-scoped `SET statement_timeout` on one client left
      // connections created lazily under load with no limit — the query-DoS
      // defence was absent on them. The timeout is now a pool option pg
      // applies to every backend. Hold several connections open at once
      // (pg_sleep keeps each busy) and confirm each fresh backend has it.
      db.init({
        user,
        host,
        database,
        password,
        port,
        timeout: 7000
      }, (err) => {
        assert.strictEqual(err, null)

        const _pids = new Set()
        let _remaining = 6

        for (let i = 0; i < 6; i++) {
          // pg_sleep forces the pool to open distinct concurrent backends
          db.query("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS t, pg_sleep(0.15);", (err, res, rows) => {
            assert.strictEqual(err, null, err && err.toString())
            assert.strictEqual(rows[0].t, '7s', `a fresh backend (pid ${rows[0].pid}) is missing the timeout`)
            _pids.add(rows[0].pid)
            _remaining -= 1

            if (_remaining === 0) {
              assert.strictEqual(_pids.size > 1, true, 'the test must exercise more than one backend')
              done()
            }
          })
        }
      })
    }).timeout(20000)
  })

  describe('Register SQL files', () => {
    it('should register 3 files', (done) => {
      let pathFile1 = path.join(__dirname, 'datasets', 'sqlFiles', 'file1.sql')
      let pathFile2 = path.join(__dirname, 'datasets', 'sqlFiles', 'file2.sql')
      let pathFile3 = path.join(__dirname, 'datasets', 'sqlFiles', 'file3.sql')
      let expected = {
        file1: pathFile1,
        file2: pathFile2,
        file3: pathFile3
      }

      db._sqlFiles = {}
      db.registerSQLFile(pathFile1)
      db.registerSQLFile(pathFile2)
      db.registerSQLFile(pathFile3)
      assert.deepStrictEqual(db._sqlFiles, expected)
      done()
    })

    it('should not register two times a file with the same name', (done) => {
      let pathFile1 = path.join(__dirname, 'datasets', 'sqlFiles', 'file1.sql')
      let pathDuplicateFile1 = path.join(__dirname, 'datasets', 'sqlFiles', 'duplicate', 'file1.sql')
      let expected = {
        file1: pathFile1
      }

      db._sqlFiles = {}
      db.registerSQLFile(pathFile1)
      db.registerSQLFile(pathDuplicateFile1)
      assert.deepStrictEqual(db._sqlFiles, expected)
      done()
    })
  })

  describe('Exec SQL files', () => {
    before((done) => {
      db.init({
        user,
        host,
        database,
        password,
        port
      }, (err) => {
        if (err) {
          return done(err)
        }
        let pathFile1 = path.join(__dirname, 'datasets', 'sqlFiles', 'file1.sql')
        let pathFile2 = path.join(__dirname, 'datasets', 'sqlFiles', 'file2.sql')
        let pathFile3 = path.join(__dirname, 'datasets', 'sqlFiles', 'file3.sql')
        let pathFileComplex = path.join(__dirname, 'datasets', 'sqlFiles', 'complex.sql')
        let pathFileError = path.join(__dirname, 'datasets', 'sqlFiles', 'sqlError.sql')

        db._sqlFiles = {}
        db.registerSQLFile(pathFile1)
        db.registerSQLFile(pathFile2)
        db.registerSQLFile(pathFile3)
        db.registerSQLFile(pathFileComplex)
        db.registerSQLFile(pathFileError)
        done()
      })
    })

    after((done) => {
      db.close(done)
    })

    it('should exec file1 without params', (done) => {
      db.exec('file1', (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows[0].number, 1)
        done()
      })
    })

    it('should exec file1 without params with promise', async () => {
      let { object } = await db.exec('file1')
      assert.strictEqual(object[0].number, 1)
    })

    it('should not exec an unknown SQL template', (done) => {
      db.exec('unknown', (err, res, rows) => {
        assert.notStrictEqual(err, null)
        done()
      })
    })

    it('should not exec an unknown SQL template with promise', async () => {
      try {
        await db.exec('unknown')
        assert.strictEqual(1, 2)
      } catch (e) {
        assert.notStrictEqual(e, null)
      }
    })

    it('should return SQL error', (done) => {
      db.exec('sqlError', (err, res, rows) => {
        assert.notStrictEqual(err, null)
        done()
      })
    })

    it('should exec SQL template with params', (done) => {
      db.exec('file3', { id: 1 }, (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows[0].str, 'Hello')
        db.exec('file3', { id: 0 }, (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows.length, 0)
          done()
        })
      })
    })

    it('should exec SQL template with params with promise', async () => {
      let { object } = await db.exec('file3', { id: 1 })
      assert.strictEqual(object[0].str, 'Hello')
    })

    it('should exec a complex SQL file', (done) => {
      let data = {
        firstname: 'John',
        lastname: 'Doe',
        mail: 'john.doe@gmail.com',
        where: true,
        id: 1
      }
      db.exec('complex', data, (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(rows[0], {
          firstname: 'John',
          lastname: 'Doe',
          mail: 'john.doe@gmail.com'
        })
        done()
      })
    })

    it('should convert rows with model if exists', (done) => {
      let data = {
        firstname: 'John',
        lastname: 'Doe',
        mail: 'john.doe@gmail.com',
        where: true,
        id: 1
      }
      let model = ['object', {
        firstname: ['<firstname>'],
        lastname: ['<lastname>'],
        mail: ['<mail>']
      }]
      db.exec('complex', data, model, (err, res, model) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(model, {
          firstname: 'John',
          lastname: 'Doe',
          mail: 'john.doe@gmail.com'
        })
        done()
      })
    })
  })

  describe('Query', () => {
    before((done) => {
      db.init({
        user,
        host,
        database,
        password,
        port
      }, done)
    })

    after((done) => {
      db.close(done)
    })

    it('should execute a SQL query', (done) => {
      db.query('SELECT 1 AS number;', (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows[0].number, 1)
        done()
      })
    })

    it('should execute a SQL query with promise', async () => {
      let { rows } = await db.query('SELECT 1 AS number;')
      assert.strictEqual(rows[0].number, 1)
    })

    it('should identify itself with the default application_name', (done) => {
      db.query("SELECT current_setting('application_name') AS app;", (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows[0].app, 'hearthjs', 'the application_name reaches Postgres')
        done()
      })
    })

    // SECURITY: end to end, a `:hard` injection payload must never reach the
    // database, while a legitimate identifier paste still runs. The unit-level
    // validation lives in test/mustache.js; this is the integration proof.
    it('should stop a :hard injection payload from reaching the database', (done) => {
      mustache.render('SELECT {{ data.p:hard }} AS leaked', { p: 'version()' }, (err, rendered) => {
        assert.notStrictEqual(err, null, 'version() must be rejected at render time')
        assert.strictEqual(rendered, undefined, 'no SQL is built for an injection payload')

        mustache.render('SELECT 1 AS {{ data.p:hard }}', { p: 'my_alias' }, (err, ok) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(ok.string, 'SELECT 1 AS my_alias')

          db.query(ok.string, ok.data, (err, res, rows) => {
            assert.strictEqual(err, null, err && err.toString())
            assert.strictEqual(rows[0].my_alias, 1, 'a legitimate identifier paste still works end to end')
            done()
          })
        })
      })
    })

    it('should return an error', (done) => {
      db.query('SELECT "name" FROM "unknown";', (err, res, rows) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(res, undefined)
        assert.strictEqual(rows.length, 0)
        done()
      })
    })

    it('should return an error with promise', async () => {
      try {
        await db.query('SELECT "name" FROM "unknown";')
        assert.strictEqual(1, 2)
      } catch (e) {
        assert.notStrictEqual(e, null)
      }
    })

    it('should execute 10 SQL queries', (done) => {
      let nb = 0

      for (var i = 0; i < 10; i++) {
        db.query('SELECT 1 AS number, pg_sleep(0.1);', (err, res, rows) => {
          nb++
          assert.strictEqual(err, null)
          assert.strictEqual(rows[0].number, 1)

          if (nb === 10) {
            done()
          }
        })
      }
    }).timeout(3000)
  })

  describe('connection-level detection', () => {
    it('should flag connection-level errors (socket/DNS + pg class 08 / 57P0x)', () => {
      const _codes = [
        'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED',
        'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN',
        '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
        '57P01', '57P02', '57P03', '57P05'
      ]

      for (const _code of _codes) {
        assert.strictEqual(db._isConnectionError({ code: _code }), true, _code)
      }
    })

    it('should flag the codeless messages node-postgres emits on a real drop', () => {
      assert.strictEqual(db._isConnectionError({ message: 'Connection terminated unexpectedly' }), true)
      assert.strictEqual(db._isConnectionError({ message: 'Client has encountered a connection error and is not queryable' }), true)
    })

    it('should NOT flag intentional closes or timeouts (regression)', () => {
      // These node-postgres messages must never be treated as a retryable drop:
      // an intentional client.end(), the pool connect-timeout, the pool acquire
      // timeout, and a deliberately closed client.
      const _notConnection = [
        'Connection terminated',
        'Connection terminated due to connection timeout',
        'timeout exceeded when trying to connect',
        'Client was closed and is not queryable',
        'Query read timeout'
      ]

      for (const _message of _notConnection) {
        assert.strictEqual(db._isConnectionError({ message: _message }), false, _message)
      }
    })

    it('should not flag query-level errors', () => {
      // query_canceled/statement_timeout, deadlock, unique violation, undefined
      // table, database_dropped (futile to retry), too_many_connections
      for (const _code of ['57014', '40P01', '23505', '42P01', '57P04', '53300']) {
        assert.strictEqual(db._isConnectionError({ code: _code }), false, _code)
      }

      assert.strictEqual(db._isConnectionError(null), false)
      assert.strictEqual(db._isConnectionError(undefined), false)
      assert.strictEqual(db._isConnectionError({ message: 'duplicate key value' }), false)
    })

    it('should treat only plain SELECTs as idempotent reads', () => {
      assert.strictEqual(db._isIdempotentRead('SELECT 1'), true)
      assert.strictEqual(db._isIdempotentRead('  select * from t'), true)
      assert.strictEqual(db._isIdempotentRead('-- a comment\nSELECT 1'), true)
      assert.strictEqual(db._isIdempotentRead('/* x */ SELECT 1'), true)
    })

    it('should never retry writes, CTEs, locking reads or SELECT INTO', () => {
      const _unsafe = [
        'UPDATE t SET x = 1',
        'INSERT INTO t VALUES (1)',
        'DELETE FROM t',
        'WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x',
        'SELECT * FROM t FOR UPDATE',
        'SELECT * FROM t FOR SHARE',
        'SELECT * INTO t2 FROM t',
        '',
        42
      ]

      for (const _q of _unsafe) {
        assert.strictEqual(db._isIdempotentRead(_q), false, JSON.stringify(_q))
      }
    })
  })

  describe('pool option parsing', () => {
    afterEach(() => {
      delete process.env.APP_DATABASE_POOL_MAX
    })

    it('should use the default when nothing is set', () => {
      assert.strictEqual(db._poolInt('APP_DATABASE_POOL_MAX', undefined, 10, 1), 10)
    })

    it('should take the config value, then let the env override it', () => {
      assert.strictEqual(db._poolInt('APP_DATABASE_POOL_MAX', 25, 10, 1), 25)

      process.env.APP_DATABASE_POOL_MAX = '40'
      assert.strictEqual(db._poolInt('APP_DATABASE_POOL_MAX', 25, 10, 1), 40, 'env wins over config')
    })

    it('should fall back to the default on an invalid or below-min value', () => {
      assert.strictEqual(db._poolInt('APP_DATABASE_POOL_MAX', 'lots', 10, 1), 10)
      assert.strictEqual(db._poolInt('APP_DATABASE_POOL_MAX', 0, 10, 1), 10, '0 is below the min of 1')
      assert.strictEqual(db._poolInt('APP_DATABASE_CONNECTION_TIMEOUT', 0, 10000, 0), 0, '0 is allowed when min is 0')
    })
  })

  describe('connection-level retry', () => {
    let _savedPool = null
    const _originalLog = logger.log

    beforeEach(() => {
      _savedPool = db._pool
      logger.log = () => {}
    })

    afterEach(() => {
      db._pool = _savedPool
      logger.log = _originalLog
    })

    /**
     * A pool whose connect() yields, per call, the query behaviour at that index
     * @param {Array} steps Each { connectErr } or { queryErr, rows }
     */
    function fakePool (steps) {
      let _i = 0

      return {
        connects: 0,
        connect: function (cb) {
          this.connects += 1
          const _step = steps[_i++] || steps[steps.length - 1]

          if (_step.connectErr) {
            return cb(_step.connectErr)
          }

          const _client = {
            query: (q, p, qcb) => qcb(_step.queryErr ?? null, { rows: _step.rows ?? [] })
          }

          return cb(null, _client, () => {})
        }
      }
    }

    it('should retry an idempotent read once on a mid-query connection error', (done) => {
      const _pool = fakePool([
        { queryErr: { code: 'ECONNRESET' } },
        { rows: [{ n: 1 }] }
      ])
      db._pool = _pool

      db.query('SELECT 1 AS n', (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows[0].n, 1)
        assert.strictEqual(_pool.connects, 2, 'the read ran again on a fresh connection')
        done()
      })
    })

    it('should NOT retry a write on a mid-query connection error', (done) => {
      const _pool = fakePool([{ queryErr: { code: 'ECONNRESET' } }])
      db._pool = _pool

      db.query('UPDATE t SET x = 1', (err) => {
        assert.strictEqual(err.code, 'ECONNRESET')
        assert.strictEqual(_pool.connects, 1, 'a write is never replayed')
        done()
      })
    })

    it('should NOT retry a non-connection error', (done) => {
      const _pool = fakePool([{ queryErr: { code: '23505' } }])
      db._pool = _pool

      db.query('SELECT 1', (err) => {
        assert.strictEqual(err.code, '23505')
        assert.strictEqual(_pool.connects, 1)
        done()
      })
    })

    it('should retry any query once when connect() itself fails', (done) => {
      // connect failed, so the query never ran — even a write is safe to retry
      const _pool = fakePool([
        { connectErr: { code: 'ECONNREFUSED' } },
        { rows: [] }
      ])
      db._pool = _pool

      db.query('UPDATE t SET x = 1', (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(_pool.connects, 2)
        done()
      })
    })

    it('should give up after a single retry', (done) => {
      const _pool = fakePool([{ queryErr: { code: 'ECONNRESET' } }])
      db._pool = _pool

      db.query('SELECT 1', (err) => {
        assert.strictEqual(err.code, 'ECONNRESET')
        assert.strictEqual(_pool.connects, 2, 'initial attempt plus one retry, then give up')
        done()
      })
    })
  })
})
