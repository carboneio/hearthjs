const datasets = require('../lib/datasets')
const assert = require('assert')
const app = require('../lib')
const path = require('path')
const database = require('../lib/database')
const fs = require('fs')
const logger = require('../lib/logger')

describe('Datasets', () => {
  before((done) => {
    process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'datasetsApp', 'server')
    app.run('test', process.env.HEARTH_SERVER_PATH, done)
  })

  after((done) => {
    const _logFile = path.join(__dirname, 'datasets', 'datasetsApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

    if (fs.existsSync(_logFile)) {
      fs.unlinkSync(_logFile)
    }

    database.query('DROP TABLE "MyTable3", "MyTable2", "MyTable"', () => {
      app.close(done)
    })
  })

  it('should insert dataset1 and clean it after', (done) => {
    datasets.insert(['dataset1'], (err) => {
      assert.strictEqual(err, null)
      database.query('SELECT * FROM "MyTable"', (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows.length, 3)
        datasets.clean((err) => {
          assert.strictEqual(err, null)
          database.query('SELECT * FROM "MyTable"', (err, res, rows) => {
            assert.strictEqual(err, null)
            assert.strictEqual(rows.length, 0)
            done()
          })
        })
      })
    })
  })

  it('should insert multiple datasets and clean them after', (done) => {
    datasets.insert(['dataset1', 'dataset2'], (err) => {
      assert.strictEqual(err, null)
      database.query('SELECT * FROM "MyTable"', (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows.length, 3)
        database.query('SELECT * FROM "MyTable2"', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows.length, 4)
          database.query('SELECT * FROM "MyTable3"', (err, res, rows) => {
            assert.strictEqual(err, null)
            assert.strictEqual(rows.length, 2)
            datasets.clean((err) => {
              assert.strictEqual(err, null)
              database.query('SELECT * FROM "MyTable2"', (err, res, rows) => {
                assert.strictEqual(err, null)
                assert.strictEqual(rows.length, 0)
                done()
              })
            })
          })
        })
      })
    })
  })

  describe('resetHook / setDefaultSeed', () => {
    afterEach((done) => {
      datasets.setDefaultSeed([])
      datasets.clean(done)
    })

    it('should clean then insert the default seed plus the extra sets', (done) => {
      datasets.setDefaultSeed(['dataset1'])

      const _hook = datasets.resetHook(['dataset2'])

      _hook((err) => {
        assert.strictEqual(err, null)
        // dataset1 fills MyTable, dataset2 fills MyTable2
        database.query('SELECT * FROM "MyTable"', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows.length, 3, 'the default seed was inserted')
          database.query('SELECT * FROM "MyTable2"', (err, res, rows2) => {
            assert.strictEqual(err, null)
            assert.strictEqual(rows2.length, 4, 'the extra set was inserted')
            done()
          })
        })
      })
    })

    it('should clean and insert nothing when no seed is set', (done) => {
      const _hook = datasets.resetHook()

      _hook((err) => {
        assert.strictEqual(err, null)
        database.query('SELECT * FROM "MyTable"', (err, res, rows) => {
          assert.strictEqual(err, null)
          assert.strictEqual(rows.length, 0)
          done()
        })
      })
    })
  })

  describe('clean deadlock retry', () => {
    let _exec = null
    let _query = null

    beforeEach(() => {
      _exec = database.exec
      _query = database.query
      // getTableList returns one table; the truncate is what we make deadlock
      database.exec = (name, cb) => cb(null, {}, [{ table_name: 'MyTable' }])
    })

    afterEach(() => {
      database.exec = _exec
      database.query = _query
    })

    it('should retry a 40P01 deadlock and then succeed', (done) => {
      let _calls = 0
      database.query = (sql, cb) => {
        _calls += 1
        return (_calls === 1) ? cb({ code: '40P01' }) : cb(null)
      }

      datasets.clean((err) => {
        assert.strictEqual(err, null)
        assert.strictEqual(_calls, 2, 'the deadlocked truncate was retried once')
        done()
      })
    })

    it('should give up after two retries and surface the deadlock', (done) => {
      let _calls = 0
      database.query = (sql, cb) => {
        _calls += 1
        return cb({ code: '40P01' })
      }

      datasets.clean((err) => {
        assert.strictEqual(err.code, '40P01')
        assert.strictEqual(_calls, 3, 'initial attempt plus two retries')
        done()
      })
    })

    it('should not retry a non-deadlock error', (done) => {
      let _calls = 0
      database.query = (sql, cb) => {
        _calls += 1
        return cb({ code: '42P01' })
      }

      datasets.clean((err) => {
        assert.strictEqual(err.code, '42P01')
        assert.strictEqual(_calls, 1, 'a different error is returned at once')
        done()
      })
    })
  })
})
