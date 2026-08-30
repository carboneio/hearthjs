const { performance } = require('node:perf_hooks')
const logger = require('./logger')

/** Keys are attacker-influenced: a 10 MB header must not become a 10 MB Map
    key. Counted in characters (UTF-16 code units): the stored key stays under
    ~256 bytes, whatever bytes the client sent. */
const MAX_KEY_LENGTH = 128
/** Logged keys may hold a credential: only this prefix may reach the logs */
const LOGGED_KEY_PREFIX = 8
/** Keys reach the logs and may carry attacker bytes: C0/C1 control characters
    forge log lines or inject ANSI escapes into an operator terminal. Node
    rejects C0 in raw header values, but C1 (0x80-0x9f, single-byte CSI
    included) is legal obs-text, and decoded query/body values carry anything. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
/** Unknown keys above maxKeys are spread over this many shared buckets, so
    poisoning the key table degrades new callers gracefully instead of
    collapsing them onto one bucket. Power of two: the hash is masked. */
const OVERFLOW_RING = 256
/** Rejections are aggregated: one log line at most per limiter per this period,
    otherwise the limiter converts a request flood into a log flood */
const LOG_THROTTLE_MS = 5000

const DEFAULT_MAX = 100
const DEFAULT_WINDOW = 60
const DEFAULT_MAX_KEYS = 100000
const DEFAULT_MESSAGE = 'Too many requests, please retry later'

const PROFILE_OPTIONS = ['max', 'window', 'key', 'scope', 'dryRun', 'onLimit', 'message', 'maxKeys']

/**
 * FNV-1a, masked onto the overflow ring: a cheap deterministic spread of
 * unknown keys. Not cryptographic and does not need to be — a slot collision
 * only means two strangers share one overflow bucket.
 * @param {String} key Normalized bucket key
 * @return {Number} Slot index in [0, OVERFLOW_RING)
 */
function overflowSlot (key) {
  let _hash = 0x811c9dc5

  for (let i = 0; i < key.length; i++) {
    _hash ^= key.charCodeAt(i)
    _hash = Math.imul(_hash, 0x01000193)
  }

  return (_hash >>> 0) & (OVERFLOW_RING - 1)
}

/**
 * Token bucket limiter over two map generations.
 *
 * The whole hot path is synchronous: node is single threaded, so the
 * read-modify-write on a bucket is atomic by construction. Expiry is O(1):
 * instead of sweeping, the maps rotate once per window and the old generation
 * is dropped wholesale. A key idle for a full window has a full bucket anyway,
 * so forgetting it and recreating it full is the same state.
 *
 * consume() takes the timestamp as an argument so tests drive the clock.
 *
 * @param {Number} max Bucket capacity, the allowed burst
 * @param {Number} windowSec Seconds to refill `max` tokens
 * @param {Number} maxKeys Hard cap on tracked keys, across both generations
 */
function createLimiter (max, windowSec, maxKeys) {
  const _windowMs = windowSec * 1000
  const _refillPerMs = max / _windowMs

  let _current = new Map()
  let _previous = new Map()
  let _lastRotation = -1

  // Keys above maxKeys are hashed onto a small ring of shared buckets:
  // unknown callers get limited collectively rather than not at all, memory
  // stays bounded, and an attacker filling the table with garbage keys only
  // poisons the slots their garbage hashes to — honest new callers on other
  // slots keep their own shared budget instead of a service-wide lockout
  const _overflow = new Array(OVERFLOW_RING).fill(null)

  /**
   * Refill lazily from the elapsed time and take one token.
   * The elapsed time is guarded against a clock going backwards: a bucket must
   * never be drained (or refilled) by a negative delta.
   * @param {Object} bucket { tokens, ts }
   * @param {Number} now Timestamp in milliseconds, monotonic
   * @return {Number} 0 when allowed, otherwise milliseconds to wait
   */
  const _take = (bucket, now) => {
    const _elapsed = now - bucket.ts

    if (_elapsed > 0) {
      const _tokens = bucket.tokens + _elapsed * _refillPerMs
      bucket.tokens = _tokens > max ? max : _tokens
      bucket.ts = now
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return 0
    }

    return (1 - bucket.tokens) / _refillPerMs
  }

  return {
    /**
     * Take one token for `key`.
     * @param {String} key Bucket owner, already normalized
     * @param {Number} now Timestamp in milliseconds, monotonic
     * @return {Number} 0 allowed, -1 allowed through the overflow bucket,
     *                  > 0 rejected, value is the milliseconds to wait
     */
    consume: function (key, now) {
      if (_lastRotation === -1) {
        _lastRotation = now
      } else if (now - _lastRotation >= _windowMs) {
        // Rotation only happens on traffic: after an idle gap of two windows
        // or more, both generations are stale (every bucket refilled to full
        // by now) and are dropped at once instead of lingering a rotation more
        if (now - _lastRotation >= 2 * _windowMs) {
          _previous = new Map()
          _current = new Map()
        } else {
          _previous = _current
          _current = new Map()
        }

        _lastRotation = now
      }

      let _bucket = _current.get(key)

      if (_bucket === undefined) {
        _bucket = _previous.get(key)

        // Migrate the still-active key, so its state survives the rotation.
        // Deleted from the old generation to keep the key count exact.
        if (_bucket !== undefined) {
          _previous.delete(key)
          _current.set(key, _bucket)
        }
      }

      if (_bucket === undefined) {
        if (_current.size + _previous.size >= maxKeys) {
          const _slot = overflowSlot(key)
          let _shared = _overflow[_slot]

          if (_shared === null) {
            _shared = { tokens: max, ts: now }
            _overflow[_slot] = _shared
          }

          const _wait = _take(_shared, now)
          return _wait === 0 ? -1 : _wait
        }

        // The single place bucket records are created: one shape, monomorphic
        _current.set(key, { tokens: max - 1, ts: now })
        return 0
      }

      return _take(_bucket, now)
    },

    /**
     * Tokens left for `key` without consuming, for the RateLimit-* headers
     * @param {String} key Bucket owner
     * @param {Number} now Timestamp in milliseconds
     * @return {Number} Remaining tokens, `max` for an unknown key
     */
    peek: function (key, now) {
      const _bucket = _current.get(key) ?? _previous.get(key)

      if (_bucket === undefined) {
        return max
      }

      const _elapsed = now - _bucket.ts
      const _tokens = (_elapsed > 0) ? _bucket.tokens + _elapsed * _refillPerMs : _bucket.tokens
      return _tokens > max ? max : _tokens
    },

    /**
     * Number of tracked keys across both generations
     */
    size: function () {
      return _current.size + _previous.size
    },

    /**
     * Drop all bucket state, keeping the limiter's configuration. For tests:
     * call between cases so one test's requests never spill into the next.
     */
    reset: function () {
      _current = new Map()
      _previous = new Map()
      _lastRotation = -1
      _overflow.fill(null)
    }
  }
}

const rateLimit = {
  _profiles: new Map(),
  _globalOptions: {},

  /** Exposed for the test suite */
  _createLimiter: createLimiter,
  _MAX_KEY_LENGTH: MAX_KEY_LENGTH,

  // Every limiter actually wired into a middleware, so a test can clear their
  // bucket state in one call. Ad-hoc limiters from _createLimiter are not here.
  _liveLimiters: [],

  // Whether per-route limits (the `rateLimit` schema keys) are active. Read
  // from APP_RATE_LIMIT_ROUTE at startup (default on), so a project defines its
  // limits normally — no dryRun test-seam in production code — and turns them
  // off in the test config. enable()/disable() flip it at runtime for one test.
  _routeActive: true,

  /**
   * Register a middleware limiter so reset() can reach it
   * @param {Object} limiter A createLimiter() instance
   * @return {Object} The same limiter
   */
  _track: function (limiter) {
    this._liveLimiters.push(limiter)
    return limiter
  },

  /**
   * Turn per-route limiting on at runtime, whatever APP_RATE_LIMIT_ROUTE said.
   * For a dedicated test: enable(), assert the 429, then disable() after.
   */
  enable: function () {
    this._routeActive = true
  },

  /**
   * Turn per-route limiting off at runtime: the route limiters pass through.
   */
  disable: function () {
    this._routeActive = false
  },

  /**
   * Clear the bucket state of every rate limiter, keeping the profiles and
   * their configuration. Call it in an afterEach so each test starts with full
   * buckets instead of inheriting the previous test's requests.
   */
  reset: function () {
    for (let i = 0; i < this._liveLimiters.length; i++) {
      this._liveLimiters[i].reset()
    }
  },

  /**
   * Declare a named profile, shared by every route that references it.
   * Misconfiguration throws: a rate limit must never be silently disabled.
   * @param {String} name Profile name referenced by schemas
   * @param {Object} options { max, window, key, scope, dryRun, onLimit, message, maxKeys }
   */
  define: function (name, options) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Rate limit profile name must be a non-empty string')
    }

    if (this._profiles.has(name)) {
      throw new Error(`Rate limit profile '${name}' has already been defined`)
    }

    const _profile = this._normalizeProfile(name, options)

    this._profiles.set(name, _profile)
  },

  /**
   * Override what the APP_RATE_LIMIT_GLOBAL* env keys cannot express on the global
   * limiter: the key generator, a skip function, a custom 429 handler
   * @param {Object} options { key, skip, onLimit }
   */
  configure: function (options) {
    if (options === null || typeof options !== 'object') {
      throw new Error('rateLimit.configure takes an object')
    }

    for (const _name of Object.keys(options)) {
      if (['key', 'skip', 'onLimit'].includes(_name) === false) {
        throw new Error(`Unknown rate limit option '${_name}'`)
      }

      if (options[_name] !== undefined && typeof options[_name] !== 'function') {
        throw new Error(`Rate limit option '${_name}' must be a function`)
      }
    }

    Object.assign(this._globalOptions, options)
  },

  /**
   * Put the module back in its initial state, for server restarts: profiles
   * are declared again by the project beforeInit function
   */
  _reset: function () {
    this._profiles = new Map()
    this._globalOptions = {}
    this._liveLimiters = []
    this._routeActive = true
  },

  /**
   * Validate and normalize a profile definition
   * @param {String} name Profile name, for error messages and logs
   * @param {Object} options User supplied options
   * @return {Object} Frozen profile
   */
  _normalizeProfile: function (name, options) {
    if (options === null || typeof options !== 'object') {
      throw new Error(`Rate limit profile '${name}' must be an object`)
    }

    for (const _key of Object.keys(options)) {
      if (PROFILE_OPTIONS.includes(_key) === false) {
        throw new Error(`Unknown option '${_key}' on rate limit profile '${name}'`)
      }
    }

    const _max = options.max ?? DEFAULT_MAX
    const _window = options.window ?? DEFAULT_WINDOW
    const _maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS

    if (Number.isFinite(_max) === false || _max < 1) {
      throw new Error(`Rate limit profile '${name}': max must be a number >= 1`)
    }

    if (Number.isFinite(_window) === false || _window <= 0) {
      throw new Error(`Rate limit profile '${name}': window must be a number of seconds > 0`)
    }

    if (Number.isInteger(_maxKeys) === false || _maxKeys < 1) {
      throw new Error(`Rate limit profile '${name}': maxKeys must be an integer >= 1`)
    }

    if (options.key !== undefined && typeof options.key !== 'function') {
      throw new Error(`Rate limit profile '${name}': key must be a function`)
    }

    if (options.scope !== undefined && options.scope !== 'shared' && options.scope !== 'route') {
      throw new Error(`Rate limit profile '${name}': scope must be 'shared' or 'route'`)
    }

    if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
      throw new Error(`Rate limit profile '${name}': dryRun must be a boolean`)
    }

    if (options.onLimit !== undefined && typeof options.onLimit !== 'function') {
      throw new Error(`Rate limit profile '${name}': onLimit must be a function`)
    }

    if (options.message !== undefined && typeof options.message !== 'string') {
      throw new Error(`Rate limit profile '${name}': message must be a string`)
    }

    return Object.freeze({
      name: name,
      max: _max,
      window: _window,
      maxKeys: _maxKeys,
      key: options.key ?? ((req) => req.ip),
      scope: options.scope ?? 'shared',
      dryRun: options.dryRun === true,
      onLimit: options.onLimit,
      message: options.message ?? DEFAULT_MESSAGE,
      // One shared limiter per profile, created on first use. Not part of the
      // frozen surface: routes with scope 'route' never touch it.
      shared: { limiter: null }
    })
  },

  /**
   * Middleware for the `rateLimit` schema key. Called at route registration:
   * an unknown profile name throws there, at startup, never at request time.
   * @param {String|Object} spec Profile name or inline profile options
   * @param {String} routeId 'METHOD /route', for anonymous profiles and logs
   * @return {Function} Middleware
   */
  _routeMiddleware: function (spec, routeId) {
    let _profile = null

    if (typeof spec === 'string') {
      _profile = this._profiles.get(spec)

      if (_profile === undefined) {
        throw new Error(`Rate limit profile '${spec}' is not defined. Declare it with hearthjs.rateLimit.define in beforeInit`)
      }
    } else {
      _profile = this._normalizeProfile(routeId, spec)
    }

    let _limiter = null

    if (_profile.scope === 'shared') {
      if (_profile.shared.limiter === null) {
        _profile.shared.limiter = this._track(createLimiter(_profile.max, _profile.window, _profile.maxKeys))
      }

      _limiter = _profile.shared.limiter
    } else {
      _limiter = this._track(createLimiter(_profile.max, _profile.window, _profile.maxKeys))
    }

    // runtimeToggle: a route limiter obeys APP_RATE_LIMIT_ROUTE / enable() /
    // disable(). The global net does not — it is gated by its own config key.
    return this._buildMiddleware(_profile, _limiter, { runtimeToggle: true })
  },

  /**
   * The global limiter, from the APP_RATE_LIMIT_GLOBAL* keys. Env vars win over
   * the config file, like the other APP_* keys. Also reads APP_RATE_LIMIT_ROUTE
   * here, since this runs once on every boot, to set whether per-route limits
   * are active.
   * @param {Object} config Loaded server config, may be null
   * @return {Function|null} Middleware, or null when the global net is off
   */
  _globalMiddleware: function (config) {
    const _read = (key) => (process.env[key] !== undefined) ? process.env[key] : (config !== null && config !== undefined ? config[key] : undefined)
    const _isTrue = (value) => value === true || value === 'true'

    // Per-route limits (the schema `rateLimit` keys) are on unless the config
    // turns them off. A downgrade of a security control is loud.
    const _route = _read('APP_RATE_LIMIT_ROUTE')
    this._routeActive = (_route === undefined) ? true : _isTrue(_route)

    if (this._routeActive === false) {
      logger.log('APP_RATE_LIMIT_ROUTE is false: per-route rate limits are OFF', 'warn')
    }

    const _enabled = _read('APP_RATE_LIMIT_GLOBAL')

    if (_isTrue(_enabled) === false) {
      // A security switch must never be silently ignored: '1', 'yes' or 'TRUE'
      // is someone who believes the global net is on
      if (_enabled !== undefined && _enabled !== false && _enabled !== 'false') {
        logger.log(`APP_RATE_LIMIT_GLOBAL='${_enabled}' is not recognized, the global net is OFF (only 'true' turns it on)`, 'warn')
      }

      return null
    }

    const _profile = this._normalizeProfile('global', {
      max: this._parsePositiveNumber('APP_RATE_LIMIT_GLOBAL_MAX', _read('APP_RATE_LIMIT_GLOBAL_MAX'), DEFAULT_MAX),
      window: this._parsePositiveNumber('APP_RATE_LIMIT_GLOBAL_WINDOW', _read('APP_RATE_LIMIT_GLOBAL_WINDOW'), DEFAULT_WINDOW),
      maxKeys: this._parsePositiveNumber('APP_RATE_LIMIT_GLOBAL_MAX_KEYS', _read('APP_RATE_LIMIT_GLOBAL_MAX_KEYS'), DEFAULT_MAX_KEYS),
      key: this._globalOptions.key,
      onLimit: this._globalOptions.onLimit
    })

    const _skipRaw = _read('APP_RATE_LIMIT_GLOBAL_SKIP')
    const _skipPrefixes = (typeof _skipRaw === 'string' && _skipRaw.length > 0)
      ? _skipRaw.split(',')
        .map((prefix) => prefix.trim())
        // '/health/' and '/health' must behave the same on segment matching
        .map((prefix) => (prefix !== '/') ? prefix.replace(/\/+$/, '') : prefix)
        .filter((prefix) => prefix.length > 0)
      : []

    return this._buildMiddleware(_profile, this._track(createLimiter(_profile.max, _profile.window, _profile.maxKeys)), {
      headers: _isTrue(_read('APP_RATE_LIMIT_GLOBAL_HEADERS')),
      skipPrefixes: _skipPrefixes,
      skip: this._globalOptions.skip
    })
  },

  /**
   * Parse a config value that must be a number > 0. Number(), not parseInt():
   * parseInt('1e9') silently truncates to 1, turning a fat-finger into a
   * limiter that rejects nearly everything. An invalid value is refused with
   * a loud warning, never a truncated parse.
   * @param {String} name Config key, for the warning
   * @param {*} value Raw config or env value
   * @param {Number} defaultValue Used when absent or invalid
   * @return {Number}
   */
  _parsePositiveNumber: function (name, value, defaultValue) {
    if (value === undefined) {
      return defaultValue
    }

    const _parsed = (typeof value === 'number') ? value : Number(value)

    if (Number.isFinite(_parsed) && _parsed > 0) {
      return _parsed
    }

    logger.log(`${name}='${value}' is not a number > 0, using the default ${defaultValue}`, 'warn')
    return defaultValue
  },

  /**
   * Neutralize and truncate a key before it reaches the logs. Control
   * characters are attacker bytes aimed at the log reader (forged lines, ANSI
   * escapes); a credential is cut to a prefix. A key of 8 characters or fewer
   * is logged whole — short keys are IPs and account ids, the very things the
   * log line is for. A credential that short is beyond this function's help.
   * @param {String} key Normalized bucket key
   * @return {String}
   */
  _keyForLog: function (key) {
    const _clean = key.replace(CONTROL_CHARS, '·')

    return (_clean.length > LOGGED_KEY_PREFIX) ? _clean.slice(0, LOGGED_KEY_PREFIX) + '…' : _clean
  },

  /**
   * Build the middleware around one limiter. Everything reusable is resolved
   * here, once at startup: the hot path avoids allocating on an allowed
   * request (one slice when skip prefixes meet a query string is the
   * exception) and reuses a pre-serialized body on a rejected one.
   * @param {Object} profile Normalized profile
   * @param {Object} limiter Limiter instance
   * @param {Object} options { headers, skipPrefixes, skip } global limiter extras
   * @return {Function} Middleware
   */
  _buildMiddleware: function (profile, limiter, options) {
    const _self = this
    const _keyFn = profile.key
    const _max = profile.max
    const _dryRun = profile.dryRun
    const _onLimit = profile.onLimit
    const _name = profile.name
    const _headers = options.headers === true
    const _skipPrefixes = options.skipPrefixes ?? []
    // The '/'-suffixed variants are built once: concatenating per request made
    // the skipped path slower than the limited one
    const _skipChildren = _skipPrefixes.map((prefix) => prefix + '/')
    const _skipFn = options.skip
    // Route limiters obey the APP_RATE_LIMIT_ROUTE switch (and enable/disable);
    // the global net does not
    const _runtimeToggle = options.runtimeToggle === true

    // An attacker must never make us serialize: the 429 body is built once
    const _body = Buffer.from(JSON.stringify({ success: false, data: {}, message: profile.message }))

    // Rejections are counted and flushed as one aggregated line
    const _rejections = { count: 0, lastLogAt: -Infinity }
    const _overflowLog = { lastLogAt: -Infinity }
    const _fallbackLog = { lastLogAt: -Infinity }

    /**
     * One aggregated warn line, at most every LOG_THROTTLE_MS
     * @param {Number} now Timestamp in milliseconds
     * @param {String} key Last rejected key
     */
    const _logRejection = (now, key) => {
      _rejections.count += 1

      if (now - _rejections.lastLogAt >= LOG_THROTTLE_MS) {
        const _verb = _dryRun ? 'would reject' : 'rejected'
        logger.log(`Rate limit '${_name}' ${_verb} ${_rejections.count} request(s), last key '${_self._keyForLog(key)}'`, 'warn')
        _rejections.lastLogAt = now
        _rejections.count = 0
      }
    }

    return function rateLimitMiddleware (req, res, next) {
      // Per-route limits turned off by config or disable(): pass through
      if (_runtimeToggle === true && _self._routeActive === false) {
        return next()
      }

      // Each limiter reads its own clock: reusing an earlier middleware's
      // timestamp would under-credit the refill by the parsing time in between
      const _now = performance.now()

      if (_skipPrefixes.length > 0) {
        const _query = req.url.indexOf('?')
        let _path = (_query === -1) ? req.url : req.url.slice(0, _query)

        // Compared decoded and on segment boundaries: '/api/webhooks' must
        // skip '/api/webhooks/stripe', but neither '/api/webhooksX' nor an
        // encoded alias the router would decode later. An undecodable path
        // skips nothing: fail closed.
        if (_path.indexOf('%') !== -1) {
          try {
            _path = decodeURIComponent(_path)
          } catch (e) {
            _path = null
          }
        }

        if (_path !== null) {
          for (let i = 0; i < _skipPrefixes.length; i++) {
            const _prefix = _skipPrefixes[i]

            if (_path === _prefix || _prefix === '/' || _path.startsWith(_skipChildren[i]) === true) {
              return next()
            }
          }
        }
      }

      if (_skipFn !== undefined) {
        let _skipped = false

        // A throwing skip function must not open the gate
        try {
          _skipped = _skipFn(req) === true
        } catch (e) {
          _skipped = false
        }

        if (_skipped === true) {
          return next()
        }
      }

      let _key = null

      // A throwing key generator must not open the gate
      try {
        _key = _keyFn(req)
      } catch (e) {
        _key = null
      }

      // The intended dimension is missing: the generator threw, returned
      // nothing, or returned something that is not a usable key — an async
      // generator's Promise or a plain object would stringify to one constant
      // ('[object Promise]'), silently collapsing every caller into a single
      // bucket. Fall back to the connection identity, and say so.
      if (_key === undefined || _key === null || _key === '' || typeof _key === 'object' || typeof _key === 'function') {
        if (req.ip !== undefined) {
          _key = req.ip
        } else if (req.socket !== undefined && req.socket.remoteAddress !== undefined) {
          _key = req.socket.remoteAddress
        } else {
          _key = 'unknown'
        }

        if (_now - _fallbackLog.lastLogAt >= LOG_THROTTLE_MS) {
          logger.log(`Rate limit '${_name}' key generator returned no usable value (must return a string, synchronously), falling back to the client address`, 'warn')
          _fallbackLog.lastLogAt = _now
        }
      }

      if (typeof _key !== 'string') {
        _key = String(_key)
      }

      if (_key.length > MAX_KEY_LENGTH) {
        _key = _key.slice(0, MAX_KEY_LENGTH)
      }

      const _wait = limiter.consume(_key, _now)

      if (_wait <= 0) {
        if (_wait === -1 && _now - _overflowLog.lastLogAt >= LOG_THROTTLE_MS) {
          logger.log(`Rate limit '${_name}' key table is full (${profile.maxKeys} keys), new keys share ${OVERFLOW_RING} collective buckets — raise maxKeys if this is legitimate traffic`, 'warn')
          _overflowLog.lastLogAt = _now
        }

        if (_headers === true) {
          // peek redoes one Map.get after consume: acceptable, headers are off
          // by default. Reset advertises the seconds until the bucket is FULL
          // again — the most conservative back-off — not until the next token.
          const _remaining = limiter.peek(_key, _now)
          res.setHeader('ratelimit-limit', String(_max))
          res.setHeader('ratelimit-remaining', String(Math.floor(_remaining)))
          res.setHeader('ratelimit-reset', String(Math.ceil((_max - _remaining) * profile.window / _max)))
        }

        return next()
      }

      _logRejection(_now, _key)

      if (_dryRun === true) {
        return next()
      }

      const _retryAfter = Math.max(1, Math.ceil(_wait / 1000))

      if (_onLimit !== undefined) {
        // The one user function running on the attack path: a throw here must
        // degrade to the built-in 429, never crash or leave the socket hanging
        try {
          return _onLimit(req, res, { profile: _name, key: _key, retryAfter: _retryAfter })
        } catch (e) {
          logger.log(`Rate limit '${_name}' onLimit handler threw: ${e.toString()}`, 'error')

          if (res.headersSent === true) {
            return
          }
        }
      }

      res.setHeader('retry-after', String(_retryAfter))
      // A shared cache keys on the URL, not on the rate limit key: a cached
      // 429 would be served to innocent callers of the same path
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json')
      res.statusCode = 429
      return res.end(_body)
    }
  }
}

module.exports = rateLimit
