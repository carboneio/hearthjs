const logger = require('../lib/logger')
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const net = require('net')
const sinon = require('sinon')
const mockdate = require('mockdate')
const app = require('../lib/')
const rock = require('rock-req')
const { spawn } = require('child_process')

let program = null

/**
 * Read the log file until it holds what the test waits for. The log stream
 * flushes after the response ends, so reading straight away is a race.
 * @param {String} filePath Log file to read
 * @param {Function} predicate Receives the content, returns true when ready
 * @param {Function} callback Receives the content
 */
function waitForLog (filePath, predicate, callback) {
  let _attempts = 0

  const _check = () => {
    const _content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''

    if (predicate(_content) === true || ++_attempts > 300) {
      return callback(_content)
    }

    setTimeout(_check, 10)
  }

  _check()
}

describe('Logger', () => {
  before(() => {
    process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'myApp', 'server')
  })

  after(() => {
    mockdate.reset()
  })

  describe('Log request', () => {
    const _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', '08-01-2019.log')

    before((done) => {
      mockdate.set(new Date('08/01/2019'))
      app.run('prod', process.env.HEARTH_SERVER_PATH, { port: 8080 }, done)
    })

    after((done) => {
      mockdate.reset()
      fs.unlinkSync(_logFilePath)
      app.close(done)
    })

    it('should log one line per request in log file', (done) => {
      rock.get('http://localhost:8080/user', (err, response) => {
        assert.strictEqual(err, null)

        waitForLog(_logFilePath, (c) => /GET \/user 200 \d/.test(c), (_logContent) => {
          // One compact completion line, no "started" line by default
          assert.strictEqual(/08-01-2019 00:00:00 INFO GET \/user 200 \d/.test(_logContent), true, _logContent)
          assert.strictEqual(_logContent.includes('-->'), false)
          done()
        })
      })
    })

    it('should append the context set on req.hearth_log', (done) => {
      rock.get('http://localhost:8080/log-context', () => {
        waitForLog(_logFilePath, (c) => c.includes('GET /log-context 200'), (_logContent) => {
          assert.strictEqual(_logContent.includes('GET /log-context 200'), true, _logContent)
          assert.strictEqual(_logContent.includes('account=4821'), true, _logContent)
          assert.strictEqual(_logContent.includes('template="my invoice.odt"'), true, _logContent)
          // null and empty values are skipped
          assert.strictEqual(_logContent.includes('skipped='), false, _logContent)
          done()
        })
      })
    })

    it('should log a 4xx as a warning and a 5xx as an error', (done) => {
      rock.get('http://localhost:8080/status-404', () => {
        rock.get('http://localhost:8080/status-500', () => {
          let _logContent = fs.readFileSync(_logFilePath, 'utf8')

          assert.strictEqual(_logContent.includes('WARN GET /status-404 404'), true, _logContent)
          assert.strictEqual(_logContent.includes('ERROR GET /status-500 500'), true, _logContent)
          done()
        })
      })
    })
  })

  describe('Log request crash', () => {
    let _logFilePath = null

    before((done) => {
      _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)
      startServer('prod', '8080', done, { APP_LOG_REQUEST_START: 'true' })
    })

    after((done) => {
      fs.unlinkSync(_logFilePath)
      stopServer(done)
    })

    it('should log the started crash request', (done) => {
      rock.get('http://localhost:8080/crash', () => {
        let _logContent = fs.readFileSync(_logFilePath, 'utf8')

        // With APP_LOG_REQUEST_START on, the request that killed the worker is
        // still visible even though it never completed
        assert.strictEqual(_logContent.includes('--> GET /crash'), true, _logContent)
        assert.strictEqual(/GET \/crash \d{3} /.test(_logContent), false, _logContent)
        done()
      })
    })
  })

  describe('Log many requests', () => {
    let _logFilePath = null

    before((done) => {
      _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)
      startServer('prod', '8080', done)
    })

    after((done) => {
      fs.unlinkSync(_logFilePath)
      stopServer(done)
    })

    it('should log the started crash request', (done) => {
      const _nbQueries = 50
      let _nbWaited = 50

      for (let i = 0; i < _nbQueries; i++) {
        rock.get('http://localhost:8080/user', () => {
          _nbWaited -= 1

          if (_nbWaited === 0) {
            // The log stream is flushed asynchronously, wait for the lines
            // instead of reading straight away
            const _deadline = Date.now() + 10000
            const _waitForLines = () => {
              const _logContent = fs.readFileSync(_logFilePath, 'utf8')
              const count = (_logContent.match(/\n/g) || []).length

              // One line per request (was two: "started" + "ended")
              if (count >= _nbQueries || Date.now() >= _deadline) {
                assert.strictEqual(count >= _nbQueries, true, `only ${count} lines for ${_nbQueries} requests`)
                return done()
              }

              return setTimeout(_waitForLines, 50)
            }

            _waitForLines()
          }
        })
      }
    }).timeout(30000)
  })

  describe('Dev mode', () => {
    const _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', '08-01-2019.log')

    let _logSpy = null
    let _errorSpy = null

    before(() => {
      mockdate.set(new Date('08/01/2019'))
      _logSpy = sinon.spy(console, 'log')
      _errorSpy = sinon.spy(console, 'error')
    })

    after(() => {
      mockdate.reset()
      console.log.restore()
      console.error.restore()
    })

    afterEach(() => {
      _logSpy.resetHistory()
      _errorSpy.resetHistory()

      if (fs.existsSync(_logFilePath)) {
        fs.unlinkSync(_logFilePath)
      }
    })

    it('should log in log file and display it with console.log', (done) => {
      logger.initLogger('dev')
      const _expectLog = '08-01-2019 00:00:00 INFO Test'
      logger.log('Test', 'info')
      assert.strictEqual(_logSpy.called, true)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, `${_expectLog}\n`)
        done()
      })
    })

    it('should log in log file and display it with console.error', (done) => {
      const _expectLog = '08-01-2019 00:00:00 ERROR Test'
      logger.initLogger('dev')
      logger.log('Test', 'error')
      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, true)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, `${_expectLog}\n`)
        done()
      })
    })

    it('should debug with debug lib and not console.log', (done) => {
      logger.initLogger('dev')
      logger.debug('Debug message')
      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, '')
        done()
      })
    })
  })

  describe('Stdout logging (APP_LOG_STDOUT)', () => {
    const _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', '08-01-2019.log')

    let _logSpy = null
    let _errorSpy = null

    before(() => {
      mockdate.set(new Date('08/01/2019'))
      _logSpy = sinon.spy(console, 'log')
      _errorSpy = sinon.spy(console, 'error')
    })

    after(() => {
      mockdate.reset()
      console.log.restore()
      console.error.restore()
      delete process.env.APP_LOG_STDOUT
    })

    afterEach(() => {
      _logSpy.resetHistory()
      _errorSpy.resetHistory()
      delete process.env.APP_LOG_STDOUT

      if (fs.existsSync(_logFilePath)) {
        fs.unlinkSync(_logFilePath)
      }
    })

    it('should not write to stdout in prod by default', (done) => {
      logger.initLogger('prod')
      logger.log('quiet', 'info')
      logger.log('quiet error', 'error')

      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(done)
    })

    it('should write to stdout in prod when APP_LOG_STDOUT is true', (done) => {
      process.env.APP_LOG_STDOUT = 'true'
      logger.initLogger('prod')
      logger.log('loud', 'info')

      assert.strictEqual(_logSpy.called, true)
      assert.strictEqual(_logSpy.args[0][0].includes('loud'), true)

      logger._stop(done)
    })

    it('should send errors to stderr when APP_LOG_STDOUT is true', (done) => {
      process.env.APP_LOG_STDOUT = 'true'
      logger.initLogger('prod')
      logger.log('loud error', 'error')

      assert.strictEqual(_errorSpy.called, true)
      assert.strictEqual(_errorSpy.args[0][0].includes('loud error'), true)

      logger._stop(done)
    })

    it('should not colour the output when stdout is not a terminal', (done) => {
      process.env.APP_LOG_STDOUT = 'true'
      logger.initLogger('prod')
      logger.log('no colours', 'info')

      // mocha runs piped in CI, and a TTY locally: only assert the no-TTY case
      if (process.stdout.isTTY !== true) {
        assert.strictEqual(_logSpy.args[0][0].includes('\u001b['), false, _logSpy.args[0][0])
      }

      logger._stop(done)
    })
  })

  describe('Prod mode', () => {
    const _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', '08-01-2019.log')

    let _logSpy = null
    let _errorSpy = null

    before(() => {
      mockdate.set(new Date('08/01/2019'))
      _logSpy = sinon.spy(console, 'log')
      _errorSpy = sinon.spy(console, 'error')
    })

    after(() => {
      mockdate.reset()
      console.log.restore()
      console.error.restore()
    })

    afterEach(() => {
      _logSpy.resetHistory()
      _errorSpy.resetHistory()

      if (fs.existsSync(_logFilePath)) {
        fs.unlinkSync(_logFilePath)
      }
    })

    it('should log in log file only', (done) => {
      logger.initLogger('prod')
      const _expectLog = '08-01-2019 00:00:00 INFO Test'
      logger.log('Test', 'info')
      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, `${_expectLog}\n`)
        done()
      })
    })

    it('should log in log file only 2', (done) => {
      const _expectLog = '08-01-2019 00:00:00 ERROR Test'
      logger.initLogger('prod')
      logger.log('Test', 'error')
      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, `${_expectLog}\n`)
        done()
      })
    })

    it('should not log debug and don\'t call debug', (done) => {
      logger.initLogger('prod')
      logger.debug('Debug message')
      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, '')
        done()
      })
    })
  })

  describe('Options', () => {
    const _logFilePath = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs', '08-01-2019.log')

    let _logSpy = null
    let _errorSpy = null

    before(() => {
      mockdate.set(new Date('08/01/2019'))
      _logSpy = sinon.spy(console, 'log')
      _errorSpy = sinon.spy(console, 'error')
    })

    after(() => {
      mockdate.reset()
      console.log.restore()
      console.error.restore()
    })

    afterEach(() => {
      _logSpy.resetHistory()
      _errorSpy.resetHistory()

      if (fs.existsSync(_logFilePath)) {
        fs.unlinkSync(_logFilePath)
      }
    })

    it('should log only message', (done) => {
      logger.initLogger('dev')
      const _expectLog = 'Test'
      logger.log('Test', 'info', { logDate: false })
      assert.strictEqual(_logSpy.called, true)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, `${_expectLog}\n`)
        done()
      })
    })

    it('should not log if mustLog is false', (done) => {
      logger.initLogger('dev')
      logger.log('Test', 'info', { mustLog: false })
      assert.strictEqual(_logSpy.called, false)
      assert.strictEqual(_errorSpy.called, false)

      logger._stop(() => {
        const _logContent = fs.readFileSync(_logFilePath, 'utf8')
        assert.strictEqual(_logContent, '')
        done()
      })
    })
  })

  describe('Delete old logs', () => {
    const _logDirectory = path.join(__dirname, 'datasets', 'myApp', 'server', 'logs')

    before(() => {
      mockdate.set(new Date('08/01/2019'))
      fs.writeFileSync(path.join(_logDirectory, '07-31-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-30-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-29-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-28-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-27-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-26-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-25-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-24-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '07-23-2019.log'), 'Data logged')
      fs.writeFileSync(path.join(_logDirectory, '06-01-2019.log'), 'Data logged')
    })

    after(() => {
      mockdate.reset()
      if (fs.existsSync(path.join(_logDirectory, '08-02-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '08-02-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '08-01-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '08-01-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-31-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-31-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-30-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-30-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-29-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-29-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-28-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-28-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-27-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-27-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-26-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-26-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-25-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-25-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-24-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-24-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '07-23-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '07-23-2019.log')) }
      if (fs.existsSync(path.join(_logDirectory, '06-01-2019.log'))) { fs.unlinkSync(path.join(_logDirectory, '06-01-2019.log')) }
    })

    it('should create a new file on a new day and delete log file too old', (done) => {
      logger._deleteOldLog()

      // _deleteOldLog unlinks asynchronously: wait for the oldest file to be
      // gone instead of guessing how long the unlinks take
      const _deadline = Date.now() + 10000
      const _waitForDeletion = () => {
        const stillThere = fs.existsSync(path.join(_logDirectory, '06-01-2019.log'))

        if (stillThere && Date.now() < _deadline) {
          return setTimeout(_waitForDeletion, 20)
        }

        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-31-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-30-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-29-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-28-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-27-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-26-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-25-2019.log')), true)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-24-2019.log')), false)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '07-23-2019.log')), false)
        assert.strictEqual(fs.existsSync(path.join(_logDirectory, '06-01-2019.log')), false)
        done()
      }

      _waitForDeletion()
    }).timeout(20000)
  })
})

/**
 * Launch server with nbCluster
 * @param {String} nbCluster Number of cluster to start
 * @param {String} port Application port
 * @param {Function} callback
 */
function startServer (mode, port, callback, env = {}) {
  const _serverPath = path.join(__dirname, 'datasets', 'myApp', 'server')
  const binPath = path.join(__dirname, '..', 'bin', 'hearthjs')

  program = spawn(binPath, ['start', mode, '--port', port], {
    cwd: _serverPath,
    env: Object.assign({}, process.env, env)
  })
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

describe('Log file path', () => {
  it('should report the file the logs go to, and null before a server path is set', () => {
    const _real = process.env.HEARTH_SERVER_PATH

    process.env.HEARTH_SERVER_PATH = '/tmp/hearth-path-probe'
    assert.strictEqual(logger._getLogFilePath(),
      path.join('/tmp/hearth-path-probe', 'logs', `${logger._getCurrentDateTime(false)}.log`))

    delete process.env.HEARTH_SERVER_PATH
    assert.strictEqual(logger._getLogFilePath(), null)

    if (_real !== undefined) {
      process.env.HEARTH_SERVER_PATH = _real
    }
  })
})
