const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const watch = require('../lib/watch')

const rootPath = path.join(os.tmpdir(), 'hearthjs-watch-test')

// fs.watchFile polls: make it poll fast so the tests do not sit waiting
process.env.HEARTH_WATCH_INTERVAL = '20'

/**
 * Rewrite a file until the watcher reports it: fs.watchFile only notices a
 * change made after its first stat, and nothing says when that happened.
 * @param {String} filePath File to touch
 * @param {String} content Content to write
 */
function touchUntilNoticed (filePath, content) {
  let _counter = 0

  const _timer = setInterval(() => {
    _counter += 1
    fs.writeFileSync(filePath, `${content}${_counter}\n`)
  }, 20)

  return () => clearInterval(_timer)
}

/**
 * Remove every watcher registered on the temporary tree
 */
function unwatchAll (dirPath) {
  const list = fs.readdirSync(dirPath)

  for (let i = 0; i < list.length; i++) {
    const filePath = path.join(dirPath, list[i])

    if (fs.statSync(filePath).isDirectory()) {
      unwatchAll(filePath)
    } else {
      fs.unwatchFile(filePath)
    }
  }
}

describe('Watch', () => {
  let previousServerPath = null

  beforeEach(() => {
    previousServerPath = process.env.HEARTH_SERVER_PATH
    fs.rmSync(rootPath, { recursive: true, force: true })
    fs.mkdirSync(path.join(rootPath, 'api', 'user', 'sql'), { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'helpers'), { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'logs'), { recursive: true })

    fs.writeFileSync(path.join(rootPath, 'api', 'user', 'api.user.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(rootPath, 'api', 'user', 'sql', 'getUser.sql'), 'SELECT 1;\n')
    fs.writeFileSync(path.join(rootPath, 'helpers', 'tool.js'), 'module.exports = {}\n')
    // Not part of the watched patterns
    fs.writeFileSync(path.join(rootPath, 'logs', 'today.log'), 'nothing\n')

    process.env.HEARTH_SERVER_PATH = rootPath
  })

  afterEach(() => {
    unwatchAll(rootPath)
    fs.rmSync(rootPath, { recursive: true, force: true })

    if (previousServerPath === undefined) {
      delete process.env.HEARTH_SERVER_PATH
    } else {
      process.env.HEARTH_SERVER_PATH = previousServerPath
    }
  })

  it('should parse the server directory without error', (done) => {
    watch.watchServerFiles(() => {}, (err) => {
      assert.strictEqual(err, null)
      done()
    })
  })

  it('should return an error if the server directory does not exist', (done) => {
    process.env.HEARTH_SERVER_PATH = path.join(rootPath, 'does-not-exist')

    watch.watchServerFiles(() => {}, (err) => {
      assert.notStrictEqual(err, null)
      assert.strictEqual(err.code, 'ENOENT')
      process.env.HEARTH_SERVER_PATH = rootPath
      done()
    })
  })

  it('should call the status callback when a watched api file changes', function (done) {
    this.timeout(10000)
    let called = false
    let _stopTouching = () => {}

    watch.watchServerFiles((status, filename) => {
      if (called || filename !== 'api.user.js') {
        return
      }

      called = true
      _stopTouching()
      assert.strictEqual(status, 'change')
      done()
    }, (err) => {
      assert.strictEqual(err, null)

      _stopTouching = touchUntilNoticed(path.join(rootPath, 'api', 'user', 'api.user.js'), 'module.exports = { updated: true }\n')
    })
  })

  it('should call the status callback when a watched sql file changes', function (done) {
    this.timeout(10000)
    let called = false
    let _stopTouching = () => {}

    watch.watchServerFiles((status, filename) => {
      if (called || filename !== 'getUser.sql') {
        return
      }

      called = true
      _stopTouching()
      assert.strictEqual(status, 'change')
      done()
    }, (err) => {
      assert.strictEqual(err, null)

      _stopTouching = touchUntilNoticed(path.join(rootPath, 'api', 'user', 'sql', 'getUser.sql'), 'SELECT 2;\n')
    })
  })

  it('should accept extra watched patterns', function (done) {
    this.timeout(10000)
    let called = false
    let _stopTouching = () => {}

    fs.writeFileSync(path.join(rootPath, 'custom.conf'), 'a\n')

    watch.watchServerFiles([/^\/custom\.conf$/], (status, filename) => {
      if (called || filename !== 'custom.conf') {
        return
      }

      called = true
      _stopTouching()
      assert.strictEqual(status, 'change')
      done()
    }, (err) => {
      assert.strictEqual(err, null)

      _stopTouching = touchUntilNoticed(path.join(rootPath, 'custom.conf'), 'b\n')
    })
  })
})

describe('Test runner watching', () => {
  const testRunner = require('../lib/testRunner')

  let _watchCalls = 0
  let _realWatch = null
  let _realBoot = null

  beforeEach(() => {
    _watchCalls = 0
    _realWatch = watch.watchServerFiles
    _realBoot = testRunner._bootAndRun
    watch.watchServerFiles = (dirs, statusCb, cb) => {
      _watchCalls++
      return cb(null)
    }
    // Stop before mocha actually runs: only the wiring is under test
    testRunner._bootAndRun = (options, callback) => callback(null)
  })

  afterEach(() => {
    watch.watchServerFiles = _realWatch
    testRunner._bootAndRun = _realBoot
  })

  it('should not watch anything when -s asks for a single run', (done) => {
    // A reload mid-run wipes the SQL registry under whatever test is in flight
    testRunner.runTest({ stop: true }, () => {})

    setImmediate(() => {
      assert.strictEqual(_watchCalls, 0)
      done()
    })
  })

  it('should still watch when the runner is left running', (done) => {
    testRunner.runTest({}, () => {})

    setImmediate(() => {
      assert.strictEqual(_watchCalls, 1)
      done()
    })
  })
})

describe('Test runner: discovery and exit', () => {
  const testRunner = require('../lib/testRunner')
  const server = require('../lib/server')
  const path = require('path')

  let _added = []
  let _errors = []
  let _closed = 0
  let _realFiles = null
  let _realError = null
  let _realClose = null
  let _realExitCode = null

  /**
   * Drive _runMocha with a stubbed mocha, capturing what it adds and reports
   * @param {Object} options Cli options
   * @param {Number} tests Number of tests the run reports having executed
   * @param {Number} code Exit code mocha reports
   */
  function runWith (options, tests, code) {
    const _Mocha = require('mocha')
    const _realRun = _Mocha.prototype.run
    const _realAddFile = _Mocha.prototype.addFile

    _Mocha.prototype.addFile = function (file) {
      _added.push(file)
      return this
    }

    _Mocha.prototype.run = function (callback) {
      const _runner = { stats: { tests: tests } }

      // mocha calls back asynchronously, and _runMocha reads the runner it
      // returns: the callback has to see the assignment, like the real one does
      setImmediate(() => callback(code))
      return _runner
    }

    testRunner._runMocha(options)

    _Mocha.prototype.run = _realRun
    _Mocha.prototype.addFile = _realAddFile
  }

  beforeEach(() => {
    _added = []
    _errors = []
    _closed = 0
    _realFiles = testRunner._testFiles
    _realError = console.error
    _realClose = server.close
    _realExitCode = process.exitCode
    console.error = (msg) => _errors.push(String(msg))
    server.close = (cb) => {
      _closed++
      return cb(null)
    }
  })

  afterEach(() => {
    testRunner._testFiles = _realFiles
    console.error = _realError
    server.close = _realClose
    process.exitCode = _realExitCode
  })

  it('should run the test files in a stable order, whatever the walk returned', (done) => {
    // readdir order is filesystem dependent and the walk recurses asynchronously:
    // without this, a test polluting the next one reproduces on one machine only
    testRunner._testFiles = [
      path.join('b', 'test.zebra.js'),
      path.join('a', 'test.alpha.js'),
      path.join('b', 'test.apple.js')
    ]

    runWith({ stop: false }, 3, 0)

    setImmediate(() => {
      assert.deepStrictEqual(_added, [
        path.join('a', 'test.alpha.js'),
        path.join('b', 'test.apple.js'),
        path.join('b', 'test.zebra.js')
      ])
      done()
    })
  })

  it('should fail a run that executed no test at all', (done) => {
    // The green CI that tested nothing: mocha answers 0 for a suite with no
    // files AND for files that registered nothing, which is what a dependency
    // throwing at require time looks like
    testRunner._testFiles = []

    runWith({ stop: true }, 0, 0)

    setImmediate(() => {
      assert.strictEqual(process.exitCode, 1, 'a suite that ran nothing must not report success')
      assert.strictEqual(_errors.length, 1, JSON.stringify(_errors))
      assert.strictEqual(_errors[0].includes('No test ran'), true, _errors[0])
      done()
    })
  })

  it('should fail a run whose files loaded but registered nothing', (done) => {
    testRunner._testFiles = ['/somewhere/test.thing.js']

    runWith({ stop: true }, 0, 0)

    setImmediate(() => {
      assert.strictEqual(_added.length, 1)
      assert.strictEqual(process.exitCode, 1)
      done()
    })
  })

  it('should keep the code mocha reported when tests did run', (done) => {
    testRunner._testFiles = ['/somewhere/test.thing.js']

    runWith({ stop: true }, 12, 0)

    setImmediate(() => {
      assert.strictEqual(process.exitCode, 0)
      assert.deepStrictEqual(_errors, [])
      done()
    })
  })

  it('should report a failing run without losing the code', (done) => {
    testRunner._testFiles = ['/somewhere/test.thing.js']

    runWith({ stop: true }, 12, 1)

    setImmediate(() => {
      assert.strictEqual(process.exitCode, 1)
      done()
    })
  })

  it('should release the server rather than exit, so a piped stdout drains', (done) => {
    // process.exit() drops buffered stdout on a pipe: a failing CI run lost the
    // very trace that explained it
    testRunner._testFiles = ['/somewhere/test.thing.js']

    runWith({ stop: true }, 12, 1)

    setImmediate(() => {
      assert.strictEqual(_closed, 1, 'the server must be released so the loop can empty')
      done()
    })
  })

  it('should neither exit nor close when the runner keeps watching', (done) => {
    testRunner._testFiles = ['/somewhere/test.thing.js']
    process.exitCode = 0

    runWith({ stop: false }, 0, 0)

    setImmediate(() => {
      // The zero-test warning still applies, but a watching runner owns its own
      // lifetime: it must not set an exit code or tear the server down
      assert.strictEqual(_errors[0].includes('No test ran'), true)
      assert.strictEqual(_closed, 0)
      assert.strictEqual(process.exitCode, 0)
      done()
    })
  })
})
