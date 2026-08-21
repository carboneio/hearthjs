const assert = require('assert')
const api = require('../lib/api')
const addon = require('../lib/addon')

/**
 * An async before/after handler or addon hook that throws used to become an
 * unhandled rejection, which terminates the process on Node >= 15.
 */
describe('Async handler safety', () => {
  let _rejections = []
  const _onRejection = (err) => _rejections.push(err)

  beforeEach(() => {
    _rejections = []
    process.on('unhandledRejection', _onRejection)
  })

  afterEach(() => {
    process.removeListener('unhandledRejection', _onRejection)
  })

  /**
   * Let the event loop surface an unhandled rejection. Node emits it once the
   * microtask queue has drained, so two macrotask turns is exact.
   * @param {Function} callback
   */
  function settle (callback) {
    setImmediate(() => setImmediate(callback))
  }

  describe('before / after handlers', () => {
    it('should route a rejected async before handler to the callback', (done) => {
      api._mayExec({}, {}, async () => { throw new Error('async boom') }, 'before', (err) => {
        assert.notStrictEqual(err, undefined)
        assert.strictEqual(err.message, 'async boom')

        settle(() => {
          assert.strictEqual(_rejections.length, 0, 'the rejection must not stay unhandled')
          done()
        })
      })
    })

    it('should route a synchronous throw to the callback', (done) => {
      api._mayExec({}, {}, () => { throw new Error('sync boom') }, 'before', (err) => {
        assert.strictEqual(err.message, 'sync boom')
        done()
      })
    })

    it('should route a rejected async after handler to the callback', (done) => {
      api._mayExec({}, {}, async () => { throw new Error('after boom') }, 'after', {}, (err) => {
        assert.strictEqual(err.message, 'after boom')

        settle(() => {
          assert.strictEqual(_rejections.length, 0)
          done()
        })
      })
    })

    it('should not call the callback twice when the handler rejects after next()', (done) => {
      let _calls = 0

      api._mayExec({}, {}, async (req, res, next) => {
        next()
        throw new Error('too late')
      }, 'before', () => { _calls += 1 })

      settle(() => {
        assert.strictEqual(_calls, 1)
        assert.strictEqual(_rejections.length, 0)
        done()
      })
    })

    it('should still work with a normal async handler', (done) => {
      api._mayExec({}, {}, async (req, res, next) => { return next(null) }, 'before', (err) => {
        assert.strictEqual(err, null)
        done()
      })
    })
  })

  describe('addon hooks', () => {
    it('should route a rejected addon exec to the callback', (done) => {
      addon.execAddon({ exec: async () => { throw new Error('addon boom') } }, {}, {}, '/r', {}, {}, {}, (err) => {
        assert.strictEqual(err.message, 'addon boom')

        settle(() => {
          assert.strictEqual(_rejections.length, 0)
          done()
        })
      })
    })

    it('should route a rejected addon init to the callback', (done) => {
      addon.initAddon({}, { init: async () => { throw new Error('init boom') } }, (err) => {
        assert.strictEqual(err.message, 'init boom')
        done()
      })
    })

    it('should route a rejected initSchema to the callback', (done) => {
      addon.initSchemaAddon({ initSchema: async () => { throw new Error('schema boom') } }, {}, {}, '/r', {}, (err) => {
        assert.strictEqual(err.message, 'schema boom')
        done()
      })
    })

    it('should keep `this` bound to the addon', (done) => {
      // An addon hook calling its own helpers (this._helper) must keep working:
      // wrapping the hook must not change its receiver
      const myAddon = {
        _helper: function () { return 'from helper' },
        exec: function (v, db, route, schema, req, res, next) {
          assert.strictEqual(this._helper(), 'from helper')
          return next(null)
        },
        init: function (db, next) {
          assert.strictEqual(this._helper(), 'from helper')
          return next(null)
        },
        initSchema: function (v, db, route, schema, next) {
          assert.strictEqual(this._helper(), 'from helper')
          return next(null)
        }
      }

      addon.initAddon({}, myAddon, (err) => {
        assert.strictEqual(err, null)

        addon.initSchemaAddon(myAddon, {}, {}, '/r', {}, (err) => {
          assert.strictEqual(err, null)

          addon.execAddon(myAddon, {}, {}, '/r', {}, {}, {}, (err) => {
            assert.strictEqual(err, null)
            done()
          })
        })
      })
    })

    it('should still work with a normal addon', (done) => {
      addon.execAddon({ exec: (v, db, route, schema, req, res, next) => next(null) }, {}, {}, '/r', {}, {}, {}, (err) => {
        assert.strictEqual(err, null)
        done()
      })
    })
  })
})
