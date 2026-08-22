const assert = require('assert')
const validation = require('../lib/validation')
const server = require('../lib/server')
const expressCompat = require('../lib/expressCompat')

/**
 * Each case here was demonstrated against the framework before being fixed.
 */
describe('Security', () => {
  describe('ReDoS', () => {
    // The url regex this replaces took 196 seconds on a 128 character input
    const budgetMs = 250

    /**
     * Time one validation
     * @param {String} type Validator type
     * @param {String} payload Value to validate
     */
    function timeCheck (type, payload) {
      const _start = process.hrtime.bigint()

      validation.checkObject({ f: ['type', type] }, { f: payload })
      return Number(process.hrtime.bigint() - _start) / 1e6
    }

    it('should reject a crafted url without backtracking', () => {
      for (const size of [24, 64, 128, 512, 4096]) {
        const _ms = timeCheck('url', 'http://' + 'a'.repeat(size) + '!')

        assert.strictEqual(_ms < budgetMs, true, `${size} chars took ${_ms.toFixed(0)}ms`)
      }
    })

    it('should reject a crafted mail without backtracking', () => {
      for (const payload of ['a'.repeat(3000) + '!', 'a@' + 'b-.'.repeat(1000) + '!']) {
        const _ms = timeCheck('mail', payload)

        assert.strictEqual(_ms < budgetMs, true, `took ${_ms.toFixed(0)}ms`)
      }
    })
  })

  describe('url validation', () => {
    /**
     * Is this url accepted?
     * @param {String} url Url to check
     */
    function accepts (url) {
      return validation.checkObject({ f: ['type', 'url'] }, { f: url }).valid
    }

    it('should accept public urls', () => {
      for (const url of ['https://example.com', 'http://example.com/doc',
        'https://example.com:8443/a?b=1', 'ftp://files.example.com', 'https://8.8.8.8']) {
        assert.strictEqual(accepts(url), true, url)
      }
    })

    it('should reject private and link local addresses', () => {
      for (const url of ['http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1',
        'http://172.16.0.1', 'http://169.254.169.254']) {
        assert.strictEqual(accepts(url), false, url)
      }
    })

    it('should reject anything that is not an http url', () => {
      for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'notaurl',
        'http://', 'https://nodot', '']) {
        assert.strictEqual(accepts(url), false, url)
      }
    })
  })

  describe('names that collide with Object.prototype', () => {
    const converter = require('../lib/converter')
    const database = require('../lib/database')
    const cron = require('../lib/cron')
    const collisions = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']

    it('should map rows whose column is named after a prototype member', () => {
      const _model = ['array', { id: ['<<uid>>'], name: ['uname'] }]

      for (const _name of collisions) {
        const _rows = [{ uid: 1, uname: 'a' }]

        _rows[0][_name] = 'x'
        assert.deepStrictEqual(converter.sqlToJson(_model, _rows), [{ id: 1, name: 'a' }], _name)
      }
    })

    it('should not resolve an unknown SQL file to a prototype member', (done) => {
      // db.exec('toString') used to reach fs.stat with a function and crash
      database.exec('toString', {}, null, (err) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(err.message.includes('Unknow SQL file'), true, err.message)
        done()
      })
    })

    it('should let a cron be named after a prototype member', () => {
      assert.doesNotThrow(() => cron.add('toString', '* * * * *', () => {}))
      cron.destroyCrons()
    })
  })

  describe('header values', () => {
    const http = require('http')
    const restana = require('restana')
    const compat = require('../lib/expressCompat')

    it('should drop a header holding a newline instead of throwing', (done) => {
      const _service = restana({ securityHeaders: false, prioRequestsProcessing: false })

      _service.use(compat())
      // Set from a callback, where node's ERR_INVALID_CHAR used to kill the process
      _service.get('/hdr', (req, res) => setImmediate(() => res.set('x-thing', req.query.v).send('ok')))
      _service.get('/clean', (req, res) => res.set('x-thing', 'fine').send('ok'))

      const _server = http.createServer(_service)

      _server.listen(9807, () => {
        http.get({ port: 9807, path: '/hdr?v=' + encodeURIComponent('a\r\nX-Injected: 1') }, (res) => {
          res.resume()
          res.on('end', () => {
            assert.strictEqual(res.statusCode, 200)
            assert.strictEqual(res.headers['x-injected'], undefined, 'nothing may be injected')
            assert.strictEqual(res.headers['x-thing'], undefined, 'the bad header is dropped')

            http.get({ port: 9807, path: '/clean' }, (res2) => {
              res2.resume()
              res2.on('end', () => {
                assert.strictEqual(res2.headers['x-thing'], 'fine', 'valid headers still pass')
                _server.close(done)
              })
            })
          })
        })
      })
    }).timeout(10000)
  })

  describe('route param decoding', () => {
    it('should decode exactly once, so a double encoded traversal stays inert', () => {
      // Decoding twice would turn this into ../, which is the classic bypass
      const _req = { params: { p: '%252e%252e%252fetc%252fpasswd' } }

      assert.strictEqual(expressCompat.decodeParams(_req), true)
      assert.strictEqual(_req.params.p, '%2e%2e%2fetc%2fpasswd')
    })

    it('should refuse a malformed escape rather than pass the raw value on', () => {
      for (const _value of ['%foobar', '100%', '%G1', '%E0%A4%A']) {
        const _req = { params: { p: _value } }

        assert.strictEqual(expressCompat.decodeParams(_req), false, _value)
      }
    })

    it('should leave a value holding no escape untouched', () => {
      // Notably '+' stays a '+', which is why decodeURIComponent is the right
      // primitive and querystring.unescape is not
      const _req = { params: { a: 'foo+bar', b: '42', c: '' } }

      assert.strictEqual(expressCompat.decodeParams(_req), true)
      assert.deepStrictEqual(_req.params, { a: 'foo+bar', b: '42', c: '' })
    })

    it('should not touch anything when there are no params', () => {
      assert.strictEqual(expressCompat.decodeParams({ params: undefined }), true)
      assert.strictEqual(expressCompat.decodeParams({ params: null }), true)
      assert.strictEqual(expressCompat.decodeParams({}), true)
    })
  })

  describe('type confusion in validation', () => {
    it('should measure a declared string by length, even a numeric one', () => {
      // Without the type, a digits-only string is read as a number, so a phone
      // number or a postal code fails a length rule
      const _rule = { name: ['type', 'string', '<', 50, '>', 2] }

      for (const _value of ['John', '123', '0000', '0612345678']) {
        assert.strictEqual(validation.checkObject(_rule, { name: _value }).valid, true, _value)
      }
      for (const _value of ['ab', '1', 42]) {
        assert.strictEqual(validation.checkObject(_rule, { name: _value }).valid, false, String(_value))
      }
    })

    it('should keep guessing when no type is declared', () => {
      // A form posts an age as a string and the rule means its value
      assert.strictEqual(validation.checkObject({ age: ['>=', 18] }, { age: '42' }).valid, true)
      assert.strictEqual(validation.checkObject({ age: ['>=', 18] }, { age: '12' }).valid, false)
    })

    it('should measure an array by length whatever it holds', () => {
      const _rule = { list: ['>', 2] }

      assert.strictEqual(validation.checkObject(_rule, { list: [1, 2, 3] }).valid, true)
      // [5] is one element: it used to be read as the number 5 and pass
      assert.strictEqual(validation.checkObject(_rule, { list: [5] }).valid, false)
    })

    it('should keep comparing numbers by value', () => {
      const _rule = { age: ['>=', 0, '<', 130] }

      for (const _value of [0, 42, 129]) {
        assert.strictEqual(validation.checkObject(_rule, { age: _value }).valid, true, _value)
      }
      for (const _value of [-1, 130]) {
        assert.strictEqual(validation.checkObject(_rule, { age: _value }).valid, false, _value)
      }
    })

    it('should still accept a number where a length rule expects a string', () => {
      // A comparison rule does not say which type it is about, so pin it down
      const _rule = { name: ['<', 50, '>', 2] }

      assert.strictEqual(validation.checkObject(_rule, { name: 3 }).valid, true)
      assert.strictEqual(validation.checkObject({ name: ['type', 'string', '<', 50, '>', 2] }, { name: 3 }).valid, false)
    })

    it('should pin the type down when asked', () => {
      const _rule = { name: ['type', 'string', '<', 50, '>', 2] }

      assert.strictEqual(validation.checkObject(_rule, { name: 'John' }).valid, true)
      assert.strictEqual(validation.checkObject(_rule, { name: 3 }).valid, false)
      assert.strictEqual(validation.checkObject(_rule, { name: true }).valid, false)
    })

    it('should check number, integer and boolean', () => {
      const _cases = [
        ['number', 42, true], ['number', '42', false], ['number', NaN, false],
        ['integer', 4, true], ['integer', 4.2, false],
        ['boolean', true, true], ['boolean', 'true', false]
      ]

      for (const [type, value, expected] of _cases) {
        assert.strictEqual(validation.checkObject({ f: ['type', type] }, { f: value }).valid, expected,
          `${type} <- ${JSON.stringify(value)}`)
      }
    })
  })

  describe('identifier escaping', () => {
    it('should not let a table name break out of the TRUNCATE statement', (done) => {
      const datasets = require('../lib/datasets')
      const database = require('../lib/database')
      const _realExec = database.exec
      const _realQuery = database.query
      let _built = null

      // A table whose name carries a quote, which an attacker with DDL could create
      database.exec = (name, cb) => cb(null, {}, [{ table_name: 'a"; DROP SCHEMA public CASCADE; --' }])
      database.query = (q, cb) => { _built = q; return cb(null) }

      datasets.clean(() => {
        database.exec = _realExec
        database.query = _realQuery

        assert.strictEqual(_built.includes('DROP SCHEMA public CASCADE; --"'), true, _built)
        // The quote is doubled, so the payload stays inside the identifier
        assert.strictEqual(/TRUNCATE TABLE "a"";/.test(_built), true, _built)
        done()
      })
    })
  })

  describe('request timeout', () => {
    const net = require('net')
    const path = require('path')
    const fs = require('fs')
    const app = require('../lib/')
    const appPath = path.join(__dirname, 'datasets', 'myApp', 'server')

    afterEach((done) => {
      delete process.env.APP_REQUEST_TIMEOUT

      for (const f of ['index.js', 'test.test']) {
        const _p = path.join(appPath, f)

        if (fs.existsSync(_p)) {
          fs.unlinkSync(_p)
        }
      }

      if (server._server === null) {
        return done()
      }

      app.close(() => done())
    })

    it('should default to 60s rather than node\'s 300s', (done) => {
      fs.copyFileSync(path.join(__dirname, 'datasets', 'indexFiles', 'basicIndex.js'), path.join(appPath, 'index.js'))
      process.env.HEARTH_SERVER_PATH = appPath

      app.run('test', appPath, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(server._server.requestTimeout, 60000)
        assert.strictEqual(server._server.headersTimeout <= 60000, true)
        done()
      })
    }).timeout(20000)

    it('should hang up on a client that never finishes its request', (done) => {
      process.env.APP_REQUEST_TIMEOUT = '700'
      fs.copyFileSync(path.join(__dirname, 'datasets', 'indexFiles', 'basicIndex.js'), path.join(appPath, 'index.js'))
      process.env.HEARTH_SERVER_PATH = appPath

      app.run('test', appPath, (err) => {
        assert.strictEqual(err, null)

        const _start = Date.now()
        // Headers started but never terminated: the socket would be held for
        // node's default 300s without the timeout
        const _socket = net.connect(8080, '127.0.0.1', () => _socket.write('GET /user HTTP/1.1\r\nHost: x\r\n'))

        _socket.on('error', () => {})
        // Drain the 408 the server sends, otherwise close never fires
        _socket.resume()
        _socket.on('close', () => {
          const _elapsed = Date.now() - _start

          assert.strictEqual(_elapsed < 5000, true, `socket held for ${_elapsed}ms`)
          done()
        })
      })
    }).timeout(20000)
  })

  describe('error messages', () => {
    afterEach(() => { server._env = 'test' })

    it('should hide the detail of an Error in production', () => {
      server._env = 'prod'

      const _sent = {}
      const _res = {
        status: function (code) { _sent.code = code; return this },
        json: function (body) { _sent.body = body; return this }
      }

      server._handleError(new Error('relation "User" does not exist at /srv/app/x.sql'),
        { method: 'GET', url: '/x', headers: {} }, _res)

      assert.strictEqual(_sent.body.message, 'An error occured')
      assert.strictEqual(_sent.body.message.includes('/srv/app'), false)
    })

    it('should show the detail outside production', () => {
      server._env = 'dev'

      const _sent = {}
      const _res = {
        status: function (code) { _sent.code = code; return this },
        json: function (body) { _sent.body = body; return this }
      }

      server._handleError(new Error('a precise reason'), { method: 'GET', url: '/x', headers: {} }, _res)
      assert.strictEqual(_sent.body.message, 'a precise reason')
    })

    it('should always pass a message given to next() as a string', () => {
      server._env = 'prod'

      const _sent = {}
      const _res = {
        status: function (code) { _sent.code = code; return this },
        json: function (body) { _sent.body = body; return this }
      }

      server._handleError('You are not login', { method: 'GET', url: '/x', headers: {} }, _res)
      assert.strictEqual(_sent.body.message, 'You are not login')
    })

    it('should pass an Error explicitly marked as safe to expose', () => {
      server._env = 'prod'

      const _sent = {}
      const _res = {
        status: function (code) { _sent.code = code; return this },
        json: function (body) { _sent.body = body; return this }
      }
      const _err = new Error('Quota exceeded')

      _err.expose = true
      _err.code = 402

      server._handleError(_err, { method: 'GET', url: '/x', headers: {} }, _res)
      assert.strictEqual(_sent.body.message, 'Quota exceeded')
      assert.strictEqual(_sent.code, 402)
    })
  })
})
