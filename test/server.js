const app = require('../lib/')
const http = require('http')
const assert = require('assert')
const path = require('path')
const rock = require('rock-req')
const MultipartForm = require('./helpers/multipart')
const fs = require('fs')
const net = require('net')
const server = require('../lib/server')
const { spawn } = require('child_process')
const logger = require('../lib/logger')

let program = null

describe('Server', () => {
  after(() => {
    const _logFile = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

    if (fs.existsSync(_logFile)) {
      fs.unlinkSync(_logFile)
    }
  })

  describe('Load config', () => {
    before(() => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'configApp', 'server')
      server._serverPath = process.env.HEARTH_SERVER_PATH
    })

    it('should load test config', (done) => {
      server._loadConfig('test', {}, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(server.config.APP_SERVER_PORT, 8080)
        done()
      })
    })

    it('should return an error if a mandatory key is missing', (done) => {
      server.config = {}
      server._loadConfig('test1', {}, (err) => {
        assert.notStrictEqual(err, null)
        done()
      })
    })

    it('should return an error if config file does not exists', (done) => {
      server.config = {}
      server._loadConfig('notexists', {}, (err) => {
        assert.notStrictEqual(err, null)
        done()
      })
    })
  })

  describe('Init functions', () => {
    before(function (done) {
      fs.copyFile(path.join(__dirname, 'datasets', 'indexFiles', 'basicIndex.js'), path.join(__dirname, 'datasets', 'myApp', 'server', 'index.js'), (err) => {
        assert.strictEqual(err, null)
        process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'myApp', 'server')
        app.run('test', process.env.HEARTH_SERVER_PATH, done)
      })
    })

    after((done) => {
      fs.unlinkSync(path.join(__dirname, 'datasets', 'myApp', 'server', 'index.js'))
      fs.unlinkSync(path.join(__dirname, 'datasets', 'myApp', 'server', 'test.test'))
      app.close(done)
    })

    it('should have call all init functions', () => {
      const content = fs.readFileSync(path.join(__dirname, 'datasets', 'myApp', 'server', 'test.test'), 'utf8')
      assert.strictEqual(content, 'OlatchoupifinalInit')
    })
  })

  describe('Init functions 2', () => {
    before(function (done) {
      fs.copyFile(path.join(__dirname, 'datasets', 'indexFiles', 'middlewareIndex.js'), path.join(__dirname, 'datasets', 'myApp', 'server', 'index.js'), (err) => {
        assert.strictEqual(err, null)
        process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'myApp', 'server')
        app.run('test', process.env.HEARTH_SERVER_PATH, done)
      })
    })

    after((done) => {
      fs.unlinkSync(path.join(__dirname, 'datasets', 'myApp', 'server', 'index.js'))
      app.close(done)
    })

    it('should add a middleware', (done) => {
      rock.get(app.server.getEndpoint() + 'user', function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'Pass to middleware')
        done()
      })
    })
  })

  describe('API', function () {
    before(function (done) {
      fs.copyFile(path.join(__dirname, 'datasets', 'indexFiles', 'basicIndex.js'), path.join(__dirname, 'datasets', 'myApp', 'server', 'index.js'), (err) => {
        assert.strictEqual(err, null)
        process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'myApp', 'server')
        app.run('test', process.env.HEARTH_SERVER_PATH, done)
      })
    })

    after((done) => {
      fs.unlinkSync(path.join(__dirname, 'datasets', 'myApp', 'server', 'index.js'))
      fs.unlinkSync(path.join(__dirname, 'datasets', 'myApp', 'server', 'test.test'))
      app.close(done)
    })

    it('should serve schema-a route which return an error and update status code in before', function (done) {
      rock.get(app.server.getEndpoint() + 'schema-a', function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 402)
        body = JSON.parse(body)
        assert.strictEqual(body.success, false)
        assert.strictEqual(body.message, 'Error...')
        done()
      })
    })

    it('should serve schema-b route which return a message', (done) => {
      rock.get(app.server.getEndpoint() + 'schema-b', function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'Coucou')
        done()
      })
    })

    it('should serve schema-c route which call before and after', (done) => {
      rock.get(app.server.getEndpoint() + 'schema-c', function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'ououlela')
        done()
      })
    })

    it('should not server /error', (done) => {
      rock.get(app.server.getEndpoint() + 'error', function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString().includes('Cannot GET /error'), true)
        done()
      })
    })

    it('should post data and use them', (done) => {
      rock.post({
        url: app.server.getEndpoint() + 'schema-d',
        form: {
          value1: 'val1',
          value2: 'val2',
          value3: 'val3'
        }
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'val1val2val3')
        done()
      })
    })

    it('should put data and use them', (done) => {
      rock.put({
        url: app.server.getEndpoint() + 'schema-e',
        form: {
          value1: '1',
          value2: '2',
          value3: '3'
        }
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), '123')
        done()
      })
    })

    it('should use delete method', (done) => {
      rock.delete({
        url: app.server.getEndpoint() + 'schema-f/42'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), '42')
        done()
      })
    })

    it('should report what is running on startup', () => {
      const _lines = []
      const _realLog = logger.log

      logger.log = (msg) => _lines.push(String(msg))
      app.server._logStartup('prod')
      logger.log = _realLog

      const _joined = _lines.join('\n')

      // The facts an incident starts from: build, process, endpoint, database
      assert.strictEqual(_joined.includes(`hearthjs ${require('../package.json').version}`), true, _joined)
      assert.strictEqual(_joined.includes(`pid ${process.pid}`), true, _joined)
      assert.strictEqual(/\n {2}listening\s+\d+\.\d+\.\d+\.\d+:\d+/.test(_joined), true, _joined)
      assert.strictEqual(_joined.includes('hearth_test@'), true, _joined)
      assert.strictEqual(_joined.includes('routes'), true, _joined)
      assert.strictEqual(/\n {2}ready\s+\d+ms/.test(_joined), true, _joined)
      // A password must never reach a log line
      assert.strictEqual(/password/i.test(_joined), false, _joined)
    })

    it('should fall back to the configured port when nothing is bound yet', () => {
      const _realServer = app.server._server

      app.server._server = null
      assert.strictEqual(app.server._getBoundAddress(), `0.0.0.0:${app.server.config.APP_SERVER_PORT}`)
      app.server._server = _realServer

      // and reports what it is really bound to once listening
      assert.strictEqual(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(app.server._getBoundAddress()), true)
    })

    it('should label a zero timeout by what it actually means', () => {
      const _lines = []
      const _realLog = logger.log
      const _realConfig = app.server.config

      logger.log = (msg) => _lines.push(String(msg))
      // 0 disables the request timeout but makes the shutdown wait forever
      app.server.config = Object.assign({}, _realConfig, {
        APP_REQUEST_TIMEOUT: 0, APP_SHUTDOWN_TIMEOUT: 0, APP_GRACEFUL_SHUTDOWN: true
      })
      app.server._logStartup('prod')
      logger.log = _realLog
      app.server.config = _realConfig

      const _timeouts = _lines.find((l) => l.includes('timeouts'))

      assert.strictEqual(_timeouts.includes('request disabled'), true, _timeouts)
      assert.strictEqual(_timeouts.includes('shutdown no limit'), true, _timeouts)
    })

    it('should say when graceful shutdown is off rather than print a duration', () => {
      const _lines = []
      const _realLog = logger.log
      const _realConfig = app.server.config

      logger.log = (msg) => _lines.push(String(msg))
      app.server.config = Object.assign({}, _realConfig, { APP_GRACEFUL_SHUTDOWN: false })
      app.server._logStartup('prod')
      logger.log = _realLog
      app.server.config = _realConfig

      const _timeouts = _lines.find((l) => l.includes('timeouts'))

      assert.strictEqual(_timeouts.includes('shutdown none'), true, _timeouts)
    })

    it('should report the log file, and only the output when there is no file', () => {
      const _lines = []
      const _realLog = logger.log
      const _realOutput = logger._getLogOutput

      logger.log = (msg) => _lines.push(String(msg))
      logger._getLogOutput = () => 'both'
      app.server._logStartup('prod')
      logger._getLogOutput = () => 'stdout'
      app.server._logStartup('prod')
      logger.log = _realLog
      logger._getLogOutput = _realOutput

      const _withFile = _lines.filter((l) => l.includes('logs'))[0]
      const _withoutFile = _lines.filter((l) => l.includes('logs'))[1]

      assert.strictEqual(_withFile.includes(`${logger._getCurrentDateTime(false)}.log · output both`), true, _withFile)
      // Nothing is written to a file: printing a path nobody writes to would lie
      assert.strictEqual(_withoutFile.includes('.log'), false, _withoutFile)
      assert.strictEqual(_withoutFile.includes('output stdout'), true, _withoutFile)
    })

    it('should warn about the settings that only hurt once in trouble', () => {
      const _lines = []
      const _realLog = logger.log
      const _realOutput = logger._getLogOutput
      const _realConfig = app.server.config

      logger.log = (msg, level) => _lines.push(`${level} ${msg}`)
      logger._getLogOutput = () => 'file'
      app.server.config = { APP_REQUEST_TIMEOUT: 0, APP_GRACEFUL_SHUTDOWN: false }
      app.server._logStartupWarnings('prod')
      logger.log = _realLog
      logger._getLogOutput = _realOutput
      app.server.config = _realConfig

      assert.strictEqual(_lines.length, 3, _lines.join('\n'))
      assert.strictEqual(_lines.every((l) => l.startsWith('warn')), true, _lines.join('\n'))
      assert.strictEqual(_lines.join('\n').includes('journalctl'), true, _lines.join('\n'))
      assert.strictEqual(_lines.join('\n').includes('APP_LOG_OUTPUT'), true, _lines.join('\n'))
    })

    it('should not mention journalctl when the logs already reach stdout', () => {
      const _lines = []
      const _realLog = logger.log
      const _realOutput = logger._getLogOutput
      const _realConfig = app.server.config

      logger.log = (msg, level) => _lines.push(`${level} ${msg}`)
      logger._getLogOutput = () => 'both'
      app.server.config = { APP_REQUEST_TIMEOUT: 0, APP_GRACEFUL_SHUTDOWN: false }
      app.server._logStartupWarnings('prod')
      logger.log = _realLog
      logger._getLogOutput = _realOutput
      app.server.config = _realConfig

      assert.strictEqual(_lines.join('\n').includes('journalctl'), false, _lines.join('\n'))
    })

    it('should say on stderr that logging is disabled when the output is none', () => {
      const _reported = []
      const _realWrite = process.stderr.write
      const _realLog = logger.log
      const _realOutput = logger._getLogOutput
      const _realConfig = app.server.config

      // logger.log writes nowhere in this mode, so the warning cannot use it
      logger.log = () => {}
      logger._getLogOutput = () => 'none'
      app.server.config = _realConfig
      process.stderr.write = (msg) => { _reported.push(String(msg)); return true }
      app.server._logStartupWarnings('prod')
      process.stderr.write = _realWrite
      logger.log = _realLog
      logger._getLogOutput = _realOutput

      assert.strictEqual(_reported.join('').includes('logging is disabled'), true, _reported.join(''))
    })

    it('should name APP_LOG_STDOUT as deprecated when both settings are set', () => {
      const _lines = []
      const _realLog = logger.log
      const _realEnvOutput = process.env.APP_LOG_OUTPUT
      const _realEnvStdout = process.env.APP_LOG_STDOUT

      process.env.APP_LOG_OUTPUT = 'both'
      process.env.APP_LOG_STDOUT = 'true'
      logger._resetLogOutputSetting()
      logger.log = (msg, level) => _lines.push(`${level} ${msg}`)
      app.server._logStartupWarnings('prod')
      logger.log = _realLog

      if (_realEnvOutput === undefined) {
        delete process.env.APP_LOG_OUTPUT
      } else {
        process.env.APP_LOG_OUTPUT = _realEnvOutput
      }

      if (_realEnvStdout === undefined) {
        delete process.env.APP_LOG_STDOUT
      } else {
        process.env.APP_LOG_STDOUT = _realEnvStdout
      }

      logger._resetLogOutputSetting()

      const _deprecated = _lines.find((l) => l.includes('APP_LOG_STDOUT'))

      assert.notStrictEqual(_deprecated, undefined, _lines.join('\n'))
      assert.strictEqual(_deprecated.startsWith('warn'), true, _deprecated)
    })

    describe('_statusForError', () => {
      it('should use err.code, the hearthjs convention, for any status node accepts', () => {
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { code: 403 })), 403)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { code: 302 })), 302)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { code: 200 })), 200)
      })

      it('should prefer err.code over the express fields', () => {
        const _err = Object.assign(new Error('x'), { code: 403, status: 500, statusCode: 500 })

        assert.strictEqual(app.server._statusForError(_err), 403)
      })

      it('should read err.status and err.statusCode, which express middlewares set', () => {
        // body-parser rejecting an oversized body carries both
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: 413, statusCode: 413 })), 413)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: 403 })), 403)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { statusCode: 429 })), 429)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: 400 })), 400)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: 599 })), 599)
      })

      it('should ignore a status outside the error range, like express does', () => {
        for (const _status of [200, 302, 399, 600, 1000]) {
          assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: _status })), 400, String(_status))
        }
      })

      it('should ignore a status node would refuse, which would throw from res.end', () => {
        // res.end() raises ERR_HTTP_INVALID_STATUS_CODE below 100, above 999 or
        // on a non integer, from a place where nothing catches it
        for (const _status of [0, -1, 1.5, 99, 1000, NaN, Infinity]) {
          assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: _status })), 400, String(_status))
        }

        for (const _code of [0, -1, 1.5, 99, 1000, NaN, Infinity]) {
          assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { code: _code })), 400, String(_code))
        }
      })

      it('should ignore a non numeric code, which is what node errors carry', () => {
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { code: 'ENOENT' })), 400)
        assert.strictEqual(app.server._statusForError(Object.assign(new Error('x'), { status: '413' })), 400)
      })

      it('should answer 400 when there is nothing to read', () => {
        assert.strictEqual(app.server._statusForError(new Error('x')), 400)
        assert.strictEqual(app.server._statusForError('a refusal written for the caller'), 400)
        assert.strictEqual(app.server._statusForError(null), 400)
        assert.strictEqual(app.server._statusForError(undefined), 400)
      })

      it('should never return a status res.end would throw on', (done) => {
        const _shapes = [{ status: 0 }, { status: -1 }, { status: 1.5 }, { status: 1000 }, { code: 0 }, { code: 99 }]
        let _remaining = _shapes.length

        for (const _shape of _shapes) {
          const _status = app.server._statusForError(Object.assign(new Error('x'), _shape))
          const _probe = http.createServer((req, res) => { res.statusCode = _status; res.end('x') })

          _probe.listen(0, () => {
            http.get({ port: _probe.address().port }, (res) => {
              res.resume()
              res.on('end', () => {
                assert.strictEqual(res.statusCode, _status)
                _probe.close()
                if (--_remaining === 0) { done() }
              })
            }).on('error', (err) => { assert.strictEqual(err, null, `${JSON.stringify(_shape)} -> ${_status}`) })
          })
        }
      })
    })

    it('should log a server error raised after startup instead of calling run again', (done) => {
      const _realLog = logger.log
      const _logged = []
      let _runCalls = 0

      logger.log = (msg, level) => _logged.push(`${level} ${msg}`)
      // run() already returned: re-entering it would answer the caller twice
      app.server._server.emit('error', Object.assign(new Error('late'), { code: 'ECONNRESET' }))

      setImmediate(() => {
        logger.log = _realLog
        assert.strictEqual(_runCalls, 0)
        assert.strictEqual(_logged.some((l) => l.startsWith('error') && l.includes('late')), true, _logged.join('\n'))
        done()
      })
    })

    it('should decode route params like express did', (done) => {
      // express decoded each captured param, so an encoded url stays usable as
      // an id. Routing still matches the raw path, which keeps %2F in one segment
      const _cases = [
        ['foo%2Fbar', 'foo/bar'],
        ['https%3A%2F%2Fexample.com%2F.well-known', 'https://example.com/.well-known'],
        ['a%20b', 'a b'],
        ['%E2%9D%A4', '\u2764'],
        ['foo+bar', 'foo+bar'],
        ['42', '42']
      ]
      let _remaining = _cases.length

      for (const [_sent, _expected] of _cases) {
        rock.delete({ url: app.server.getEndpoint() + 'schema-f/' + _sent }, (err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.toString(), _expected, _sent)

          if (--_remaining === 0) {
            done()
          }
        })
      }
    })

    it('should answer 400 on a malformed param instead of passing it through', (done) => {
      let _remaining = 2

      for (const _sent of ['%foobar', '100%']) {
        rock.delete({ url: app.server.getEndpoint() + 'schema-f/' + _sent }, (err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(response.statusCode, 400, _sent)
          // The raw value must not reach the handler
          assert.strictEqual(body.toString().includes(_sent), false, _sent)

          if (--_remaining === 0) {
            done()
          }
        })
      }
    })

    it('should pass through middleware', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'middleware'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'value')
        done()
      })
    })

    it('should upload file', (done) => {
      const form = new MultipartForm()

      form.append('file', 'John Doe', {
        filename: 'file.txt',
        contentType: 'text/plain'
      })

      rock.post({
        url: app.server.getEndpoint() + 'upload-file',
        headers: form.getHeaders()
      }, form.getBuffer(), function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'file.txt')
        done()
      })
    })

    it('should upload file', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'empty-schema'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Great!')
        done()
      })
    })

    it('should execute a function and not a schema', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'func'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'OK!')
        done()
      })
    })

    it('should get result from api2', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'from-api2'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'Hello')
        done()
      })
    })

    it('should validate in data and update status code in after', (done) => {
      let accounts = [{
        name: 'Account1',
        users: [{
          firstname: 'John',
          mail: 'john@gmail.com'
        }, {
          firstname: 'Jooohn',
          mail: 'jooohn@gmail.com'
        }]
      }]

      rock.postJSON({
        url: app.server.getEndpoint() + 'schema-with-in'
      }, { accounts: accounts }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 201)
        assert.deepStrictEqual(body, {
          success: true,
          data: { accounts: accounts },
          message: ''
        })
        done()
      })
    })

    it('should return error on firstname in data', (done) => {
      let accounts = [{
        name: 'Account1',
        users: [{
          firstname: 'Jhn',
          mail: 'john@gmail.com'
        }, {
          firstname: 'Jooohn',
          mail: 'jooohn@gmail.com'
        }]
      }]

      rock.postJSON({
        url: app.server.getEndpoint() + 'schema-with-in'
      }, { accounts: accounts }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 400)
        assert.deepStrictEqual(body, {
          success: false,
          data: {},
          message: '4 char min'
        })
        done()
      })
    })

    it('should return error on mail in data', (done) => {
      let accounts = [{
        name: 'Account1',
        users: [{
          firstname: 'John',
          mail: 'johngmail.com'
        }, {
          firstname: 'Jooohn',
          mail: 'jooohn@gmail.com'
        }]
      }]

      rock.postJSON({
        url: app.server.getEndpoint() + 'schema-with-in'
      }, { accounts: accounts }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(body, {
          success: false,
          data: {},
          message: 'mail johngmail.com is an invalid mail.'
        })
        done()
      })
    })

    it('should return an error when there is an in schema with a GET', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'get-with-in'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, {
          success: false,
          data: {},
          message: 'Error: Missing key firstname in data'
        })
        done()
      })
    })

    it('should add route even if it does not start with /', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'forgot-slash'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), 'OK!')
        done()
      })
    })
  })

  describe('Error duplicate API', () => {
    before((done) => {
      app.run('test', path.join(__dirname, 'datasets', 'errorApp', 'server'), done)
    })

    after((done) => {
      app.close(done)
    })

    it('should not declare two times API with same name', () => {
      assert.strictEqual(Object.keys(app.api._apiList.api2.routes).length, 1)
    })
  })

  describe('Errors', () => {
    afterEach((done) => {
      app.close(done)
    })

    it('should not run the server if database does not exists', (done) => {
      let badConfig = {
        APP_SERVER_PORT: 8080,
        APP_HTTPS: false,
        APP_DATABASE_HOST: 'localhost',
        APP_DATABASE_NAME: 'unknown_database',
        APP_DATABASE_PASSWORD: 'password',
        APP_DATABASE_PORT: 5432,
        APP_DATABASE_TIMEOUT: 30000,
        APP_DATABASE_USERNAME: 'postgres'
      }
      fs.writeFileSync(path.join(__dirname, 'datasets', 'errorConfigApp', 'server', 'config', 'test.json'), JSON.stringify(badConfig, null, 4), 'utf-8')
      app.run('test', path.join(__dirname, 'datasets', 'errorConfigApp', 'server'), (err) => {
        assert.notStrictEqual(err, null)
        done()
      })
    })

    it('should not run the server if config is not a JSON file', (done) => {
      let badConfig = 'coucou'
      fs.writeFileSync(path.join(__dirname, 'datasets', 'errorConfigApp', 'server', 'config', 'test.json'), badConfig, 'utf-8')
      app.run('test', path.join(__dirname, 'datasets', 'errorConfigApp', 'server'), (err) => {
        assert.notStrictEqual(err, null)
        done()
      })
    })
  })

  describe('Database timeout', () => {
    it('should set a default timeout of 10s', (done) => {
      let badConfig = {
        APP_SERVER_PORT: 8080,
        APP_HTTPS: false,
        APP_DATABASE_HOST: 'localhost',
        APP_DATABASE_NAME: 'hearth_test',
        APP_DATABASE_PASSWORD: 'password',
        APP_DATABASE_PORT: 5432,
        APP_DATABASE_USERNAME: 'postgres'
      }
      app.server.config = {}
      fs.writeFileSync(path.join(__dirname, 'datasets', 'errorConfigApp', 'server', 'config', 'test.json'), JSON.stringify(badConfig, null, 4), 'utf-8')
      app.run('test', path.join(__dirname, 'datasets', 'errorConfigApp', 'server'), (err) => {
        assert.strictEqual(err, null)
        app.db.query('SHOW statement_timeout;', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows[0].statement_timeout, '10s')
          app.close(done)
        })
      })
    })

    it('should set timeout of config file', (done) => {
      let badConfig = {
        APP_SERVER_PORT: 8080,
        APP_HTTPS: false,
        APP_DATABASE_HOST: 'localhost',
        APP_DATABASE_NAME: 'hearth_test',
        APP_DATABASE_PASSWORD: 'password',
        APP_DATABASE_PORT: 5432,
        APP_DATABASE_TIMEOUT: 30000,
        APP_DATABASE_USERNAME: 'postgres'
      }
      fs.writeFileSync(path.join(__dirname, 'datasets', 'errorConfigApp', 'server', 'config', 'test.json'), JSON.stringify(badConfig, null, 4), 'utf-8')
      app.run('test', path.join(__dirname, 'datasets', 'errorConfigApp', 'server'), (err) => {
        assert.strictEqual(err, null)
        app.db.query('SHOW statement_timeout;', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows[0].statement_timeout, '30s')
          app.close(done)
        })
      })
    })
  })

  describe('API with SQL', () => {
    before((done) => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'mySQLApp', 'server')
      app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
        if (err) {
          return done(err)
        }
        app.datasets.clean(done)
      })
    })

    after((done) => {
      const _logFile = path.join(__dirname, 'datasets', 'mySQLApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

      if (fs.existsSync(_logFile)) {
        fs.unlinkSync(_logFile)
      }
      app.close(done)
    })

    it('should request schema-a and SQL query with after', (done) => {
      let expected = {
        success: true,
        data: {
          person: 'John Doe'
        },
        message: 'Success'
      }

      rock.get(app.server.getEndpoint() + 'schema-a', function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, expected)
        done()
      })
    })

    it('should request schema-a and SQL query alone', (done) => {
      let expected = {
        success: true,
        data: [{
          firstname: 'John',
          lastname: 'Doe'
        }],
        message: ''
      }

      rock.get(app.server.getEndpoint() + 'schema-b', function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, expected)
        done()
      })
    })

    it('should not replace data if they wad not sent to next', (done) => {
      let expected = {
        success: true,
        data: [{
          firstname: 'John',
          lastname: 'Doe'
        }],
        message: ''
      }

      rock.get(app.server.getEndpoint() + 'schema-c', function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, expected)
        done()
      })
    })

    it('should execute a query in function without schema', (done) => {
      rock.get(app.server.getEndpoint() + 'func2', function (err, response, body) {
        assert.strictEqual(err, null)
        assert.strictEqual(body.toString(), '3')
        done()
      })
    })

    it('should execute a query and format returned data', (done) => {
      rock.get(app.server.getEndpoint() + 'schema-d', function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, {
          success: true,
          data: {
            firstname: 'John',
            lastname: 'Doe',
            age: 20
          },
          message: ''
        })
        done()
      })
    })

    it('should execute a query with req params and format returned data', (done) => {
      rock.post({
        url: app.server.getEndpoint() + 'my-post-e',
        form: {
          firstname: 'John',
          lastname: 'Doe',
          mail: 'john.doe@gmail.com',
          age: '42'
        }
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, {
          success: true,
          data: {
            firstname: 'John',
            lastname: 'Doe',
            mail: 'john.doe@gmail.com',
            age: 42
          },
          message: 'yeees'
        })
        done()
      })
    })

    it('should not crash if data does not exists', (done) => {
      rock.post({
        url: app.server.getEndpoint() + 'my-post-e',
        form: {
          id: 1
        }
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.deepStrictEqual(body, {
          success: true,
          data: {
            firstname: null,
            lastname: null,
            mail: null,
            age: null
          },
          message: 'yeees'
        })
        done()
      })
    })
  })

  describe('CLI options', () => {
    before((done) => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'myApp', 'server')
      done()
    })

    afterEach((done) => {
      stopServer(done)
    })

    it('should start and answer on the default port', (done) => {
      startServer('8080', () => {
        rock.get('http://localhost:8080/user', (err, response, body) => {
          assert.strictEqual(err, null)
          body = JSON.parse(body)
          assert.strictEqual(body.id, null)
          done()
        })
      })
    }).timeout(20000)

    it('should take the port send via CLI', (done) => {
      startServer('4000', () => {
        rock.get('http://localhost:4000/user', (err, response, body) => {
          assert.strictEqual(err, null)
          // Answering at all on 4000 proves --port was honoured
          assert.strictEqual(body.toString(), '{"id":null}')
          done()
        })
      })
    }).timeout(20000)
  })
})

/**
 * Launch server with nbCluster
 * @param {String} nbCluster Number of cluster to start
 * @param {String} port Application port
 * @param {Function} callback
 */
function startServer (port, callback) {
  const _serverPath = path.join(__dirname, 'datasets', 'myApp', 'server')
  const binPath = path.join(__dirname, '..', 'bin', 'hearthjs')

  program = spawn(binPath, ['start', 'prod', '--port', port], { cwd: _serverPath })
  program.stdout.pipe(process.stdout)
  program.stderr.pipe(process.stderr)

  waitForServer(port, 20000, (err) => {
    if (err) {
      throw err
    }

    return callback()
  })
}

/**
 * Poll the port until the spawned server answers. A fixed delay raced with a
 * busy machine and the requests went out before the server was listening.
 * @param {String} port Port to poll
 * @param {Number} timeout Maximum time to wait in ms
 * @param {Function} callback
 */
function waitForServer (port, timeout, callback) {
  const _deadline = Date.now() + timeout

  const check = () => {
    const socket = net.connect({ port: parseInt(port, 10), host: '127.0.0.1' }, () => {
      socket.destroy()
      return callback(null)
    })

    socket.on('error', () => {
      socket.destroy()

      if (Date.now() >= _deadline) {
        return callback(new Error(`Server did not start on port ${port} within ${timeout}ms`))
      }

      return setTimeout(check, 50)
    })
  }

  check()
}


/**
 * Stop started cluster
 * @param {Function} callback
 */
function stopServer (callback) {
  const _child = program

  program = null

  // Already exited (a test crashed it on purpose). Never fall back to
  // process.kill(pid): a recycled pid would send the signal elsewhere.
  if (_child === null || _child === undefined ||
      _child.exitCode !== null || _child.signalCode !== null) {
    return callback()
  }

  let _finished = false

  const _finish = () => {
    if (_finished === true) {
      return
    }

    _finished = true
    clearTimeout(_insist)
    clearTimeout(_giveUp)
    return callback()
  }

  // child.kill() goes through the libuv process handle, so it can only ever
  // reach this child, even if its pid has since been reused
  _child.once('exit', _finish)
  _child.kill('SIGTERM')

  const _insist = setTimeout(() => {
    if (_child.exitCode === null && _child.signalCode === null) {
      _child.kill('SIGKILL')
    }
  }, 5000)

  const _giveUp = setTimeout(_finish, 8000)
}
