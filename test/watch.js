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
