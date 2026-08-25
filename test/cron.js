const cron = require('../lib/cron')
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const app = require('../lib/')
const logger = require('../lib/logger')


/**
 * Wait until the cron files hold their expected content. The crons run every
 * second and fs.writeFile truncates first, so a fixed delay raced with both.
 * @param {Array} expectations [{ path, content }]
 * @param {Number} timeout Maximum time to wait in ms
 * @param {Function} callback
 */
function waitForCronFiles (expectations, timeout, callback) {
  const _deadline = Date.now() + timeout

  const check = () => {
    let allMatch = true

    for (let i = 0; i < expectations.length; i++) {
      let content = null

      try {
        content = fs.readFileSync(expectations[i].path, 'utf8')
      } catch (e) {
        allMatch = false
        break
      }

      if (content !== expectations[i].content) {
        allMatch = false
        break
      }
    }

    if (allMatch) {
      return callback(null)
    }

    if (Date.now() >= _deadline) {
      // Let the caller assert and produce a readable diff
      return callback(new Error(`Cron files were not written within ${timeout}ms`))
    }

    return setTimeout(check, 50)
  }

  check()
}

describe('Cron', () => {
  after(() => {
    const _logFile = path.join(__dirname, 'datasets', 'cronApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

    if (fs.existsSync(_logFile)) {
      fs.unlinkSync(_logFile)
    }
  })

  describe('Load cron', () => {
    const pathCron1 = path.join(__dirname, 'datasets', 'cronApp', 'server', 'cron', 'cron1')
    const pathCron2 = path.join(__dirname, 'datasets', 'cronApp', 'server', 'cron', 'cron2')

    before(() => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'cronApp', 'server')
    })

    after(() => {
      if (fs.existsSync(pathCron1)) {
        fs.unlinkSync(pathCron1)
      }
      if (fs.existsSync(pathCron2)) {
        fs.unlinkSync(pathCron2)
      }
      cron._cronList = {}
    })

    it('should load cron and start them', (done) => {
      cron.loadCron((err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(Object.keys(cron._cronList).length, 2)
        waitForCronFiles([
          { path: pathCron1, content: 'Test cron' },
          { path: pathCron2, content: 'Test cron 2' }
        ], 10000, (err) => {
          cron.stop('testCron')
          cron.stop('testCron2')
          assert.strictEqual(err, null)
          done()
        })
      })
    }).timeout(20000)
  })

  describe('Run server', () => {
    const pathCron1 = path.join(__dirname, 'datasets', 'cronApp', 'server', 'cron', 'cron1')
    const pathCron2 = path.join(__dirname, 'datasets', 'cronApp', 'server', 'cron', 'cron2')

    before(() => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'cronApp', 'server')
    })

    after((done) => {
      if (fs.existsSync(pathCron1)) {
        fs.unlinkSync(pathCron1)
      }
      if (fs.existsSync(pathCron2)) {
        fs.unlinkSync(pathCron2)
      }
      app.close(done)
    })

    it('should start server and load cron on startup', (done) => {
      app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
        assert.strictEqual(err, null)
        assert.notStrictEqual(app.cron._cronList['testCron'], undefined)
        assert.notStrictEqual(app.cron._cronList['testCron2'], undefined)
        waitForCronFiles([
          { path: pathCron1, content: 'Test cron' },
          { path: pathCron2, content: 'Test cron 2' }
        ], 10000, (err) => {
          assert.strictEqual(err, null)
          done()
        })
      })
    }).timeout(20000)
  })

  describe('Function add, start and stop', () => {
    const filePath = path.join(__dirname, 'cronFile')

    afterEach(() => {
      if (cron._cronList['myCron']) {
        cron._cronList['myCron'].cron.destroy()
        cron._cronList = {}
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    })

    it('should add a cron and start it automatically', () => {
      cron.add('myCron', '* * * * *', () => {}, { start: true })
      assert.notStrictEqual(cron._cronList['myCron'], undefined)
      assert.strictEqual(cron._cronList['myCron'].cron.getStatus(), 'idle')
    })

    it('should throw an error if cron already exists', () => {
      cron.add('myCron', '* * * * *', () => {})
      assert.throws(() => {
        cron.add('myCron', '* * * * *', () => {})
      }, Error, 'A cron myCron has already been declared')
    })

    it('should add a cron but not start it', () => {
      cron.add('myCron', '* * * * *', () => {})
      assert.notStrictEqual(cron._cronList['myCron'], undefined)
      assert.strictEqual(cron._cronList['myCron'].cron.getStatus(), 'stopped')
    })

    it('should throw an error if start is called for an unknown cron', () => {
      assert.throws(() => {
        cron.start('myCron')
      }, Error, 'Unknow cron myCron')
    })

    it('should throw an error if stop is called for an unknown cron', () => {
      assert.throws(() => {
        cron.stop('myCron')
      }, Error, 'Unknow cron myCron')
    })

    it('should add a cron start and stop it', () => {
      cron.add('myCron', '* * * * *', () => {})
      cron.start('myCron')
      assert.notStrictEqual(cron._cronList['myCron'], undefined)
      assert.strictEqual(cron._cronList['myCron'].cron.getStatus(), 'idle')
      cron.stop('myCron')
      assert.strictEqual(cron._cronList['myCron'].cron.getStatus(), 'stopped')
    })

  })
})

/**
 * Launch server with nbCluster
 * @param {String} nbCluster Number of cluster to start
 * @param {String} port Application port
 * @param {Function} callback
 */
