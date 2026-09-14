const logger = require('../lib/logger')
const assert = require('assert')

describe('Handler refusals versus faults', () => {
  const api = require('../lib/api')
  const server = require('../lib/server')

  it('should classify a refusal as a warning and a fault as an error', () => {
    // Handlers refuse with a string and report a fault with an Error, so a
    // deliberate 400 must not sit in the log next to a real failure
    assert.strictEqual(api._levelForHandlerError('Only an administrator can do that'), 'warn')
    assert.strictEqual(api._levelForHandlerError('Wrong password'), 'warn')
    // Anything that is not a string is treated as a fault, like _handleError does
    assert.strictEqual(api._levelForHandlerError({ message: 'unknown shape' }), 'error')
    assert.strictEqual(api._levelForHandlerError(new Error('connection terminated')), 'error')
    assert.strictEqual(api._levelForHandlerError(new TypeError('x is not a function')), 'error')
  })

  it('should log a refused before handler at warn, not error', (done) => {
    const _logged = []
    const _realLog = logger.log

    logger.log = (msg, level) => _logged.push({ msg: String(msg), level })

    const _res = {
      status: () => _res,
      json: () => {
        logger.log = _realLog
        assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
        assert.strictEqual(_logged[0].level, 'warn', JSON.stringify(_logged))
        done()
        return _res
      }
    }

    api._execBefore({ method: 'GET', url: '/x' }, _res, {
      before: (req, res, next) => next('Only an administrator can do that')
    })
  })

  it('should log a refused after handler at warn and pass its message on', (done) => {
    const _logged = []
    const _realLog = logger.log
    const _realEnv = server._env

    server._env = 'prod'
    logger.log = (msg, level) => _logged.push({ msg: String(msg), level })

    const _res = {
      status: () => _res,
      json: (body) => {
        logger.log = _realLog
        server._env = _realEnv
        assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
        assert.strictEqual(_logged[0].level, 'warn', JSON.stringify(_logged))
        assert.strictEqual(body.message, 'Price not valid')
        done()
        return _res
      }
    }

    api._execAfter({ method: 'GET', url: '/x' }, _res, {}, {
      after: (req, res, data, next) => next('Price not valid')
    })
  })

  it('should hide an after handler fault in production', (done) => {
    const _realLog = logger.log
    const _realEnv = server._env
    let _level = null

    server._env = 'prod'
    logger.log = (msg, level) => { _level = level }

    const _res = {
      status: () => _res,
      json: (body) => {
        logger.log = _realLog
        server._env = _realEnv
        assert.strictEqual(_level, 'error')
        assert.strictEqual(body.message, 'An error occured')
        done()
        return _res
      }
    }

    api._execAfter({ method: 'GET', url: '/x' }, _res, {}, {
      after: (req, res, data, next) => next(new Error('relation "User" does not exist'))
    })
  })

  it('should still log a thrown fault at error', (done) => {
    const _logged = []
    const _realLog = logger.log

    logger.log = (msg, level) => _logged.push({ msg: String(msg), level })

    const _res = {
      status: () => _res,
      json: () => {
        logger.log = _realLog
        assert.strictEqual(_logged[0].level, 'error', JSON.stringify(_logged))
        done()
        return _res
      }
    }

    api._execBefore({ method: 'GET', url: '/x' }, _res, {
      before: (req, res, next) => next(new Error('pool is closed'))
    })
  })
})

describe('Refusal messages sent to the caller', () => {
  const api = require('../lib/api')
  const server = require('../lib/server')

  let _realEnv = null

  beforeEach(() => { _realEnv = server._env })
  afterEach(() => { server._env = _realEnv })

  it('should pass a refusal through and hide a fault in production', () => {
    server._env = 'prod'
    assert.strictEqual(api._messageForClient('Wrong password'), 'Wrong password')
    assert.strictEqual(api._messageForClient(new Error('relation "User" does not exist')), 'An error occured')
  })

  it('should answer generically when a handler passes nothing back', () => {
    // Callers guard with `if (err)`, but the helper must not throw if one stops
    server._env = 'prod'
    assert.strictEqual(api._messageForClient(null), 'An error occured')
    assert.strictEqual(api._messageForClient(undefined), 'An error occured')
  })

  it('should keep the detail outside production, and when marked expose', () => {
    const _marked = new Error('quota exceeded')

    _marked.expose = true
    server._env = 'prod'
    assert.strictEqual(api._messageForClient(_marked), 'Error: quota exceeded')

    server._env = 'dev'
    assert.strictEqual(api._messageForClient(new Error('boom')), 'Error: boom')
  })
})

describe('Route declaration failures', () => {
  const api = require('../lib/api')
  const server = require('../lib/server')
  const rateLimit = require('../lib/rateLimit')

  let _logged = []
  let _readyCalls = 0
  let _realLog = null
  let _realReady = null
  let _realDeclared = 0
  let _realServed = 0
  let _realApp = null
  let _realAddons = null

  beforeEach(() => {
    _logged = []
    _readyCalls = 0
    _realLog = logger.log
    _realReady = server._setApiReady
    _realDeclared = api._nbRouteDeclared
    _realServed = api._nbRouteServed
    _realApp = server._app
    _realAddons = server._addons
    server._app = { get: () => {} }
    logger.log = (msg, level) => _logged.push({ msg: String(msg), level })
    server._setApiReady = () => { _readyCalls++ }
    api._reset()
    api._nbRouteDeclared = 0
    api._nbRouteServed = 0
    api._apiList.myApi = { routes: Object.create(null), schemas: { known: { before: (req, res, next) => next() } } }
    api._currentApiName = 'myApi'
  })

  afterEach(() => {
    logger.log = _realLog
    server._app = _realApp
    server._addons = _realAddons
    server._setApiReady = _realReady
    api._reset()
    api._nbRouteDeclared = _realDeclared
    api._nbRouteServed = _realServed
  })

  it('should report a duplicate api name as an error', () => {
    api.define('myApi', {}, () => {})

    assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
    assert.strictEqual(_logged[0].level, 'error')
    assert.strictEqual(_logged[0].msg.includes('has already been declared'), true)
  })

  it('should report a route declared without a schema as an error', () => {
    api._addRoute('GET', '/no-schema', undefined)

    assert.strictEqual(_logged[0].level, 'error')
    assert.strictEqual(_logged[0].msg.includes('You must specify a function or a schema'), true)
    // Readiness must still be re-evaluated or startup waits forever
    assert.strictEqual(_readyCalls, 1)
    assert.strictEqual(api._nbRouteDeclared, 0)
  })

  it('should report a duplicate route as an error', () => {
    api._apiList.myApi.routes['GET /dup'] = 'known'
    api._addRoute('GET', '/dup', 'known')

    assert.strictEqual(_logged[0].level, 'error')
    assert.strictEqual(_logged[0].msg.includes('has already been defined'), true)
    assert.strictEqual(_readyCalls, 1)
    assert.strictEqual(api._nbRouteDeclared, 0)
  })

  it('should report an unknown schema as an error, without counting the route', () => {
    // Counting a route that is never served leaves _nbRouteDeclared above
    // _nbRouteServed, and the server waits for a readiness that never comes
    api._addRoute('GET', '/typo', 'schemaThatDoesNotExist')

    assert.strictEqual(_logged[0].level, 'error')
    assert.strictEqual(_logged[0].msg.includes('was not found'), true)
    assert.strictEqual(api._nbRouteDeclared, 0, 'the route must not be counted')
    assert.strictEqual(_readyCalls, 1, 'readiness must be re-evaluated')
  })

  it('should stay ready after an unknown schema, so startup does not hang', () => {
    api._addRoute('GET', '/typo', 'schemaThatDoesNotExist')

    // The counters still agree, which is what _checkApiIsReady waits on
    assert.strictEqual(api._nbRouteDeclared, api._nbRouteServed)
  })

  it('should drop a route whose schema holds an unknown key, never ship it unguarded', () => {
    // A mistyped addon name is silently no addon at all, and an authentication
    // addon is the only thing standing between the route and an anonymous caller
    api._apiList.myApi.schemas.guarded = { needAuthentcation: true, before: (req, res, next) => next() }
    api._addRoute('GET', '/guarded', 'guarded')

    assert.strictEqual(_logged[0].level, 'error')
    assert.strictEqual(_logged[0].msg.includes('unknown schema key needAuthentcation'), true, _logged[0].msg)
    assert.strictEqual(api._nbRouteDeclared, 0, 'the route must not be counted')
    assert.strictEqual(api._nbRouteDeclared, api._nbRouteServed, 'startup must not hang')
    assert.strictEqual(_readyCalls, 1, 'readiness must be re-evaluated')
  })

  it('should name every unknown key, so one run fixes them all', () => {
    api._apiList.myApi.schemas.two = { rateLimt: 'write', successMg: 'ok', before: (req, res, next) => next() }
    api._addRoute('GET', '/two', 'two')

    assert.strictEqual(_logged[0].msg.includes('rateLimt, successMg'), true, _logged[0].msg)
  })

  it('should accept every key hearthjs itself reads', () => {
    // Guards the other way round: an incomplete allow-list would drop working routes
    rateLimit.define('declarationTest', { max: 10, window: 60 })
    api._apiList.myApi.schemas.full = {
      in: {},
      out: {},
      query: 'someQuery',
      before: (req, res, next) => next(),
      after: (req, res, next) => next(),
      middleware: [],
      function: (req, res) => res.end(),
      rateLimit: 'declarationTest',
      successMsg: 'done'
    }
    api._addRoute('GET', '/full', 'full')

    assert.strictEqual(_logged.length, 0, JSON.stringify(_logged))
    assert.strictEqual(api._nbRouteDeclared, 1)
  })

  it('should accept the schemaKeyName of a registered addon', () => {
    server._addons = [{ schemaKeyName: 'roles' }]
    api._apiList.myApi.schemas.withAddon = { roles: ['admin'], before: (req, res, next) => next() }
    api._addRoute('GET', '/with-addon', 'withAddon')

    assert.strictEqual(_logged.length, 0, JSON.stringify(_logged))
    assert.strictEqual(api._nbRouteDeclared, 1)
  })
})
