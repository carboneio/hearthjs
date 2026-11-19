const app = require('../lib/')
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const http = require('http')
const logger = require('../lib/logger')
const TestClient = require('../lib/testClient')
const rock = require('rock-req')

describe('Test client', () => {
  before((done) => {
    process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'testClientApp', 'server')
    app.run('test', process.env.HEARTH_SERVER_PATH, done)
  })

  after((done) => {
    app.close(() => {
      const _logFile = path.join(__dirname, 'datasets', 'testClientApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

      if (fs.existsSync(_logFile)) {
        fs.unlinkSync(_logFile)
      }
      done()
    })
  })

  it('should not access authenticated route without login', (done) => {
    let user = new TestClient('test@test.fr', 'Nope')

    user.get('/test', (err, response, body) => {
      assert.strictEqual(err, null)
      assert.strictEqual(body.success, false)
      assert.strictEqual(body.message, 'You are not login')
      done()
    })
  })

  it('should login a user and access get /test and logout him', (done) => {
    let user = new TestClient('test@test.fr', 'Nope')

    user.login((err, response, body) => {
      assert.strictEqual(err, null)
      assert.strictEqual(body.success, true)
      assert.strictEqual(body.message, 'Connected')

      user.get('/test', (err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yeah get')

        user.logout((err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          assert.strictEqual(body.message, 'Disconnected')

          user.get('/test', (err, response, body) => {
            assert.strictEqual(err, null)
            assert.strictEqual(body.success, false)
            done()
          })
        })
      })
    })
  })

  it('should login a user and access get /test and ', (done) => {
    let user = new TestClient('test@test.fr', 'Nope')

    user.login((err, response, body) => {
      assert.strictEqual(err, null)
      assert.strictEqual(body.success, true)
      assert.strictEqual(body.message, 'Connected')

      user.get('/test', (err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yeah get')
        done()
      })
    })
  })

  it('should override login route', (done) => {
    let user = new TestClient('test@test.fr', 'Nope')

    user.login('/nope', (err) => {
      assert.notStrictEqual(err, null)
      done()
    })
  })

  describe('Keep session', () => {
    let user = new TestClient('test@test.fr', 'pass')
    let user2 = new TestClient('test@test.fr', 'pass')

    before((done) => {
      user.login((err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        user2.login((err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          done()
        })
      })
    })

    after((done) => {
      user.logout((err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        user2.logout((err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          done()
        })
      })
    })

    it('should get route for two users', (done) => {
      user.get('/test', (err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yeah get')
        user2.get('/test', (err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          assert.strictEqual(body.message, 'Yeah get')
          done()
        })
      })
    })

    it('should post route for two users', (done) => {
      user.post('/test', { data: 'toto' }, (err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yeah post toto')
        user2.post('/test', { data: 'tata' }, (err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          assert.strictEqual(body.message, 'Yeah post tata')
          done()
        })
      })
    })

    it('should put route for two users', (done) => {
      user.put('/test', { data: 'titi' }, (err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yeah put titi')
        user2.put('/test', { data: 'tutu' }, (err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          assert.strictEqual(body.message, 'Yeah put tutu')
          done()
        })
      })
    })

    it('should delete route for two users', (done) => {
      user.del('/test', (err, response, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yeah del')
        user2.del('/test', (err, response, body) => {
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          assert.strictEqual(body.message, 'Yeah del')
          done()
        })
      })
    })

    it('should execute an unwrapped request', (done) => {
      rock.get({
        url: user.getCompleteUrl('/test')
      }, (err, response, body) => {
        body = JSON.parse(body)
        assert.strictEqual(err, null)
        assert.strictEqual(body.success, false)
        rock.get({
          url: user.getCompleteUrl('/test'),
          headers: {
            Cookie: user.cookie
          }
        }, (err, response, body) => {
          body = JSON.parse(body)
          assert.strictEqual(err, null)
          assert.strictEqual(body.success, true)
          done()
        })
      })
    })
  })

  describe('Redirects', () => {
    it('should follow a redirect by default', (done) => {
      let user = new TestClient('test@test.fr', 'Nope')

      // /redirect -> /test; followed, so we land on /test's answer (400 here,
      // since /test refuses an unauthenticated caller). The point is that the
      // 302 was followed rather than surfaced.
      user.get('/redirect', (err, response, body) => {
        assert.strictEqual(err, null)
        assert.notStrictEqual(response.statusCode, 302, 'the 302 was followed, not returned')
        assert.strictEqual(body.success, false)
        assert.strictEqual(body.message, 'You are not login', 'we reached /test')
        done()
      })
    })

    it('should stop on the 3xx and expose the Location with followRedirect false', (done) => {
      let user = new TestClient('test@test.fr', 'Nope', { followRedirect: false })

      user.get('/redirect', (err, response) => {
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 302, 'the redirect is not followed')
        assert.strictEqual(response.headers.location, '/test', 'the Location header is available')
        done()
      })
    })

    it('should let the followRedirect flag be flipped on an existing client', (done) => {
      let user = new TestClient('test@test.fr', 'Nope')

      user.followRedirect = false
      user.get('/redirect', (err, response) => {
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 302)

        user.followRedirect = true
        user.get('/redirect', (err, response, body) => {
          assert.strictEqual(err, null)
          assert.notStrictEqual(response.statusCode, 302, 'now followed')
          assert.strictEqual(body.success, false)
          done()
        })
      })
    })
  })

  // A test must see what the server answered: a retry would hide a 503, a
  // dropped connection, or replay a POST the server already applied
  describe('No retry', () => {
    const hits = []
    let raw = null

    before((done) => {
      raw = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`)
        req.resume()
        req.on('end', () => {
          if (req.url === '/reset') {
            return req.socket.destroy()
          }
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"success":false}')
        })
      }).listen(0, done)
    })

    after((done) => {
      raw.close(done)
    })

    beforeEach(() => {
      hits.length = 0
    })

    const client = () => {
      const _user = new TestClient('test@test.fr', 'Nope')
      _user.getCompleteUrl = (route) => `http://localhost:${raw.address().port}${route}`
      return _user
    }

    it('should answer a 503 as is, after a single request', (done) => {
      client().post('/unavailable', { a: 1 }, (err, response) => {
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 503)
        assert.deepStrictEqual(hits, ['POST /unavailable'])
        done()
      })
    })

    it('should report a dropped connection, never replaying the POST', (done) => {
      client().post('/reset', { a: 1 }, (err) => {
        assert.strictEqual(err.code, 'ECONNRESET')
        assert.deepStrictEqual(hits, ['POST /reset'])
        done()
      })
    })

    it('should ignore what an app sets on the shared rock-req defaults', (done) => {
      const _saved = { maxRetry: rock.defaults.maxRetry, beforeRequest: rock.defaults.beforeRequest }
      rock.defaults.maxRetry = 3
      rock.defaults.beforeRequest = () => { throw new Error('shared beforeRequest used') }

      client().get('/unavailable', (err, response) => {
        Object.assign(rock.defaults, _saved)
        assert.strictEqual(err, null)
        assert.strictEqual(response.statusCode, 503)
        assert.deepStrictEqual(hits, ['GET /unavailable'])
        done()
      })
    })
  })
})
