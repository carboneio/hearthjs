const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const helper = require('../lib/helper')

const rootPath = path.join(os.tmpdir(), 'hearthjs-helper-test')

describe('Helper (architecture, config and type guards)', () => {
  let previousServerPath = null

  beforeEach(() => {
    previousServerPath = process.env.HEARTH_SERVER_PATH
    fs.rmSync(rootPath, { recursive: true, force: true })
    process.env.HEARTH_SERVER_PATH = rootPath
  })

  afterEach(() => {
    fs.rmSync(rootPath, { recursive: true, force: true })

    if (previousServerPath === undefined) {
      delete process.env.HEARTH_SERVER_PATH
    } else {
      process.env.HEARTH_SERVER_PATH = previousServerPath
    }
  })

  describe('_createDirectoryIfNotExists', () => {
    it('should create the directory and a .gitkeep', () => {
      const dirPath = path.join(rootPath, 'brand-new')

      fs.mkdirSync(rootPath, { recursive: true })
      helper._createDirectoryIfNotExists(dirPath)

      assert.strictEqual(fs.existsSync(dirPath), true)
      assert.strictEqual(fs.existsSync(path.join(dirPath, '.gitkeep')), true)
    })

    it('should not touch an existing directory', () => {
      const dirPath = path.join(rootPath, 'existing')

      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(path.join(dirPath, 'keep-me.txt'), 'content')

      helper._createDirectoryIfNotExists(dirPath)

      assert.strictEqual(fs.readFileSync(path.join(dirPath, 'keep-me.txt'), 'utf8'), 'content')
      assert.strictEqual(fs.existsSync(path.join(dirPath, '.gitkeep')), false)
    })
  })

  describe('createArchitecture', () => {
    it('should create the whole server tree and the three config files', (done) => {
      helper.createArchitecture((err) => {
        assert.strictEqual(err, null)

        const expectedDirectories = ['cron', 'logs', 'migration', 'config', 'api', 'commands']

        for (let i = 0; i < expectedDirectories.length; i++) {
          assert.strictEqual(fs.existsSync(path.join(rootPath, expectedDirectories[i])), true, `missing ${expectedDirectories[i]}`)
        }

        const expectedConfigs = ['test.json', 'dev.json', 'prod.json']

        for (let i = 0; i < expectedConfigs.length; i++) {
          const configPath = path.join(rootPath, 'config', expectedConfigs[i])

          assert.strictEqual(fs.existsSync(configPath), true, `missing ${expectedConfigs[i]}`)

          const content = JSON.parse(fs.readFileSync(configPath, 'utf8'))

          assert.strictEqual(content.APP_SERVER_PORT, 8080)
          assert.strictEqual(content.APP_DATABASE_PORT, 5432)
        }

        done()
      })
    })
  })

  describe('createDefaultConfigFile', () => {
    it('should do nothing for an unknown environment', (done) => {
      fs.mkdirSync(path.join(rootPath, 'config'), { recursive: true })

      helper.createDefaultConfigFile('staging', (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(fs.existsSync(path.join(rootPath, 'config', 'staging.json')), false)
        done()
      })
    })

    it('should write a default config file for a known environment', (done) => {
      fs.mkdirSync(path.join(rootPath, 'config'), { recursive: true })

      helper.createDefaultConfigFile('dev', (err) => {
        assert.strictEqual(err, null)

        const content = JSON.parse(fs.readFileSync(path.join(rootPath, 'config', 'dev.json'), 'utf8'))

        assert.strictEqual(content.APP_DATABASE_USERNAME, 'postgres')
        assert.strictEqual(content.APP_DATABASE_HOST, 'localhost')
        done()
      })
    })
  })

  describe('loadConfForDatabase', () => {
    it('should map a config file to a database configuration', (done) => {
      fs.mkdirSync(path.join(rootPath, 'config'), { recursive: true })
      fs.writeFileSync(path.join(rootPath, 'config', 'test.json'), JSON.stringify({
        APP_DATABASE_USERNAME: 'user',
        APP_DATABASE_HOST: 'db.local',
        APP_DATABASE_NAME: 'my_db',
        APP_DATABASE_PASSWORD: 'secret',
        APP_DATABASE_PORT: 6543
      }))

      helper.loadConfForDatabase('test', (err, conf) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(conf, {
          user: 'user',
          host: 'db.local',
          database: 'my_db',
          password: 'secret',
          port: 6543
        })
        done()
      })
    })

    it('should return an error if the config file does not exist', (done) => {
      fs.mkdirSync(path.join(rootPath, 'config'), { recursive: true })

      helper.loadConfForDatabase('nope', (err) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(err.code, 'ENOENT')
        done()
      })
    })

    it('should return an error if the config file is not valid JSON', (done) => {
      fs.mkdirSync(path.join(rootPath, 'config'), { recursive: true })
      fs.writeFileSync(path.join(rootPath, 'config', 'test.json'), '{ broken')

      helper.loadConfForDatabase('test', (err) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(err instanceof SyntaxError, true)
        done()
      })
    })
  })

  describe('ask', () => {
    it('should return the pre-filled response without reading stdin', (done) => {
      helper.ask('Description: ', null, (answer) => {
        assert.strictEqual(answer, 'already known')
        done()
      }, 'already known')
    })
  })

  describe('isArray / isObject', () => {
    it('should recognise real arrays', () => {
      assert.strictEqual(helper.isArray([]), true)
      assert.strictEqual(helper.isArray([1, 2]), true)
      assert.strictEqual(helper.isArray({}), false)
      assert.strictEqual(helper.isArray('string'), false)
      assert.strictEqual(helper.isArray(null), false)
      assert.strictEqual(helper.isArray(undefined), false)
      assert.strictEqual(helper.isArray(0), false)
    })

    it('should recognise plain objects only', () => {
      assert.strictEqual(helper.isObject({}), true)
      assert.strictEqual(helper.isObject({ a: 1 }), true)
      assert.strictEqual(helper.isObject([]), false)
      assert.strictEqual(helper.isObject(new Date()), false)
      assert.strictEqual(helper.isObject(null), false)
      assert.strictEqual(helper.isObject(undefined), false)
      assert.strictEqual(helper.isObject('string'), false)
    })
  })

  describe('genericQueue', () => {
    it('should not start twice while it is already running', (done) => {
      let processed = 0
      const queue = helper.genericQueue([1, 2, 3], (item, next) => {
        processed += 1
        setImmediate(next)
      }, null, () => {
        assert.strictEqual(processed, 3)
        done()
      })

      queue.start()
      queue.start()
    })

    it('should work without an error handler and without a callback', () => {
      let processed = 0

      helper.genericQueue([1, 2], (item, next) => {
        processed += 1
        return next()
      }, null, null).start()

      assert.strictEqual(processed, 2)
    })

    it('should not consume the array it is given', (done) => {
      const items = [1, 2, 3]

      helper.genericQueue(items, (item, next) => {
        return next()
      }, null, () => {
        assert.deepStrictEqual(items, [1, 2, 3])
        done()
      }).start()
    })

    it('should let the same array be processed twice', (done) => {
      const items = ['a', 'b', 'c']
      let first = ''
      let second = ''

      helper.genericQueue(items, (item, next) => {
        first += item
        return next()
      }, null, () => {
        helper.genericQueue(items, (item, next) => {
          second += item
          return next()
        }, null, () => {
          assert.strictEqual(first, 'abc')
          assert.strictEqual(second, 'abc')
          done()
        }).start()
      }).start()
    })

    it('should not overflow the stack with a synchronous item handler', (done) => {
      // A synchronous next() used to recurse once per item and threw
      // `Maximum call stack size exceeded` after a few thousand items
      const items = []

      for (let i = 0; i < 100000; i++) {
        items.push(i)
      }

      let processed = 0

      helper.genericQueue(items, (item, next) => {
        processed += 1
        return next()
      }, null, () => {
        assert.strictEqual(processed, 100000)
        done()
      }).start()
    }).timeout(30000)

    it('should expose the current item to the handler', (done) => {
      const seen = []

      helper.genericQueue(['x', 'y'], function (item, next) {
        seen.push(this.currentItem)
        assert.strictEqual(this.currentItem, item)
        return next()
      }, null, () => {
        assert.deepStrictEqual(seen, ['x', 'y'])
        done()
      }).start()
    })

    it('should stop on error and never call the callback', (done) => {
      let processed = 0
      let callbackCalled = false

      helper.genericQueue([1, 2, 3], (item, next) => {
        processed += 1
        return next(item === 2 ? new Error('boom') : null)
      }, (err) => {
        assert.strictEqual(err.message, 'boom')
        assert.strictEqual(processed, 2)

        // The queue must not go on: give it every chance to, then assert it did not
        setImmediate(() => setImmediate(() => {
          assert.strictEqual(callbackCalled, false)
          assert.strictEqual(processed, 2)
          done()
        }))
      }, () => {
        callbackCalled = true
      }).start()
    })

    it('should handle an empty list', (done) => {
      let processed = 0

      helper.genericQueue([], (item, next) => {
        processed += 1
        return next()
      }, null, () => {
        assert.strictEqual(processed, 0)
        done()
      }).start()
    })

    it('should support a mix of synchronous and asynchronous handlers', (done) => {
      let result = ''

      helper.genericQueue([1, 2, 3, 4], (item, next) => {
        result += item

        if (item % 2 === 0) {
          return process.nextTick(next)
        }

        return next()
      }, null, () => {
        assert.strictEqual(result, '1234')
        done()
      }).start()
    })
  })
})
