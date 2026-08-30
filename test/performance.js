const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const converter = require('../lib/converter')
const mustache = require('../lib/mustache')
const validation = require('../lib/validation')
const expressCompat = require('../lib/expressCompat')
const mustacheLib = require('../lib/mustache')
const rateLimit = require('../lib/rateLimit')
const logger = require('../lib/logger')

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

  describe('mustache loop rendering', () => {
    const LOOP_TEMPLATE = '{% data.names %} * {{ data.names[i] }}{$PRINT$}{{%}}'

    /**
     * Render the loop template over `count` items
     * @param {Number} count Number of items
     * @param {Function} callback Receives the elapsed milliseconds
     */
    function renderItems (count, callback) {
      const _data = { names: Array.from({ length: count }, (_, i) => `n${i}`) }
      const _start = process.hrtime.bigint()

      mustacheLib.render(LOOP_TEMPLATE, _data, (err) => {
        assert.strictEqual(err, null)
        callback(Number(process.hrtime.bigint() - _start) / 1e6)
      })
    }

    it('should build the sql parameters linearly', function (done) {
      this.timeout(120000)

      // Rebuilding the accumulator with concat per item made this quadratic:
      // 100k items took 9s, which is a request timeout on its own
      renderItems(10000, (small) => {
        renderItems(40000, (large) => {
          const ratio = large / Math.max(small, 0.001)

          assert.strictEqual(ratio < 10, true,
            `4x the items cost ${ratio.toFixed(1)}x the time (${small.toFixed(0)}ms -> ${large.toFixed(0)}ms), which is not linear`)
          done()
        })
      })
    })

    it('should render a large loop well under a request timeout', function (done) {
      this.timeout(120000)

      renderItems(100000, (ms) => {
        assert.strictEqual(ms < 5000, true, `100k items took ${ms.toFixed(0)}ms`)
        done()
      })
    })
  })

  describe('expressCompat.decodeParams', () => {
    const ITERATIONS = 200000

    /**
     * Cost of decoding one params shape, in nanoseconds per request
     * @param {Function} make Builds a fresh req for every call
     * @returns {Number} Nanoseconds per call
     */
    function nsPerCall (make) {
      const ms = bestOf(() => {
        for (let i = 0; i < ITERATIONS; i++) {
          expressCompat.decodeParams(make())
        }
      }, 5)

      return (ms * 1e6) / ITERATIONS
    }

    it('should skip values holding no percent escape', function () {
      this.timeout(60000)

      // The fast path is an indexOf: dropping it would make every request pay
      // for decodeURIComponent
      const plain = nsPerCall(() => ({ params: { a: 'alpha', b: 'beta', c: 'gamma' } }))
      const escaped = nsPerCall(() => ({ params: { a: 'a%2Fb', b: 'c%2Fd', c: 'e%2Ff' } }))

      assert.strictEqual(plain * 3 < escaped, true,
        `values without an escape (${plain.toFixed(1)}ns) should be far cheaper than decoded ones (${escaped.toFixed(1)}ns)`)
    })

    it('should stay cheap on the shapes every request pays for', function () {
      this.timeout(60000)

      // Catches a gross regression: decoding unconditionally, a regex per param,
      // a serialization round trip. It cannot see a switch to Object.keys, whose
      // small array V8 elides, so that one is covered by review, not by timing
      const empty = nsPerCall(() => ({ params: {} }))
      const three = nsPerCall(() => ({ params: { a: '1', b: '2', c: '3' } }))

      assert.strictEqual(empty < 200, true, `empty params cost ${empty.toFixed(1)}ns`)
      assert.strictEqual(three < 600, true, `three plain params cost ${three.toFixed(1)}ns`)
    })

    it('should stay linear in the number of params', function () {
      this.timeout(60000)

      /**
       * Build a params object once: constructing it per call costs more than
       * the function under test and would hide the complexity
       * @param {Number} count Number of params
       * @returns {Object} A req carrying that many params, none escaped
       */
      function reqWith (count) {
        const _params = {}

        for (let i = 0; i < count; i++) {
          _params[`k${i}`] = `v${i}`
        }

        return { params: _params }
      }

      const _one = reqWith(1)
      const _forty = reqWith(40)
      const one = nsPerCall(() => _one)
      const forty = nsPerCall(() => _forty)

      // Measured: linear sits near 120x, a nested loop over the params near
      // 3500x. 400x separates them with room on both sides
      assert.strictEqual(forty < one * 400, true,
        `40 params (${forty.toFixed(1)}ns) against 1 (${one.toFixed(1)}ns) is ${(forty / one).toFixed(0)}x, which is not linear`)
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

  describe('rateLimit', () => {
    const _originalLog = logger.log

    before(() => {
      // The rejected path logs (throttled): the file writer must not pollute
      // the timing
      logger.log = () => {}
    })

    after(() => {
      logger.log = _originalLog
      rateLimit._reset()
    })

    it('should consume in O(1) whatever the number of tracked keys', () => {
      /**
       * Time 1M consumes spread over `keyCount` existing keys
       * @param {Number} keyCount Number of distinct keys
       */
      function timeAt (keyCount) {
        const limiter = rateLimit._createLimiter(1e9, 60, 1e9)
        const keys = Array.from({ length: keyCount }, (_, i) => 'ip-' + i)

        for (let i = 0; i < keyCount; i++) {
          limiter.consume(keys[i], 0)
        }

        return bestOf(() => {
          for (let i = 0; i < 1e6; i++) {
            limiter.consume(keys[i % keyCount], 1)
          }
        }, 3)
      }

      const smallMs = timeAt(100)
      const largeMs = timeAt(100000)

      // O(1) stays flat; a scan, sweep or rehash per consume shows up as ~1000x
      assert.strictEqual(largeMs < smallMs * 5, true,
        `consume is not O(1): 100 keys ${smallMs.toFixed(1)}ms vs 100k keys ${largeMs.toFixed(1)}ms for 1M ops`)
    })

    it('should stay under budget on the hot path, allowed and rejected alike', () => {
      const allowed = rateLimit._createLimiter(1e9, 60, 1000)
      const allowedMs = bestOf(() => {
        for (let i = 0; i < 1e6; i++) {
          allowed.consume('k', i * 0.001)
        }
      }, 3)

      const rejected = rateLimit._createLimiter(1, 3600, 1000)

      rejected.consume('k', 0)

      const rejectedMs = bestOf(() => {
        for (let i = 0; i < 1e6; i++) {
          rejected.consume('k', 1)
        }
      }, 3)

      // ~10ms each on 2026 hardware; the budget only guards a catastrophic
      // regression (an accidental Promise, allocation or serialization per op)
      assert.strictEqual(allowedMs < 200, true, `1M allowed consumes took ${allowedMs.toFixed(1)}ms, expected < 200ms`)
      assert.strictEqual(rejectedMs < 200, true, `1M rejected consumes took ${rejectedMs.toFixed(1)}ms, expected < 200ms`)
    })

    it('should scale linearly on unique-key churn across rotations', () => {
      /**
       * Insert `count` never-seen keys through rotating windows. A fresh
       * limiter is built inside each timed run so every run does the real
       * insertion work, not just refills on an already-populated table.
       * @param {Number} count Number of unique keys
       */
      function timeChurn (count) {
        return bestOf(() => {
          const limiter = rateLimit._createLimiter(10, 0.05, 1e9)

          for (let i = 0; i < count; i++) {
            limiter.consume('key-' + i, i * 0.01)
          }
        }, 4)
      }

      // Warm up so the first real measurement is not paying JIT/allocation
      // startup that a noisy baseline would otherwise attribute to the small run
      timeChurn(50000)

      const smallMs = timeChurn(100000)
      const largeMs = timeChurn(200000)

      // Linear stays near 2x for 2x the keys; quadratic (a rehash or scan per
      // rotation) shows as ~4x. 3.5x separates them with margin for GC noise.
      assert.strictEqual(largeMs < smallMs * 3.5, true,
        `unique-key churn is not linear: 100k keys ${smallMs.toFixed(1)}ms -> 200k keys ${largeMs.toFixed(1)}ms`)
    })

    it('should keep the middleware allowed path under budget', () => {
      const middleware = rateLimit._routeMiddleware({ max: 1e9, window: 60 }, 'PERF /allowed')
      const req = { ip: '203.0.113.7', url: '/api/thing', method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.7' } }
      const res = { headers: {}, statusCode: 200, setHeader: function () {}, end: function () {} }
      const next = () => {}

      const ms = bestOf(() => {
        for (let i = 0; i < 1e6; i++) {
          middleware(req, res, next)
        }
      }, 3)

      // ~40ms measured: the clock read dominates. 400ms only catches a
      // regression that puts real work back on the allowed path.
      assert.strictEqual(ms < 400, true, `1M allowed middleware calls took ${ms.toFixed(1)}ms, expected < 400ms`)
    })

    it('should keep the 429 path cheaper than a serialization per rejection', () => {
      const middleware = rateLimit._routeMiddleware({ max: 1, window: 3600 }, 'PERF /rejected')
      const req = { ip: '203.0.113.7', url: '/api/thing', method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.7' } }
      const res = { headers: {}, statusCode: 200, setHeader: function () {}, end: function () {} }
      const next = () => {}

      middleware(req, res, next)

      const ms = bestOf(() => {
        for (let i = 0; i < 1e6; i++) {
          middleware(req, res, next)
        }
      }, 3)

      // The 429 body is pre-serialized: a JSON.stringify per rejection would
      // sit around 1ms per 1k ops and blow this budget at once
      assert.strictEqual(ms < 400, true, `1M rejections took ${ms.toFixed(1)}ms, expected < 400ms`)
    })

    it('should not allocate per request on a skipped path', () => {
      process.env.APP_RATE_LIMIT = 'true'
      process.env.APP_RATE_LIMIT_SKIP = '/health,/api/webhooks'

      const middleware = rateLimit._globalMiddleware(null)

      delete process.env.APP_RATE_LIMIT
      delete process.env.APP_RATE_LIMIT_SKIP

      const req = { ip: '203.0.113.7', url: '/api/webhooks/stripe', method: 'GET', headers: {}, socket: { remoteAddress: '203.0.113.7' } }
      const res = { headers: {}, statusCode: 200, setHeader: function () {}, end: function () {} }
      const next = () => {}

      const ms = bestOf(() => {
        for (let i = 0; i < 1e6; i++) {
          middleware(req, res, next)
        }
      }, 3)

      assert.strictEqual(ms < 400, true, `1M skipped calls took ${ms.toFixed(1)}ms, expected < 400ms`)
      rateLimit._reset()
    })

    it('should bound the key table by maxKeys whatever the attack cardinality', () => {
      const limiter = rateLimit._createLimiter(100, 60, 10000)

      // 100k distinct keys in one window: an attacker minting identities
      for (let i = 0; i < 100000; i++) {
        limiter.consume('garbage-' + i, 1)
      }

      assert.strictEqual(limiter.size() <= 10000, true,
        `the key table holds ${limiter.size()} keys, maxKeys=10000 must cap it`)
    })
  })
})
