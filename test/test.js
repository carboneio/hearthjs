const assert = require('assert')
const test = require('../lib/test')
const database = require('../lib/database')

describe('Test helpers (hearthjs.test)', () => {
  describe('waitUntil', () => {
    it('should call back as soon as the condition turns true', (done) => {
      let _ready = false
      setTimeout(() => { _ready = true }, 20)

      test.waitUntil(() => _ready, (err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(_ready, true)
        done()
      }, { interval: 2 })
    })

    it('should error once the deadline passed', (done) => {
      test.waitUntil(() => false, (err) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(/condition still false after 20ms/.test(err.message), true)
        done()
      }, { timeout: 20, interval: 2 })
    })

    it('should surface a throwing predicate', (done) => {
      test.waitUntil(() => { throw new Error('boom') }, (err) => {
        assert.strictEqual(err.message, 'boom')
        done()
      })
    })
  })

  describe('waitForRow', () => {
    let _query = null

    beforeEach(() => {
      _query = database.query
    })

    afterEach(() => {
      database.query = _query
    })

    it('should poll the query until isReady(rows) is true', (done) => {
      let _calls = 0
      database.query = (sql, params, cb) => {
        _calls += 1
        return cb(null, {}, (_calls >= 3) ? [{ id: 1 }] : [])
      }

      test.waitForRow('SELECT 1', [], (rows) => rows.length > 0, (err, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows.length, 1)
        assert.strictEqual(_calls >= 3, true, 'it polled until the row appeared')
        done()
      }, { interval: 2 })
    })

    it('should error on timeout, naming the sql', (done) => {
      database.query = (sql, params, cb) => cb(null, {}, [])

      test.waitForRow('SELECT missing', [], () => false, (err) => {
        assert.strictEqual(/no matching row/.test(err.message), true)
        assert.strictEqual(/SELECT missing/.test(err.message), true)
        done()
      }, { timeout: 20, interval: 2 })
    })

    it('should surface a query error immediately', (done) => {
      database.query = (sql, params, cb) => cb(new Error('db down'))

      test.waitForRow('SELECT 1', [], () => true, (err) => {
        assert.strictEqual(err.message, 'db down')
        done()
      })
    })

    it('should surface a throwing isReady', (done) => {
      database.query = (sql, params, cb) => cb(null, {}, [{ id: 1 }])

      test.waitForRow('SELECT 1', [], () => { throw new Error('bad predicate') }, (err) => {
        assert.strictEqual(err.message, 'bad predicate')
        done()
      })
    })
  })
})
