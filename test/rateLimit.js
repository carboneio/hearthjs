const assert = require('assert')
const rateLimit = require('../lib/rateLimit')
const logger = require('../lib/logger')

const ENV_KEYS = [
  'APP_RATE_LIMIT_GLOBAL',
  'APP_RATE_LIMIT_GLOBAL_MAX',
  'APP_RATE_LIMIT_GLOBAL_WINDOW',
  'APP_RATE_LIMIT_GLOBAL_MAX_KEYS',
  'APP_RATE_LIMIT_GLOBAL_SKIP',
  'APP_RATE_LIMIT_GLOBAL_HEADERS',
  'APP_RATE_LIMIT_ROUTE'
]

/**
 * Build a request the middleware can consume
 * @param {Object} overrides Fields to override
 */
function mockReq (overrides) {
  return Object.assign({
    ip: '203.0.113.7',
    url: '/api/thing',
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '203.0.113.7' }
  }, overrides)
}

/**
 * Capture what the middleware writes on the response
 */
function mockRes () {
  return {
    headers: {},
    statusCode: 200,
    endedWith: null,
    setHeader: function (name, value) {
      this.headers[name] = value
    },
    end: function (body) {
      this.endedWith = body
    }
  }
}

/**
 * Run one request through a middleware and report what happened
 * @param {Function} middleware Middleware under test
 * @param {Object} req Request, a fresh mock when omitted
 * @return {Object} { passed, req, res }
 */
function run (middleware, req) {
  const _req = req || mockReq()
  const _res = mockRes()
  let _passed = false

  middleware(_req, _res, () => {
    _passed = true
  })

  return { passed: _passed, req: _req, res: _res }
}

describe('Rate limit', () => {
  let _logs = []
  const _originalLog = logger.log
  const _savedEnv = {}

  before(() => {
    for (const _key of ENV_KEYS) {
      _savedEnv[_key] = process.env[_key]
    }
  })

  beforeEach(() => {
    _logs = []
    logger.log = (msg, level) => _logs.push({ msg: String(msg), level: level })

    for (const _key of ENV_KEYS) {
      delete process.env[_key]
    }
  })

  afterEach(() => {
    logger.log = _originalLog
    rateLimit._reset()

    for (const _key of ENV_KEYS) {
      if (_savedEnv[_key] === undefined) {
        delete process.env[_key]
      } else {
        process.env[_key] = _savedEnv[_key]
      }
    }
  })

  describe('engine: token bucket', () => {
    it('should allow a burst of max requests and reject the next one', () => {
      const _limiter = rateLimit._createLimiter(5, 60, 1000)

      for (let i = 0; i < 5; i++) {
        assert.strictEqual(_limiter.consume('k', 1000), 0, `request ${i + 1} of the burst must pass`)
      }

      assert.strictEqual(_limiter.consume('k', 1000) > 0, true, 'request over the burst must be rejected')
    })

    it('should return the milliseconds to wait on rejection', () => {
      const _limiter = rateLimit._createLimiter(1, 60, 1000)

      assert.strictEqual(_limiter.consume('k', 0), 0)

      const _wait = _limiter.consume('k', 0)

      // One token refills in exactly one window
      assert.strictEqual(_wait, 60000)
    })

    it('should refill gradually: after half a window, half the burst is back', () => {
      const _limiter = rateLimit._createLimiter(10, 10, 1000)

      for (let i = 0; i < 10; i++) {
        assert.strictEqual(_limiter.consume('k', 0), 0)
      }

      // 5 seconds later: 5 tokens back, not 6
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(_limiter.consume('k', 5000), 0, `token ${i + 1} must be back`)
      }

      assert.strictEqual(_limiter.consume('k', 5000) > 0, true, 'a 6th token must not exist yet')
    })

    it('should never refill above max', () => {
      const _limiter = rateLimit._createLimiter(3, 10, 1000)

      assert.strictEqual(_limiter.consume('k', 0), 0)

      // A year idle: still only 3 tokens
      const _later = 365 * 24 * 3600 * 1000

      for (let i = 0; i < 3; i++) {
        assert.strictEqual(_limiter.consume('k', _later), 0)
      }

      assert.strictEqual(_limiter.consume('k', _later) > 0, true)
    })

    it('should enforce the sustained rate of max per window', () => {
      // 5 tokens / 10s: one token every 2 seconds once the burst is spent
      const _limiter = rateLimit._createLimiter(5, 10, 1000)

      for (let i = 0; i < 5; i++) {
        _limiter.consume('k', 0)
      }

      assert.strictEqual(_limiter.consume('k', 1999) > 0, true, 'too early')
      assert.strictEqual(_limiter.consume('k', 2000), 0, 'one token after 2s')
      assert.strictEqual(_limiter.consume('k', 2001) > 0, true, 'and only one')
      assert.strictEqual(_limiter.consume('k', 4001), 0, 'one more 2s later')
    })

    it('should allow again once the returned wait has elapsed', () => {
      const _limiter = rateLimit._createLimiter(2, 30, 1000)

      _limiter.consume('k', 0)
      _limiter.consume('k', 0)

      const _wait = _limiter.consume('k', 0)

      assert.strictEqual(_wait > 0, true)
      // +1ms guards the float comparison
      assert.strictEqual(_limiter.consume('k', _wait + 1), 0)
    })

    it('should not refill when the clock does not move', () => {
      const _limiter = rateLimit._createLimiter(1, 60, 1000)

      assert.strictEqual(_limiter.consume('k', 500), 0)
      assert.strictEqual(_limiter.consume('k', 500) > 0, true)
      assert.strictEqual(_limiter.consume('k', 500) > 0, true)
    })

    it('should neither refill nor drain when the clock goes backwards', () => {
      const _limiter = rateLimit._createLimiter(2, 60, 1000)

      assert.strictEqual(_limiter.consume('k', 1000), 0)
      // Earlier timestamp: the bucket state must simply be consumed as-is
      assert.strictEqual(_limiter.consume('k', 0), 0)
      assert.strictEqual(_limiter.consume('k', 0) > 0, true)
    })

    it('should keep buckets independent between keys', () => {
      const _limiter = rateLimit._createLimiter(1, 60, 1000)

      assert.strictEqual(_limiter.consume('a', 0), 0)
      assert.strictEqual(_limiter.consume('a', 0) > 0, true)
      assert.strictEqual(_limiter.consume('b', 0), 0, 'another key must have its own bucket')
    })

    it('should report remaining tokens through peek without consuming', () => {
      const _limiter = rateLimit._createLimiter(5, 60, 1000)

      assert.strictEqual(_limiter.peek('k', 0), 5, 'an unknown key has a full bucket')

      _limiter.consume('k', 0)
      _limiter.consume('k', 0)

      assert.strictEqual(_limiter.peek('k', 0), 3)
      assert.strictEqual(_limiter.peek('k', 0), 3, 'peek must not consume')
    })
  })

  describe('test helpers: reset', () => {
    it('should hand a limiter a full bucket again after reset()', () => {
      const _limiter = rateLimit._createLimiter(2, 60, 1000)

      _limiter.consume('k', 0)
      _limiter.consume('k', 0)
      assert.strictEqual(_limiter.consume('k', 0) > 0, true, 'drained')

      _limiter.reset()

      assert.strictEqual(_limiter.consume('k', 0), 0, 'a reset bucket is full again')
      assert.strictEqual(_limiter.size(), 1)
    })

    it('should clear every wired-in limiter through reset()', () => {
      const _mwA = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /a')
      const _mwB = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /b')

      run(_mwA)
      run(_mwB)
      assert.strictEqual(run(_mwA).res.statusCode, 429)
      assert.strictEqual(run(_mwB).res.statusCode, 429)

      rateLimit.reset()

      assert.strictEqual(run(_mwA).passed, true, 'route A buckets cleared')
      assert.strictEqual(run(_mwB).passed, true, 'route B buckets cleared')
    })

    it('should not resurrect an ad-hoc _createLimiter through reset()', () => {
      // Only middleware limiters are tracked; a bare _createLimiter is not
      const _adhoc = rateLimit._createLimiter(1, 60, 1000)
      _adhoc.consume('k', 0)

      rateLimit.reset()

      assert.strictEqual(_adhoc.consume('k', 0) > 0, true, 'an untracked limiter is untouched')
    })
  })

  describe('test helpers: enable / disable / APP_RATE_LIMIT_ROUTE', () => {
    it('should bypass route limiters after disable(), and block again after enable()', () => {
      const _mw = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      rateLimit.disable()
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(run(_mw).passed, true, 'disabled: route limiter passes through')
      }

      rateLimit.enable()
      assert.strictEqual(run(_mw).passed, true)
      assert.strictEqual(run(_mw).res.statusCode, 429, 'enabled again: the limit blocks')
    })

    it('should turn route limits off from APP_RATE_LIMIT_ROUTE=false, and warn', () => {
      process.env.APP_RATE_LIMIT_ROUTE = 'false'

      // Reading the config (as the server does at boot) sets the route switch
      rateLimit._globalMiddleware(null)

      const _route = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      for (let i = 0; i < 5; i++) {
        assert.strictEqual(run(_route).passed, true, 'route limiter bypassed')
      }

      const _warn = _logs.filter((log) => log.level === 'warn' && log.msg.includes('per-route rate limits are OFF'))

      assert.strictEqual(_warn.length, 1, 'a downgrade must be loud')
    })

    it('should leave the GLOBAL net running while route limits are off', () => {
      // The whole point of two switches: they are independent
      process.env.APP_RATE_LIMIT_ROUTE = 'false'
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'

      const _global = rateLimit._globalMiddleware(null)
      const _route = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      // Route limits off...
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(run(_route).passed, true, 'route limiter is off')
      }

      // ...but the global net still enforces
      assert.strictEqual(run(_global).passed, true)
      assert.strictEqual(run(_global).res.statusCode, 429, 'the global net is unaffected by APP_RATE_LIMIT_ROUTE')
    })

    it('should let a dedicated test flip on, assert 429, and disable again', () => {
      // The full carbone-account pattern, in miniature: route limits off in the
      // test config, one test turns them on.
      process.env.APP_RATE_LIMIT_ROUTE = 'false'
      rateLimit._globalMiddleware(null)                                  // reads the switch → route off
      const _login = rateLimit._routeMiddleware({ max: 3, window: 300 }, 'POST /api/login')

      // The rest of the suite: route limits off, no interference
      for (let i = 0; i < 10; i++) {
        assert.strictEqual(run(_login).passed, true)
      }

      // before(): enable(), then N+1 from one IP → 429
      rateLimit.enable()
      assert.strictEqual(run(_login).passed, true)
      assert.strictEqual(run(_login).passed, true)
      assert.strictEqual(run(_login).passed, true)
      assert.strictEqual(run(_login).res.statusCode, 429, 'the 4th attempt is limited')

      // afterEach(): reset() the buckets; after(): disable() again
      rateLimit.reset()
      rateLimit.disable()
      assert.strictEqual(run(_login).passed, true, 'disabled again for the next test')
    })

    it('should keep route limits on by default (APP_RATE_LIMIT_ROUTE absent), silently', () => {
      rateLimit._globalMiddleware(null)

      const _route = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      assert.strictEqual(run(_route).passed, true)
      assert.strictEqual(run(_route).res.statusCode, 429, 'per-route limits are on by default')
      assert.strictEqual(_logs.filter((log) => log.msg.includes('per-route rate limits are OFF')).length, 0)
    })
  })

  describe('engine: generation rotation', () => {
    it('should forget a key idle for two windows and hand back a full bucket', () => {
      const _limiter = rateLimit._createLimiter(3, 10, 1000)

      for (let i = 0; i < 3; i++) {
        _limiter.consume('k', 0)
      }

      assert.strictEqual(_limiter.consume('k', 1) > 0, true, 'drained')

      // Two rotations later the key is gone: full burst again
      _limiter.consume('other1', 10001)
      _limiter.consume('other2', 20002)

      for (let i = 0; i < 3; i++) {
        assert.strictEqual(_limiter.consume('k', 20003), 0, `token ${i + 1} of the fresh bucket`)
      }
    })

    it('should migrate a hot key with its remaining tokens across a rotation', () => {
      // window 10s, max 10: refill is 1 token/s
      const _limiter = rateLimit._createLimiter(10, 10, 1000)

      for (let i = 0; i < 10; i++) {
        _limiter.consume('k', 9900)
      }

      // 200ms later a rotation happened; a fresh bucket would allow 10 more.
      // The migrated one refilled only ~0.2 token: everything is rejected.
      assert.strictEqual(_limiter.consume('k', 10100) > 0, true, 'the drained state must survive the rotation')
    })

    it('should drop the old generation from the key count', () => {
      const _limiter = rateLimit._createLimiter(1, 10, 1000)

      _limiter.consume('a', 0)
      _limiter.consume('b', 0)
      assert.strictEqual(_limiter.size(), 2)

      // First rotation: a and b move to the old generation
      _limiter.consume('c', 10001)
      assert.strictEqual(_limiter.size(), 3)

      // Second rotation: a and b are dropped wholesale
      _limiter.consume('d', 20002)
      assert.strictEqual(_limiter.size(), 2)
    })

    it('should drop both generations at once after an idle gap of two windows', () => {
      const _limiter = rateLimit._createLimiter(1, 10, 1000)

      _limiter.consume('a', 0)
      _limiter.consume('b', 0)
      assert.strictEqual(_limiter.size(), 2)

      // Long silence: everything is stale, the first request cleans it all
      _limiter.consume('c', 100000)
      assert.strictEqual(_limiter.size(), 1, 'stale generations must not survive an idle gap')
    })
  })

  describe('engine: maxKeys overflow', () => {
    it('should limit an unknown key above maxKeys through a shared overflow bucket', () => {
      const _limiter = rateLimit._createLimiter(2, 60, 1)

      assert.strictEqual(_limiter.consume('k1', 0), 0)

      // The table is full: 'spill' never gets its own bucket, but is limited
      assert.strictEqual(_limiter.consume('spill', 0), -1)
      assert.strictEqual(_limiter.consume('spill', 0), -1)
      assert.strictEqual(_limiter.consume('spill', 0) > 0, true, 'the shared budget is spent')
    })

    it('should not let one poisoned overflow slot lock out every stranger', () => {
      const _limiter = rateLimit._createLimiter(1, 60, 1)

      _limiter.consume('k1', 0)

      // 'spill' drains its own ring slot...
      assert.strictEqual(_limiter.consume('spill', 0), -1)
      assert.strictEqual(_limiter.consume('spill', 0) > 0, true)

      // ...but strangers hashing to other slots keep their shared budget
      assert.strictEqual(_limiter.consume('stranger-a', 0), -1, 'another slot, another collective bucket')
      assert.strictEqual(_limiter.consume('stranger-b', 0), -1)
    })

    it('should keep serving tracked keys when the table is full', () => {
      const _limiter = rateLimit._createLimiter(3, 60, 1)

      assert.strictEqual(_limiter.consume('k1', 0), 0)
      assert.strictEqual(_limiter.consume('spill', 0), -1)
      assert.strictEqual(_limiter.consume('k1', 0), 0, 'a tracked key keeps its own bucket')
    })

    it('should refill the overflow buckets over time', () => {
      const _limiter = rateLimit._createLimiter(1, 10, 1)

      _limiter.consume('k1', 0)

      assert.strictEqual(_limiter.consume('spill', 0), -1)
      assert.strictEqual(_limiter.consume('spill', 1) > 0, true, 'overflow bucket drained')
      assert.strictEqual(_limiter.consume('spill', 10002), -1, 'overflow bucket refilled a window later')
    })
  })

  describe('profiles', () => {
    it('should reject an invalid max', () => {
      assert.throws(() => rateLimit.define('p', { max: 0 }), /max must be a number >= 1/)
      assert.throws(() => rateLimit.define('p', { max: 'a lot' }), /max must be a number >= 1/)
      assert.throws(() => rateLimit.define('p', { max: NaN }), /max must be a number >= 1/)
    })

    it('should reject an invalid window', () => {
      assert.throws(() => rateLimit.define('p', { window: 0 }), /window must be a number of seconds > 0/)
      assert.throws(() => rateLimit.define('p', { window: -5 }), /window/)
    })

    it('should reject an invalid maxKeys', () => {
      assert.throws(() => rateLimit.define('p', { maxKeys: 0 }), /maxKeys must be an integer >= 1/)
      assert.throws(() => rateLimit.define('p', { maxKeys: 1.5 }), /maxKeys/)
    })

    it('should reject an unknown option: a typo must never ship unlimited', () => {
      assert.throws(() => rateLimit.define('p', { max: 5, windows: 60 }), /Unknown option 'windows'/)
    })

    it('should reject an invalid scope, key, dryRun, onLimit and message', () => {
      assert.throws(() => rateLimit.define('p', { scope: 'global' }), /scope must be 'shared' or 'route'/)
      assert.throws(() => rateLimit.define('p', { key: '127.0.0.1' }), /key must be a function/)
      assert.throws(() => rateLimit.define('p', { dryRun: 'yes' }), /dryRun must be a boolean/)
      assert.throws(() => rateLimit.define('p', { onLimit: true }), /onLimit must be a function/)
      assert.throws(() => rateLimit.define('p', { message: 42 }), /message must be a string/)
    })

    it('should reject a duplicate or empty profile name', () => {
      rateLimit.define('p', { max: 5 })
      assert.throws(() => rateLimit.define('p', { max: 5 }), /already been defined/)
      assert.throws(() => rateLimit.define('', { max: 5 }), /non-empty string/)
    })

    it('should throw at startup on an unknown profile reference', () => {
      assert.throws(() => rateLimit._routeMiddleware('nope', 'GET /x'), /profile 'nope' is not defined/)
    })

    it('should accept an inline profile object on a route', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).res.statusCode, 429)
    })

    it('should share one budget across routes with scope shared', () => {
      rateLimit.define('pipe', { max: 2, window: 60 })

      const _routeA = rateLimit._routeMiddleware('pipe', 'POST /a')
      const _routeB = rateLimit._routeMiddleware('pipe', 'POST /b')

      assert.strictEqual(run(_routeA).passed, true)
      assert.strictEqual(run(_routeB).passed, true)
      assert.strictEqual(run(_routeA).res.statusCode, 429, 'the budget is one pipe across both routes')
    })

    it('should give each route its own budget with scope route', () => {
      rateLimit.define('each', { max: 1, window: 60, scope: 'route' })

      const _routeA = rateLimit._routeMiddleware('each', 'POST /a')
      const _routeB = rateLimit._routeMiddleware('each', 'POST /b')

      assert.strictEqual(run(_routeA).passed, true)
      assert.strictEqual(run(_routeB).passed, true, 'route B must have its own bucket')
      assert.strictEqual(run(_routeA).res.statusCode, 429)
    })

    it('should clear definitions on reset', () => {
      rateLimit.define('p', { max: 5 })
      rateLimit._reset()
      assert.doesNotThrow(() => rateLimit.define('p', { max: 5 }))
    })

    it('should validate configure options', () => {
      assert.throws(() => rateLimit.configure({ keys: () => {} }), /Unknown rate limit option 'keys'/)
      assert.throws(() => rateLimit.configure({ skip: true }), /must be a function/)
      assert.throws(() => rateLimit.configure('nope'), /takes an object/)
      assert.doesNotThrow(() => rateLimit.configure({ key: (req) => req.ip }))
    })
  })

  describe('middleware behaviour', () => {
    it('should call next and leave the response untouched under the limit', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 3, window: 60 }, 'GET /x')
      const _result = run(_middleware)

      assert.strictEqual(_result.passed, true)
      assert.strictEqual(_result.res.statusCode, 200)
      assert.deepStrictEqual(_result.res.headers, {}, 'no header on the allowed path by default')
      assert.strictEqual(_result.res.endedWith, null)
    })

    it('should reject with 429, retry-after and a JSON body', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      run(_middleware)
      const _result = run(_middleware)

      assert.strictEqual(_result.passed, false)
      assert.strictEqual(_result.res.statusCode, 429)
      assert.strictEqual(_result.res.headers['content-type'], 'application/json')
      assert.strictEqual(_result.res.headers['cache-control'], 'no-store', 'a shared cache must never serve this 429 to someone else')

      const _retryAfter = parseInt(_result.res.headers['retry-after'], 10)

      assert.strictEqual(_retryAfter >= 1 && _retryAfter <= 60, true, `retry-after must be sane, got ${_retryAfter}`)
    })

    it('should answer the standard hearthjs response shape', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      run(_middleware)
      const _result = run(_middleware)
      const _body = JSON.parse(_result.res.endedWith.toString())

      assert.deepStrictEqual(_body, { success: false, data: {}, message: 'Too many requests, please retry later' })
    })

    it('should use the profile message in the body', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60, message: 'Doucement !' }, 'GET /x')

      run(_middleware)
      const _body = JSON.parse(run(_middleware).res.endedWith.toString())

      assert.strictEqual(_body.message, 'Doucement !')
    })

    it('should emit RateLimit headers on a route when the profile opts in', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 5, window: 60, headers: true }, 'GET /x')

      const _first = run(_middleware)

      assert.strictEqual(_first.res.headers['ratelimit-limit'], '5')
      assert.strictEqual(_first.res.headers['ratelimit-remaining'], '4')

      const _second = run(_middleware)

      assert.strictEqual(_second.res.headers['ratelimit-remaining'], '3')
    })

    it('should not emit RateLimit headers on a route by default', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 5, window: 60 }, 'GET /x')

      assert.strictEqual(run(_middleware).res.headers['ratelimit-limit'], undefined)
    })

    it('should reject a non-boolean headers option', () => {
      assert.throws(() => rateLimit.define('p', { headers: 'yes' }), /headers must be a boolean/)
    })

    it('should let rejected requests through in dryRun mode, but log them', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60, dryRun: true }, 'GET /x')

      run(_middleware)
      const _result = run(_middleware)

      assert.strictEqual(_result.passed, true, 'dryRun never blocks')
      assert.strictEqual(_result.res.statusCode, 200)

      const _warn = _logs.filter((log) => log.level === 'warn' && log.msg.includes('would reject'))

      assert.strictEqual(_warn.length, 1)
    })

    it('should hand rejections to a custom onLimit handler', () => {
      let _seen = null
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        onLimit: (req, res, info) => {
          _seen = info
          res.statusCode = 418
          res.end('custom')
        }
      }, 'GET /x')

      run(_middleware)
      const _result = run(_middleware)

      assert.strictEqual(_result.res.statusCode, 418)
      assert.strictEqual(_seen.profile, 'GET /x')
      assert.strictEqual(_seen.key, '203.0.113.7')
      assert.strictEqual(_seen.retryAfter >= 1, true)
    })

    it('should degrade to the built-in 429 when the onLimit handler throws', () => {
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        onLimit: () => { throw new Error('broken handler') }
      }, 'GET /x')

      run(_middleware)
      const _result = run(_middleware)

      assert.strictEqual(_result.passed, false, 'a throwing handler must not open the gate')
      assert.strictEqual(_result.res.statusCode, 429, 'the built-in rejection must take over')
      assert.strictEqual(_result.res.headers['retry-after'] !== undefined, true)
      assert.notStrictEqual(_result.res.endedWith, null, 'the response must be ended, never left hanging')

      const _error = _logs.filter((log) => log.level === 'error' && log.msg.includes('onLimit handler threw'))

      assert.strictEqual(_error.length, 1)
    })

    it('should aggregate rejection logs instead of logging each one', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      for (let i = 0; i < 20; i++) {
        run(_middleware)
      }

      const _warn = _logs.filter((log) => log.level === 'warn')

      assert.strictEqual(_warn.length, 1, `19 rejections in one tick must produce one line, got ${_warn.length}`)
      assert.strictEqual(_warn[0].msg.includes("Rate limit 'GET /x' rejected 1 request(s)"), true, _warn[0].msg)
    })

    it('should never log a full credential-looking key', () => {
      const _secret = 'Bearer super-secret-api-token-0123456789'
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: () => _secret
      }, 'GET /x')

      run(_middleware)
      run(_middleware)

      const _warn = _logs.filter((log) => log.level === 'warn')

      assert.strictEqual(_warn.length, 1)
      assert.strictEqual(_warn[0].msg.includes(_secret), false, 'the full key must not reach the logs')
      assert.strictEqual(_warn[0].msg.includes('Bearer s…'), true, 'only a short prefix may')
    })

    it('should neutralize control characters before a key reaches the logs', () => {
      // A newline forges a log line, ESC/CSI injects ANSI into a terminal
      const _hostile = 'abc\ndef\u001b[31m\u009bboom'
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: () => _hostile
      }, 'GET /x')

      run(_middleware)
      run(_middleware)

      const _warn = _logs.filter((log) => log.level === 'warn')

      assert.strictEqual(_warn.length, 1)
      assert.strictEqual(_warn[0].msg.includes('\n'), false, 'no forged log line')
      assert.strictEqual(_warn[0].msg.includes('\u001b'), false, 'no ANSI escape')
      assert.strictEqual(_warn[0].msg.includes('abc·def·'), true, 'control bytes are replaced, the rest kept')
    })

    it('should fall back loudly when the key generator is async', () => {
      // String(Promise) is one constant: every caller would share one bucket
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: async () => 'a-real-key'
      }, 'GET /x')

      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).res.statusCode, 429, 'fallback on req.ip')

      const _warn = _logs.filter((log) => log.msg.includes('no usable value'))

      assert.strictEqual(_warn.length, 1, 'the broken generator must be reported')
    })

    it('should not log a short opaque credential whole either', () => {
      const _secret = 'tok_12345678'
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: () => _secret
      }, 'GET /x')

      run(_middleware)
      run(_middleware)

      const _warn = _logs.filter((log) => log.level === 'warn')

      assert.strictEqual(_warn.length, 1)
      assert.strictEqual(_warn[0].msg.includes(_secret), false, 'a 12 char key must be truncated too')
      assert.strictEqual(_warn[0].msg.includes('tok_1234…'), true)
    })

    it('should truncate keys longer than 128 bytes: the tail cannot spread buckets', () => {
      const _prefix = 'a'.repeat(rateLimit._MAX_KEY_LENGTH)
      let _suffix = 'first'
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: () => _prefix + _suffix
      }, 'GET /x')

      assert.strictEqual(run(_middleware).passed, true)

      _suffix = 'second'

      assert.strictEqual(run(_middleware).res.statusCode, 429, 'a different tail must land in the same bucket')
    })

    it('should coerce a non-string key', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60, key: () => 42 }, 'GET /x')

      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).res.statusCode, 429)
    })

    it('should fall back to the client address when the key generator throws, and warn', () => {
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: () => { throw new Error('boom') }
      }, 'GET /x')

      assert.strictEqual(run(_middleware).passed, true, 'a throwing key generator must not block')
      assert.strictEqual(run(_middleware).res.statusCode, 429, 'and must not open the gate either')

      const _warn = _logs.filter((log) => log.msg.includes('key generator returned no usable value'))

      assert.strictEqual(_warn.length >= 1, true, 'the fallback must be loud, never silent')
    })

    it('should fall back loudly when the key generator returns nothing', () => {
      // The classic mistake: keying on an identity that is not attached yet
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: (req) => req.token && req.token.idAccount
      }, 'GET /x')

      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).res.statusCode, 429, 'fallback on req.ip: same client, same bucket')

      const _warn = _logs.filter((log) => log.msg.includes('key generator returned no usable value'))

      assert.strictEqual(_warn.length, 1, 'one aggregated warning, not one per request')
    })

    it('should fall back to the socket address when req.ip does not exist', () => {
      const _middleware = rateLimit._routeMiddleware({
        max: 1,
        window: 60,
        key: () => undefined
      }, 'GET /x')

      const _reqA = mockReq({ ip: undefined, socket: { remoteAddress: '198.51.100.1' } })
      const _reqB = mockReq({ ip: undefined, socket: { remoteAddress: '198.51.100.2' } })

      assert.strictEqual(run(_middleware, _reqA).passed, true)
      assert.strictEqual(run(_middleware, mockReq({ ip: undefined, socket: { remoteAddress: '198.51.100.1' } })).res.statusCode, 429)
      assert.strictEqual(run(_middleware, _reqB).passed, true, 'another socket, another bucket')
    })

    it('should warn once when the key table overflows', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 5, window: 60, maxKeys: 1, key: (req) => req.ip }, 'GET /x')

      run(_middleware, mockReq({ ip: '10.0.0.1' }))
      run(_middleware, mockReq({ ip: '10.0.0.2' }))
      run(_middleware, mockReq({ ip: '10.0.0.3' }))

      const _warn = _logs.filter((log) => log.msg.includes('key table is full'))

      assert.strictEqual(_warn.length, 1)
    })
  })

  describe('global middleware configuration', () => {
    it('should be off by default', () => {
      assert.strictEqual(rateLimit._globalMiddleware(null), null)
      assert.strictEqual(rateLimit._globalMiddleware({}), null)
      assert.strictEqual(rateLimit._globalMiddleware({ APP_RATE_LIMIT_GLOBAL: false }), null)
    })

    it('should turn on from the config file', () => {
      assert.notStrictEqual(rateLimit._globalMiddleware({ APP_RATE_LIMIT_GLOBAL: true }), null)
    })

    it('should turn on from the environment', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      assert.notStrictEqual(rateLimit._globalMiddleware(null), null)
    })

    it('should let the environment win over the config file', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'false'
      assert.strictEqual(rateLimit._globalMiddleware({ APP_RATE_LIMIT_GLOBAL: true }), null)
    })

    it('should warn loudly on an unrecognized APP_RATE_LIMIT_GLOBAL value', () => {
      // '1' reads as "on" to a human: staying silently off is a silent disable
      process.env.APP_RATE_LIMIT_GLOBAL = '1'

      assert.strictEqual(rateLimit._globalMiddleware(null), null)

      const _warn = _logs.filter((log) => log.level === 'warn' && log.msg.includes("APP_RATE_LIMIT_GLOBAL='1' is not recognized"))

      assert.strictEqual(_warn.length, 1)
      assert.strictEqual(_logs.length, 1, "'false' and unset must stay silent, only the ambiguous value warns")
    })

    it('should not warn when the switch is plainly off', () => {
      rateLimit._globalMiddleware(null)
      rateLimit._globalMiddleware({ APP_RATE_LIMIT_GLOBAL: false })
      process.env.APP_RATE_LIMIT_GLOBAL = 'false'
      rateLimit._globalMiddleware(null)

      assert.strictEqual(_logs.length, 0)
    })

    it('should parse scientific notation instead of truncating it', () => {
      // parseInt('1e9') === 1 would turn a fat-finger into a reject-everything limiter
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1e9'

      const _middleware = rateLimit._globalMiddleware(null)

      for (let i = 0; i < 5; i++) {
        assert.strictEqual(run(_middleware).passed, true, 'the burst is a billion, not one')
      }

      assert.strictEqual(_logs.length, 0, 'a valid number must not warn')
    })

    it('should honor APP_RATE_LIMIT_GLOBAL_MAX and reject above it', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '2'

      const _middleware = rateLimit._globalMiddleware(null)

      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).res.statusCode, 429)
    })

    it('should fall back to the default on an invalid value, and warn', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = 'many'

      const _middleware = rateLimit._globalMiddleware(null)

      // Default is 100: a small burst must pass entirely
      for (let i = 0; i < 10; i++) {
        assert.strictEqual(run(_middleware).passed, true)
      }

      const _warn = _logs.filter((log) => log.level === 'warn' && log.msg.includes("APP_RATE_LIMIT_GLOBAL_MAX='many'"))

      assert.strictEqual(_warn.length, 1, 'an invalid number on a security control must be loud')
    })

    it('should skip the APP_RATE_LIMIT_GLOBAL_SKIP prefixes', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'
      process.env.APP_RATE_LIMIT_GLOBAL_SKIP = '/health, /api/webhooks'

      const _middleware = rateLimit._globalMiddleware(null)

      for (let i = 0; i < 5; i++) {
        assert.strictEqual(run(_middleware, mockReq({ url: '/health' })).passed, true)
        assert.strictEqual(run(_middleware, mockReq({ url: '/api/webhooks/stripe?x=1' })).passed, true)
      }

      assert.strictEqual(run(_middleware, mockReq({ url: '/api/other' })).passed, true)
      assert.strictEqual(run(_middleware, mockReq({ url: '/api/other' })).res.statusCode, 429, 'other routes stay limited')
    })

    it('should match skip prefixes on segment boundaries only', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'
      process.env.APP_RATE_LIMIT_GLOBAL_SKIP = '/api/webhooks'

      const _middleware = rateLimit._globalMiddleware(null)

      // Exact and child paths are skipped
      for (let i = 0; i < 3; i++) {
        assert.strictEqual(run(_middleware, mockReq({ url: '/api/webhooks' })).passed, true)
        assert.strictEqual(run(_middleware, mockReq({ url: '/api/webhooks/stripe' })).passed, true)
      }

      // A sibling sharing the prefix string is NOT skipped
      run(_middleware, mockReq({ url: '/api/webhooksX' }))
      assert.strictEqual(run(_middleware, mockReq({ url: '/api/webhooksX' })).res.statusCode, 429, '/api/webhooksX must not ride the whitelist')
    })

    it('should compare skip prefixes on the decoded path', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'
      process.env.APP_RATE_LIMIT_GLOBAL_SKIP = '/health'

      const _middleware = rateLimit._globalMiddleware(null)

      // '/he%61lth' is what the router will dispatch as /health
      for (let i = 0; i < 3; i++) {
        assert.strictEqual(run(_middleware, mockReq({ url: '/he%61lth' })).passed, true)
      }

      // An undecodable path skips nothing: fail closed
      run(_middleware, mockReq({ url: '/health/%zz' }))
      assert.strictEqual(run(_middleware, mockReq({ url: '/health/%zz' })).res.statusCode, 429)
    })

    it('should treat a trailing slash on a skip prefix like none', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'
      process.env.APP_RATE_LIMIT_GLOBAL_SKIP = '/health/'

      const _middleware = rateLimit._globalMiddleware(null)

      for (let i = 0; i < 3; i++) {
        assert.strictEqual(run(_middleware, mockReq({ url: '/health' })).passed, true)
        assert.strictEqual(run(_middleware, mockReq({ url: '/health/db' })).passed, true)
      }
    })

    it('should use the configured skip function', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'

      rateLimit.configure({ skip: (req) => req.method === 'OPTIONS' })

      const _middleware = rateLimit._globalMiddleware(null)

      for (let i = 0; i < 5; i++) {
        assert.strictEqual(run(_middleware, mockReq({ method: 'OPTIONS' })).passed, true)
      }

      run(_middleware)
      assert.strictEqual(run(_middleware).res.statusCode, 429)
    })

    it('should not skip when the skip function throws', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'

      rateLimit.configure({ skip: () => { throw new Error('boom') } })

      const _middleware = rateLimit._globalMiddleware(null)

      assert.strictEqual(run(_middleware).passed, true)
      assert.strictEqual(run(_middleware).res.statusCode, 429, 'a broken skip must fail closed')
    })

    it('should use the configured key generator', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'

      rateLimit.configure({ key: (req) => req.headers.authorization || req.ip })

      const _middleware = rateLimit._globalMiddleware(null)

      assert.strictEqual(run(_middleware, mockReq({ headers: { authorization: 'A' } })).passed, true)
      assert.strictEqual(run(_middleware, mockReq({ headers: { authorization: 'B' } })).passed, true, 'another credential, another bucket')
      assert.strictEqual(run(_middleware, mockReq({ headers: { authorization: 'A' } })).res.statusCode, 429)
    })

    it('should use the configured onLimit handler', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'

      let _called = false

      rateLimit.configure({ onLimit: (req, res, info) => { _called = true; res.end('') } })

      const _middleware = rateLimit._globalMiddleware(null)

      run(_middleware)
      run(_middleware)
      assert.strictEqual(_called, true)
    })

    it('should emit the RateLimit headers when APP_RATE_LIMIT_GLOBAL_HEADERS is on', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '5'
      process.env.APP_RATE_LIMIT_GLOBAL_HEADERS = 'true'

      const _middleware = rateLimit._globalMiddleware(null)

      const _first = run(_middleware)

      assert.strictEqual(_first.res.headers['ratelimit-limit'], '5')
      assert.strictEqual(_first.res.headers['ratelimit-remaining'], '4')

      const _second = run(_middleware)

      assert.strictEqual(_second.res.headers['ratelimit-remaining'], '3')
    })
  })

  describe('composition', () => {
    it('should not leave any state on the request object', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'

      const _global = rateLimit._globalMiddleware(null)
      const _route = rateLimit._routeMiddleware({ max: 10, window: 60 }, 'GET /x')
      const _req = mockReq()
      const _keysBefore = Object.keys(_req).length

      run(_global, _req)
      run(_route, _req)

      // Each limiter reads its own clock: a shared timestamp taken at the top
      // of the chain would under-credit the refill by the parsing time
      assert.strictEqual(Object.keys(_req).length, _keysBefore, 'no property may be added to req')
    })

    it('should let the tighter route bucket reject what the global one allows', () => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'

      const _global = rateLimit._globalMiddleware(null)
      const _route = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'POST /login')

      /**
       * Chain the two middlewares like the server does
       * @param {Object} req Request
       */
      const _chain = (req) => {
        const _res = mockRes()
        let _passed = false

        _global(req, _res, () => _route(req, _res, () => { _passed = true }))
        return { passed: _passed, res: _res }
      }

      assert.strictEqual(_chain(mockReq()).passed, true)

      const _second = _chain(mockReq())

      assert.strictEqual(_second.passed, false)
      assert.strictEqual(_second.res.statusCode, 429)
    })
  })

  describe('req.ip, the default key', () => {
    const compat = require('../lib/expressCompat')

    /**
     * A decorated request, like the ones the middleware sees on a real server
     * @param {Object} headers Request headers
     * @param {String} remoteAddress Socket peer address
     */
    function decoratedReq (headers, remoteAddress) {
      const _req = { headers: headers, url: '/api/thing', method: 'GET', socket: { remoteAddress: remoteAddress } }

      compat.decorateRequest(_req)
      return _req
    }

    afterEach(() => {
      compat.setTrustProxy(false)
    })

    it('should exist and be the socket address by default', () => {
      assert.strictEqual(decoratedReq({}, '198.51.100.9').ip, '198.51.100.9')
    })

    it('should ignore X-Forwarded-For when the proxy is not trusted', () => {
      const _req = decoratedReq({ 'x-forwarded-for': '6.6.6.6' }, '198.51.100.9')

      assert.strictEqual(_req.ip, '198.51.100.9', 'a spoofed header must not choose the bucket')
    })

    it('should use the RIGHTMOST X-Forwarded-For hop when the proxy is trusted', () => {
      compat.setTrustProxy(true)

      // The leftmost value is client-supplied when the proxy appends: an
      // attacker sending 'X-Forwarded-For: 6.6.6.6' gets 6.6.6.6, 198.51.100.9
      const _req = decoratedReq({ 'x-forwarded-for': '6.6.6.6, 198.51.100.9' }, '10.0.0.1')

      assert.strictEqual(_req.ip, '198.51.100.9', 'only the hop our own proxy appended is trustworthy')
    })

    it('should fall back to the socket when the trusted header is absent or empty', () => {
      compat.setTrustProxy(true)

      assert.strictEqual(decoratedReq({}, '198.51.100.9').ip, '198.51.100.9')
      assert.strictEqual(decoratedReq({ 'x-forwarded-for': '  ' }, '198.51.100.9').ip, '198.51.100.9')
    })

    it('should be assignable without throwing, and the assignment wins', () => {
      const _req = decoratedReq({}, '198.51.100.9')

      // A getter-only property would throw here in strict mode
      assert.doesNotThrow(() => { _req.ip = '10.0.0.1' })
      assert.strictEqual(_req.ip, '10.0.0.1', 'an explicit assignment must win over the derived value')
    })

    it('should give every spoofed X-Forwarded-For the same bucket when untrusted', () => {
      const _middleware = rateLimit._routeMiddleware({ max: 1, window: 60 }, 'GET /x')

      const _first = decoratedReq({ 'x-forwarded-for': '1.1.1.1' }, '198.51.100.9')
      const _second = decoratedReq({ 'x-forwarded-for': '2.2.2.2' }, '198.51.100.9')

      assert.strictEqual(run(_middleware, _first).passed, true)
      assert.strictEqual(run(_middleware, _second).res.statusCode, 429, 'a random header per request must not mint fresh buckets')
    })
  })

  describe('over HTTP', () => {
    const http = require('http')
    const restana = require('restana')
    const compat = require('../lib/expressCompat')

    /**
     * One GET against the test server
     * @param {Number} port Server port
     * @param {String} path Request path
     * @param {Function} callback (statusCode, headers, body)
     */
    function get (port, path, callback) {
      http.get({ port: port, path: path }, (res) => {
        let _body = ''

        res.on('data', (chunk) => { _body += chunk })
        res.on('end', () => callback(res.statusCode, res.headers, _body))
      })
    }

    it('should serve the burst then answer 429 with retry-after and a JSON body', (done) => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '3'
      process.env.APP_RATE_LIMIT_GLOBAL_SKIP = '/health'

      const _service = restana({ securityHeaders: false, prioRequestsProcessing: false })

      _service.use(compat())
      _service.use(rateLimit._globalMiddleware(null))
      _service.get('/api/thing', (req, res) => res.send('ok'))
      _service.get('/health', (req, res) => res.send('up'))

      const _server = http.createServer(_service)

      _server.listen(9812, () => {
        let _remaining = 3

        /**
         * Spend the burst one request at a time
         */
        const _spendBurst = () => {
          get(9812, '/api/thing', (status) => {
            assert.strictEqual(status, 200)
            _remaining -= 1

            if (_remaining > 0) {
              return _spendBurst()
            }

            get(9812, '/api/thing', (status, headers, body) => {
              assert.strictEqual(status, 429)
              assert.strictEqual(parseInt(headers['retry-after'], 10) >= 1, true)
              assert.deepStrictEqual(JSON.parse(body), { success: false, data: {}, message: 'Too many requests, please retry later' })

              // The skipped prefix still answers while the API is throttled
              get(9812, '/health', (status) => {
                assert.strictEqual(status, 200)
                _server.close(done)
              })
            })
          })
        }

        _spendBurst()
      })
    }).timeout(10000)

    it('should key real requests on the connection, not on a spoofable header', (done) => {
      process.env.APP_RATE_LIMIT_GLOBAL = 'true'
      process.env.APP_RATE_LIMIT_GLOBAL_MAX = '1'

      const _service = restana({ securityHeaders: false, prioRequestsProcessing: false })

      _service.use(compat())
      _service.use(rateLimit._globalMiddleware(null))
      _service.get('/api/thing', (req, res) => res.send('ok'))

      const _server = http.createServer(_service)

      _server.listen(9813, () => {
        // A fresh X-Forwarded-For per request: without APP_TRUST_PROXY it must
        // not mint a fresh bucket, both requests come from the same socket
        http.get({ port: 9813, path: '/api/thing', headers: { 'x-forwarded-for': '1.1.1.1' } }, (first) => {
          first.resume()
          first.on('end', () => {
            assert.strictEqual(first.statusCode, 200)

            http.get({ port: 9813, path: '/api/thing', headers: { 'x-forwarded-for': '2.2.2.2' } }, (second) => {
              second.resume()
              second.on('end', () => {
                assert.strictEqual(second.statusCode, 429, 'the spoofed header must not bypass the limit')
                _server.close(done)
              })
            })
          })
        })
      })
    }).timeout(10000)
  })
})
