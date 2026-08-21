const assert = require('assert')
const path = require('path')
const fs = require('fs')
const app = require('../lib/')
const server = require('../lib/server')
const logger = require('../lib/logger')

const appPath = path.join(__dirname, 'datasets', 'myApp', 'server')
const indexPath = path.join(appPath, 'index.js')

/**
 * Remove the log file written by the test server
 */
function cleanLogs () {
  const _logFile = path.join(appPath, 'logs', `${logger._getCurrentDateTime(false)}.log`)

  if (fs.existsSync(_logFile)) {
    fs.unlinkSync(_logFile)
  }
}

describe('Socket server', () => {
  afterEach(() => {
    if (fs.existsSync(indexPath)) {
      fs.unlinkSync(indexPath)
    }
    cleanLogs()
  })

  it('should not create a socket server when the project does not ask for one', (done) => {
    fs.copyFileSync(path.join(__dirname, 'datasets', 'indexFiles', 'basicIndex.js'), indexPath)
    process.env.HEARTH_SERVER_PATH = appPath

    app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
      assert.strictEqual(err, null)
      assert.strictEqual(server.io, null)

      fs.unlinkSync(path.join(appPath, 'test.test'))
      app.close(done)
    })
  }).timeout(20000)

  it('should create a socket server when startSocketServer is true', (done) => {
    fs.copyFileSync(path.join(__dirname, 'datasets', 'indexFiles', 'socketIndex.js'), indexPath)
    process.env.HEARTH_SERVER_PATH = appPath

    app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
      assert.strictEqual(err, null)
      assert.notStrictEqual(server.io, null)
      assert.strictEqual(typeof server.io.on, 'function')
      // The cors options declared by the project are forwarded to socket.io
      assert.strictEqual(server.io.engine.opts.cors.origin, 'http://localhost:9999')

      server.io.close()
      app.close(done)
    })
  }).timeout(20000)

  it('should report a clear error when socket.io is asked for but not installed', (done) => {
    // socket.io is an optional peer dependency: simulate a project that enabled
    // the socket server without installing it
    const socketPath = require.resolve('socket.io')
    const saved = require.cache[socketPath]

    delete require.cache[socketPath]
    const Module = require('module')
    const originalResolve = Module._resolveFilename

    Module._resolveFilename = function (request, ...args) {
      if (request === 'socket.io') {
        const error = new Error("Cannot find module 'socket.io'")

        error.code = 'MODULE_NOT_FOUND'
        throw error
      }

      return originalResolve.call(this, request, ...args)
    }

    fs.copyFileSync(path.join(__dirname, 'datasets', 'indexFiles', 'socketIndex.js'), indexPath)
    process.env.HEARTH_SERVER_PATH = appPath

    app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
      Module._resolveFilename = originalResolve

      if (saved !== undefined) {
        require.cache[socketPath] = saved
      }

      assert.notStrictEqual(err, null)
      assert.strictEqual(err.message.includes('socket.io is not installed'), true, err.message)
      app.close(done)
    })
  }).timeout(20000)
})
