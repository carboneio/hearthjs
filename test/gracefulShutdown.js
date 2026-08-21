const assert = require('assert')
const http = require('http')
const path = require('path')
const fs = require('fs')
const app = require('../lib/')
const server = require('../lib/server')
const logger = require('../lib/logger')

const appPath = path.join(__dirname, 'datasets', 'myApp', 'server')
const indexPath = path.join(appPath, 'index.js')

/**
 * Remove the log file the test server wrote
 */
function cleanLogs () {
  const _logFile = path.join(appPath, 'logs', `${logger._getCurrentDateTime(false)}.log`)

  if (fs.existsSync(_logFile)) {
    fs.unlinkSync(_logFile)
  }
}

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
 * Remove what startApp created
 */
function cleanApp () {
  for (const file of [indexPath, path.join(appPath, 'test.test')]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  }

  cleanLogs()
}

describe('Graceful shutdown', function () {
  this.timeout(30000)

  afterEach((done) => {
    delete process.env.APP_SHUTDOWN_TIMEOUT
    delete process.env.APP_GRACEFUL_SHUTDOWN

    // Whatever the test did, leave nothing listening behind
    if (server._server === null) {
      cleanApp()
      return done()
    }

    app.close(() => {
      cleanApp()
      done()
    })
  })

  it('should finish a request that is already being served', (done) => {
    startApp((err) => {
      assert.strictEqual(err, null)

      // The response and the close callback can land in either order, wait for
      // both rather than assuming one happens first
      let _pending = 2
      let _requestResult = null

      const _maybeDone = () => {
        _pending -= 1

        if (_pending > 0) {
          return
        }

        assert.notStrictEqual(_requestResult, null, 'the in-flight request was never answered')
        assert.strictEqual(_requestResult.statusCode, 200)
        assert.strictEqual(_requestResult.body, 'finished')
        return done()
      }

      // /slow-shutdown holds the response open, close() must wait for it
      const req = http.get('http://localhost:8080/slow-shutdown', (res) => {
        let _body = ''

        res.on('data', (chunk) => { _body += chunk })
        res.on('end', () => {
          _requestResult = { statusCode: res.statusCode, body: _body }
          _maybeDone()
        })
      })

      req.on('error', (err) => assert.strictEqual(err, null))

      // The handler tells us when it has the request, so there is nothing to guess
      process.once('test:slow-shutdown-received', () => {
        app.close((err) => {
          assert.strictEqual(err, null)
          _maybeDone()
        })

        // close() is now draining: release the handler and check it still answers
        process.emit('test:release-slow-shutdown')
      })
    })
  })

  it('should stop accepting new connections once closing', (done) => {
    startApp((err) => {
      assert.strictEqual(err, null)

      app.close((err) => {
        assert.strictEqual(err, null)

        const req = http.get('http://localhost:8080/user', () => {
          assert.strictEqual(true, false, 'the server should not answer any more')
        })

        req.on('error', (err) => {
          assert.strictEqual(err.code, 'ECONNREFUSED')
          done()
        })
      })
    })
  })

  it('should not hang on an idle keep-alive connection', (done) => {
    startApp((err) => {
      assert.strictEqual(err, null)

      // A pooled connection left open, exactly what a load balancer keeps around
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

      http.get({ port: 8080, path: '/user', agent }, (res) => {
        res.resume()
        res.on('end', () => {
          // The socket is now idle but still open: close() used to wait for it
          const _start = Date.now()

          app.close((err) => {
            const _elapsed = Date.now() - _start

            assert.strictEqual(err, null)
            assert.strictEqual(_elapsed < 5000, true, `close took ${_elapsed}ms, it waited for the idle socket`)
            agent.destroy()
            done()
          })
        })
      }).on('error', (err) => assert.strictEqual(err, null))
    })
  })

  it('should tell clients to close the connection while draining', (done) => {
    startApp((err) => {
      assert.strictEqual(err, null)

      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

      // First request: normal keep-alive
      http.get({ port: 8080, path: '/user', agent }, (res) => {
        res.resume()
        res.on('end', () => {
          server._draining = true

          http.get({ port: 8080, path: '/user', agent }, (res2) => {
            res2.resume()
            res2.on('end', () => {
              assert.strictEqual(res2.headers.connection, 'close')
              server._draining = false
              agent.destroy()
              done()
            })
          }).on('error', (err) => assert.strictEqual(err, null))
        })
      }).on('error', (err) => assert.strictEqual(err, null))
    })
  })

  it('should be idempotent when close is called twice', (done) => {
    startApp((err) => {
      assert.strictEqual(err, null)

      let _first = false

      app.close((err) => {
        assert.strictEqual(err, null)
        _first = true
      })

      // Called while the first close is still running: must not start a second
      app.close((err) => {
        assert.strictEqual(err, null)

        assert.strictEqual(_first, true, 'both callbacks must run')
        assert.strictEqual(server._server, null)
        done()
      })
    })
  })

  it('should close without a running server', (done) => {
    // close() on a server that never listened must not throw
    app.close((err) => {
      assert.strictEqual(err, null)
      done()
    })
  })

  it('should force the remaining connections after the timeout', (done) => {
    process.env.APP_SHUTDOWN_TIMEOUT = '300'

    startApp((err) => {
      assert.strictEqual(err, null)

      // This route never answers, so only the force close can end the shutdown
      const req = http.get('http://localhost:8080/never-answers', () => {})

      req.on('error', () => {}) // the socket gets destroyed, that is the point

      // Only start closing once the request is genuinely stuck in the handler
      process.once('test:never-answers-received', () => {
        const _start = Date.now()

        app.close((err) => {
          const _elapsed = Date.now() - _start

          assert.strictEqual(err, null)
          // It must not wait for the stuck request, but must respect the timeout
          assert.strictEqual(_elapsed >= 200, true, `closed after ${_elapsed}ms, before the timeout`)
          assert.strictEqual(_elapsed < 5000, true, `closed after ${_elapsed}ms, it waited for the stuck request`)
          done()
        })
      })
    })
  })

  describe('configuration', () => {
    it('should read the timeout from the environment', () => {
      process.env.APP_SHUTDOWN_TIMEOUT = '1234'
      assert.strictEqual(server._getShutdownTimeout(), 1234)
    })

    it('should fall back to the default for a bad timeout', () => {
      process.env.APP_SHUTDOWN_TIMEOUT = 'not-a-number'
      assert.strictEqual(server._getShutdownTimeout(), 10000)
    })

    it('should accept 0 to wait indefinitely', () => {
      process.env.APP_SHUTDOWN_TIMEOUT = '0'
      assert.strictEqual(server._getShutdownTimeout(), 0)
    })

    it('should be enabled by default and disabled by APP_GRACEFUL_SHUTDOWN', () => {
      assert.strictEqual(server._isGracefulShutdownEnabled(), true)
      process.env.APP_GRACEFUL_SHUTDOWN = 'false'
      assert.strictEqual(server._isGracefulShutdownEnabled(), false)
      process.env.APP_GRACEFUL_SHUTDOWN = 'true'
      assert.strictEqual(server._isGracefulShutdownEnabled(), true)
    })
  })

  describe('signal handlers', () => {
    it('should install handlers while running and remove them on close', (done) => {
      const _before = process.listenerCount('SIGTERM')

      startApp((err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(process.listenerCount('SIGTERM'), _before + 1)

        app.close((err) => {
          assert.strictEqual(err, null)
          assert.strictEqual(process.listenerCount('SIGTERM'), _before,
            'the handler must be removed, otherwise listeners pile up')
          done()
        })
      })
    })

    it('should not install handlers when disabled', (done) => {
      process.env.APP_GRACEFUL_SHUTDOWN = 'false'

      const _before = process.listenerCount('SIGTERM')

      startApp((err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(process.listenerCount('SIGTERM'), _before)
        done()
      })
    })
  })
})
