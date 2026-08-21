const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const converter = require('../lib/converter')
const mustache = require('../lib/mustache')
const validation = require('../lib/validation')

/**
 * Performance regression tests. They guard algorithmic complexity and the
 * caches, not a millisecond count. Skip with SKIP_PERF_TESTS=1.
 */

const skip = process.env.SKIP_PERF_TESTS === '1'

/**
 * Run fn `runs` times and return the best wall-clock time in ms.
 * The best run is the least polluted by GC and by other work on the machine.
 * @param {Function} fn Function to measure
 * @param {Number} runs Number of runs
 */
function bestOf (fn, runs) {
  let best = Infinity

  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()

    fn()

    const ms = Number(process.hrtime.bigint() - start) / 1e6

    if (ms < best) {
      best = ms
    }
  }

  return best
}

/**
 * Same as bestOf for a callback based function
 * @param {Function} fn Function to measure, receives a done callback
 * @param {Number} runs Number of runs
 * @param {Function} callback Called with the best time in ms
 */
function bestOfAsync (fn, runs, callback) {
  let best = Infinity
  let remaining = runs

  const next = () => {
    if (remaining === 0) {
      return callback(best)
    }

    remaining -= 1

    const start = process.hrtime.bigint()

    fn(() => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6

      if (ms < best) {
        best = ms
      }

      return next()
    })
  }

  next()
}

const nestedModel = ['array', {
  id: ['<<userId>>'],
  name: ['userName'],
  company: ['object', {
    id: ['companyId'],
    name: ['companyName']
  }],
  invoices: ['array', {
    id: ['<<invoiceId>>'],
    total: ['invoiceTotal'],
    lines: ['array', {
      id: ['<<lineId>>'],
      label: ['lineLabel']
    }]
  }]
}]

/**
 * Build a realistic joined result set: nbUsers users, each with nbInvoices
 * invoices, each with nbLines lines
 */
function buildRows (nbUsers, nbInvoices, nbLines) {
  const rows = []

  for (let u = 0; u < nbUsers; u++) {
    for (let i = 0; i < nbInvoices; i++) {
      for (let l = 0; l < nbLines; l++) {
        rows.push({
          userId: u,
          userName: 'user' + u,
          companyId: u % 7,
          companyName: 'company' + (u % 7),
          invoiceId: u * 1000 + i,
          invoiceTotal: i * 10,
          lineId: u * 100000 + i * 100 + l,
          lineLabel: 'line' + l
        })
      }
    }
  }

  return rows
}

describe('Performance', function () {
  before(function () {
    if (skip) {
      this.skip()
    }
  })

  describe('converter.sqlToJson', () => {
    it('should scale linearly with the number of rows', function () {
      this.timeout(120000)

      // Quadratic shows up as ~4x per doubling, linear stays near 2x. Two
      // doublings are measured so one noisy sample cannot fail the test.
      const small = buildRows(2000, 2, 2) // 8 000 rows
      const medium = buildRows(4000, 2, 2) // 16 000 rows
      const large = buildRows(8000, 2, 2) // 32 000 rows

      const smallMs = bestOf(() => converter.sqlToJson(nestedModel, small), 3)
      const mediumMs = bestOf(() => converter.sqlToJson(nestedModel, medium), 3)
      const largeMs = bestOf(() => converter.sqlToJson(nestedModel, large), 3)

      const firstRatio = mediumMs / smallMs
      const secondRatio = largeMs / mediumMs

      assert.strictEqual(firstRatio < 3, true,
        `sqlToJson is not scaling linearly: 8k rows ${smallMs.toFixed(1)}ms -> 16k rows ${mediumMs.toFixed(1)}ms (${firstRatio.toFixed(2)}x for 2x the rows, expected < 3x)`)
      assert.strictEqual(secondRatio < 3, true,
        `sqlToJson is not scaling linearly: 16k rows ${mediumMs.toFixed(1)}ms -> 32k rows ${largeMs.toFixed(1)}ms (${secondRatio.toFixed(2)}x for 2x the rows, expected < 3x)`)
    })

    it('should convert a large result set well under the default query timeout', function () {
      this.timeout(120000)

      // 128 000 rows took more than a minute with the previous linear scans,
      // which is what made large exports time out.
      const rows = buildRows(32000, 2, 2)
      const ms = bestOf(() => converter.sqlToJson(nestedModel, rows), 2)

      assert.strictEqual(ms < 10000, true,
        `sqlToJson took ${ms.toFixed(0)}ms for ${rows.length} rows, expected < 10000ms`)
    })

    it('should still produce the expected structure on a large result set', function () {
      this.timeout(120000)

      const rows = buildRows(2000, 2, 2)
      const result = converter.sqlToJson(nestedModel, rows)

      assert.strictEqual(result.length, 2000)
      assert.strictEqual(result[0].id, 0)
      assert.strictEqual(result[0].name, 'user0')
      assert.strictEqual(result[0].company.name, 'company0')
      assert.strictEqual(result[0].invoices.length, 2)
      assert.strictEqual(result[0].invoices[0].lines.length, 2)
      assert.strictEqual(result[1999].id, 1999)
      assert.strictEqual(result[1999].invoices.length, 2)
      assert.strictEqual(result[1999].invoices[1].lines.length, 2)
    })
  })

  describe('converter._findIndexByKey', () => {
    it('should return the same index as a linear findIndex', () => {
      const indexes = converter._createIndexes()
      const arr = [{ id: 3, v: 'a' }, { id: 7, v: 'b' }, { id: 1, v: 'c' }]

      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 3), 0)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 7), 1)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 1), 2)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 42), -1)
    })

    it('should see elements appended after a first lookup', () => {
      const indexes = converter._createIndexes()
      const arr = [{ id: 1 }]

      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 1), 0)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 2), -1)

      arr.push({ id: 2 })

      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 2), 1)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 1), 0)
    })

    it('should return the first match when a value appears twice, like findIndex', () => {
      const indexes = converter._createIndexes()
      const arr = [{ id: 5 }, { id: 5 }]

      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 5), arr.findIndex(item => item.id === 5))
    })

    it('should handle null, undefined and NaN like findIndex', () => {
      const indexes = converter._createIndexes()
      const arr = [{ id: null }, { id: undefined }, { id: 0 }]

      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', null), 0)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', undefined), 1)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 0), 2)
      // NaN === NaN is false, so findIndex never matches it
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', NaN), -1)
    })

    it('should index several keys of the same array independently', () => {
      const indexes = converter._createIndexes()
      const arr = [{ id: 1, ref: 'a' }, { id: 2, ref: 'b' }]

      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'id', 2), 1)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'ref', 'a'), 0)
      assert.strictEqual(converter._findIndexByKey(indexes, arr, 'ref', 'b'), 1)
    })
  })

  describe('mustache file cache', () => {
    const rootPath = path.join(os.tmpdir(), 'hearthjs-perf-test')
    let filePath = null

    before(() => {
      fs.rmSync(rootPath, { recursive: true, force: true })
      fs.mkdirSync(rootPath, { recursive: true })

      let template = 'SELECT * FROM "user" WHERE "id" = {{ data.id }}\n'

      // A template big enough for the tokenizer to actually cost something
      for (let i = 0; i < 60; i++) {
        template += `  AND "col${i}" = {{ data.values[${i}] }}\n`
      }

      filePath = path.join(rootPath, 'perf.sql')
      fs.writeFileSync(filePath, template)
    })

    after(() => {
      fs.rmSync(rootPath, { recursive: true, force: true })
      mustache._clearFileCache()
    })

    it('should render a cached file faster than re-reading and re-parsing it', function (done) {
      this.timeout(60000)

      const data = { id: 1, values: [] }

      for (let i = 0; i < 60; i++) {
        data.values.push(i)
      }

      const uncached = (cb) => {
        // What the previous implementation did on every single query
        mustache._clearFileCache()
        fs.readFile(filePath, 'utf-8', (err, content) => {
          assert.strictEqual(err, null)
          mustache.render(content, data, null, {}, (err) => {
            assert.strictEqual(err, null)
            cb()
          })
        })
      }

      const cached = (cb) => {
        mustache.renderFile(filePath, data, null, {}, (err) => {
          assert.strictEqual(err, null)
          cb()
        })
      }

      // warm the cache up before measuring
      cached(() => {
        bestOfAsync(uncached, 30, (uncachedMs) => {
          bestOfAsync(cached, 30, (cachedMs) => {
            assert.strictEqual(cachedMs < uncachedMs, true,
              `cached rendering (${cachedMs.toFixed(3)}ms) should be faster than read + parse + render (${uncachedMs.toFixed(3)}ms)`)
            done()
          })
        })
      })
    })

    it('should not re-parse a file that did not change', function (done) {
      this.timeout(10000)
      mustache._clearFileCache()

      mustache.renderFile(filePath, { id: 1, values: [] }, null, {}, (err) => {
        assert.strictEqual(err, null)

        const firstTokens = mustache._fileCache.get(filePath).tokens

        mustache.renderFile(filePath, { id: 1, values: [] }, null, {}, (err) => {
          assert.strictEqual(err, null)
          assert.strictEqual(mustache._fileCache.get(filePath).tokens, firstTokens)
          done()
        })
      })
    })
  })

  describe('validation', () => {
    it('should validate a large payload in a reasonable time', function () {
      this.timeout(60000)

      const schemaIn = {
        email: ['type', 'mail'],
        name: ['<', 50, '>', 2],
        accounts: ['array', {
          label: ['<', 30],
          value: ['>', 0]
        }]
      }

      const buildData = () => {
        const data = { email: 'toto@gmail.com', name: 'John Doe', accounts: [] }

        for (let i = 0; i < 500; i++) {
          data.accounts.push({ label: 'label' + i, value: i + 1 })
        }

        return data
      }

      const ms = bestOf(() => {
        const result = validation.checkObject(schemaIn, buildData())

        assert.strictEqual(result.valid, true)
      }, 5)

      assert.strictEqual(ms < 500, true,
        `validating 500 nested items took ${ms.toFixed(1)}ms, expected < 500ms`)
    })
  })
})
