const assert = require('assert')
const http = require('http')
const path = require('path')
const fs = require('fs')
const app = require('../lib/')
const server = require('../lib/server')
const logger = require('../lib/logger')
const cron = require('../lib/cron')
const migration = require('../lib/migration')

const appPath = path.join(__dirname, 'datasets', 'myApp', 'server')
const indexPath = path.join(appPath, 'index.js')

/**
 * Start the test application
 * @param {Function} callback
 */
function startApp (callback) {
  fs.copyFileSync(path.join(__dirname, 'datasets', 'indexFiles', 'basicIndex.js'), indexPath)
  process.env.HEARTH_SERVER_PATH = appPath
  app.run('test', process.env.HEARTH_SERVER_PATH, callback)
}

/**
 * Delete what startApp created
 */
function cleanApp () {
  for (const file of [indexPath, path.join(appPath, 'test.test'),
    path.join(appPath, 'logs', `${logger._getCurrentDateTime(false)}.log`)]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  }
}

/**
 * Every case here was reproduced as a real process crash before being fixed.
 * They all assert the same thing: the process survives and reports instead.
 */
describe('Crash safety', function () {
  this.timeout(30000)

  let _uncaught = []
  const _onUncaught = (err) => _uncaught.push(err)

  beforeEach(() => {
    _uncaught = []
    process.on('uncaughtException', _onUncaught)
  })

  afterEach((done) => {
    process.removeListener('uncaughtException', _onUncaught)

    if (server._server === null) {
      cleanApp()
      return done()
    }

    app.close(() => {
      cleanApp()
      done()
    })
  })

  describe('responding twice', () => {
    it('should ignore a second answer instead of throwing', (done) => {
      startApp((err) => {
        assert.strictEqual(err, null)

        http.get('http://localhost:8080/answer-twice', (res) => {
          res.resume()
          res.on('end', () => {
            assert.strictEqual(res.statusCode, 200)

            // The second answer lands after the response was sent
            setTimeout(() => {
              assert.deepStrictEqual(_uncaught, [], 'answering twice must not throw')
              done()
            }, 80)
          })
        }).on('error', (err) => assert.strictEqual(err, null))
      })
    })

    it('should ignore a header set after the answer', (done) => {
      startApp((err) => {
        assert.strictEqual(err, null)

        http.get('http://localhost:8080/header-too-late', (res) => {
          res.resume()
          res.on('end', () => {
            setTimeout(() => {
              assert.deepStrictEqual(_uncaught, [], 'a late setHeader must not throw')
              done()
            }, 80)
          })
        }).on('error', (err) => assert.strictEqual(err, null))
      })
    })
  })

  describe('unserializable body', () => {
    it('should answer 500 rather than throw from the callback', (done) => {
      startApp((err) => {
        assert.strictEqual(err, null)

        http.get('http://localhost:8080/circular-body', (res) => {
          let _body = ''

          res.on('data', (c) => { _body += c })
          res.on('end', () => {
            assert.strictEqual(res.statusCode, 500)
            assert.strictEqual(_body, '{"error":"Internal Server Error"}')
            assert.deepStrictEqual(_uncaught, [])
            done()
          })
        }).on('error', (err) => assert.strictEqual(err, null))
      })
    })
  })

  describe('port already in use', () => {
    it('should report EADDRINUSE through the callback', (done) => {
      const _blocker = http.createServer(() => {})

      _blocker.listen(8080, () => {
        startApp((err) => {
          assert.notStrictEqual(err, null)
          assert.strictEqual(err.code, 'EADDRINUSE')
          assert.deepStrictEqual(_uncaught, [])
          _blocker.close(done)
        })
      })
    })
  })

  describe('broken project files', () => {
    const brokenCron = path.join(appPath, 'cron', 'cron.broken.js')

    afterEach(() => {
      if (fs.existsSync(brokenCron)) {
        fs.unlinkSync(brokenCron)
      }
    })

    it('should report a cron file that does not parse', (done) => {
      fs.mkdirSync(path.join(appPath, 'cron'), { recursive: true })
      fs.writeFileSync(brokenCron, 'const x = { broken syntax\n')

      cron.loadCron((err) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(err.message.includes('cron.broken.js'), true, err.message)
        assert.deepStrictEqual(_uncaught, [])
        done()
      })
    })
  })

  describe('migration without a stored down script', () => {
    it('should report instead of reading a row that is not there', (done) => {
      const _realDatabase = migration._database

      migration._database = { query: (q, p, cb) => cb(null, { rows: [] }, []) }

      migration._execute({ filename: '999_down.sql', choice: '' }, () => {}, (err) => {
        migration._database = _realDatabase
        assert.notStrictEqual(err, null)
        assert.strictEqual(err.message.includes('No down script'), true, err.message)
        assert.deepStrictEqual(_uncaught, [])
        done()
      })
    })
  })

  describe('logging before the server started', () => {
    it('should not throw when no server path is set', () => {
      const _saved = process.env.HEARTH_SERVER_PATH

      delete process.env.HEARTH_SERVER_PATH
      logger._writeLogStream = null
      logger._currentDate = null

      assert.doesNotThrow(() => {
        logger.initLogger('test')
        logger.log('logged before run()', 'info')
      })

      process.env.HEARTH_SERVER_PATH = _saved
    })
  })
})
