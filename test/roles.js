const assert = require('assert')
const roles = require('../lib/roles')
const api = require('../lib/api')
const server = require('../lib/server')
const logger = require('../lib/logger')
const rateLimit = require('../lib/rateLimit')

/**
 * The table every test starts from: two roles, one permission each, one shared
 * @param {Object} overrides Options to replace
 */
function configure (overrides) {
  return roles.configure(Object.assign({
    roles: {
      ADMIN: ['members.read', 'members.write', 'apikeys.read'],
      USER: ['members.read']
    },
    resolve: (req) => req.token?.role,
    requires: (route) => route.schema.needAuthentication === true
  }, overrides))
}

/**
 * Capture what a refusal writes on the response
 */
function mockRes () {
  return {
    headers: {},
    statusCode: 200,
    headersSent: false,
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
 * Run one request through a guard and report whether it passed
 * @param {Function} middleware Guard under test
 * @param {Object} req Request
 * @return {Object} { passed, res }
 */
function run (middleware, req) {
  const _res = mockRes()
  let _passed = false

  middleware(req, _res, () => {
    _passed = true
  })

  return { passed: _passed, res: _res }
}

/** The authentication addon carbone-account registers: without it
    `needAuthentication` is an unknown schema key and the route is dropped */
const authAddon = {
  schemaKeyName: 'needAuthentication',
  exec: (value, db, route, schema, req, res, next) => next()
}

/**
 * A route record in the shape api.routes() produces
 * @param {Object} schema Route schema
 * @param {Object} overrides Fields to replace
 */
function route (schema, overrides) {
  return Object.assign({
    method: 'GET',
    path: '/api/users',
    api: 'users',
    schemaName: 'getUsers',
    schema: schema
  }, overrides)
}

describe('Roles', () => {
  afterEach(() => {
    roles._reset()
  })

  describe('configure: refusing a broken table', () => {
    it('should refuse a second call, so a policy can never be replaced at runtime', () => {
      configure()
      assert.throws(() => configure(), /has already been called/)
    })

    it('should refuse anything that is not an object', () => {
      assert.throws(() => roles.configure(null), /takes an object/)
      assert.throws(() => roles.configure('ADMIN'), /takes an object/)
      assert.throws(() => roles.configure(undefined), /takes an object/)
    })

    it('should refuse an unknown option rather than ignore it', () => {
      // A misspelt 'resolver' silently falling back to no resolver is a table
      // that refuses everyone, or worse, one that never runs
      assert.throws(() => configure({ resolver: () => {} }), /Unknown roles option 'resolver'/)
    })

    it('should require resolve and requires to be functions', () => {
      assert.throws(() => configure({ resolve: undefined }), /'resolve' must be a function/)
      assert.throws(() => configure({ resolve: 'req.token.role' }), /'resolve' must be a function/)
      assert.throws(() => configure({ requires: undefined }), /'requires' must be a function/)
      assert.throws(() => configure({ requires: true }), /'requires' must be a function/)
    })

    it('should require refuse to be a function when given', () => {
      assert.throws(() => configure({ refuse: 403 }), /'refuse' must be a function/)
    })

    it('should refuse a roles table that is not a plain object', () => {
      assert.throws(() => configure({ roles: null }), /'roles' must be an object/)
      assert.throws(() => configure({ roles: 'ADMIN' }), /'roles' must be an object/)
      // An array would make Object.keys return '0', '1'... and index positions
      // would silently become role names
      assert.throws(() => configure({ roles: ['ADMIN'] }), /'roles' must be an object/)
    })

    it('should refuse an empty table', () => {
      assert.throws(() => configure({ roles: {} }), /at least one role/)
    })

    it('should take as many roles as a project declares, with no ceiling', () => {
      const _many = {}

      for (let i = 0; i < 64; i++) {
        _many['ROLE' + i] = ['thing.read']
      }

      configure({ roles: _many })

      assert.strictEqual(run(roles._routeMiddleware('any'), { token: { role: 'ROLE63' } }).passed, true)
      assert.strictEqual(run(roles._routeMiddleware('thing.read'), { token: { role: 'ROLE63' } }).passed, true)
    })

    it('should refuse an empty role name, which an anonymous caller holds', () => {
      // `req.token?.role ?? ''` and `String(claims.role)` both hand '' to the
      // resolver: left in the table, that is a role and the anonymous caller has it
      assert.throws(() => configure({ roles: { '': ['members.read'], ADMIN: [] } }), /role name must not be empty/)
    })

    it('should refuse a role whose permissions are not an array', () => {
      assert.throws(() => configure({ roles: { ADMIN: 'members.read' } }), /role 'ADMIN' must hold an array/)
      assert.throws(() => configure({ roles: { ADMIN: null } }), /role 'ADMIN' must hold an array/)
    })

    it('should refuse a permission that is not a non-empty string', () => {
      assert.throws(() => configure({ roles: { ADMIN: [''] } }), /not a non-empty string/)
      assert.throws(() => configure({ roles: { ADMIN: [42] } }), /not a non-empty string/)
      assert.throws(() => configure({ roles: { ADMIN: [null] } }), /not a non-empty string/)
      assert.throws(() => configure({ roles: { ADMIN: [{ name: 'x' }] } }), /not a non-empty string/)
    })

    it("should refuse granting the reserved 'any'", () => {
      // Granting 'any' to one role would make `permission: 'any'` mean that role
      // only, quietly narrowing every route declared open to all
      assert.throws(() => configure({ roles: { ADMIN: ['any'] } }), /'any' is reserved/)
    })
  })

  describe('configure: what it compiles to', () => {
    it('should collect every role granting the same permission', () => {
      configure()

      // members.read is granted to both, members.write to ADMIN alone
      assert.deepStrictEqual([...roles._granted.get('members.read')].sort(), ['ADMIN', 'USER'])
      assert.deepStrictEqual([...roles._granted.get('members.write')], ['ADMIN'])
      assert.deepStrictEqual([...roles._granted.get('apikeys.read')], ['ADMIN'])
    })

    it("should compile 'any' to every declared role", () => {
      configure()

      assert.deepStrictEqual([...roles._granted.get('any')].sort(), ['ADMIN', 'USER'])
    })

    it('should treat the table as the closed vocabulary of permissions', () => {
      configure()

      // Nothing outside the table exists: that is what makes a typo fail at boot
      assert.strictEqual(roles._granted.has('members.delete'), false)
    })

    it('should accept a role granted nothing, which only `any` lets through', () => {
      configure({ roles: { ADMIN: ['members.read'], PENDING: [] } })

      assert.strictEqual(run(roles._routeMiddleware('any'), { token: { role: 'PENDING' } }).passed, true)
      assert.strictEqual(run(roles._routeMiddleware('members.read'), { token: { role: 'PENDING' } }).passed, false)
    })
  })

  describe('_routeMiddleware: refusing a broken declaration at boot', () => {
    it('should refuse a permission when configure was never called', () => {
      assert.throws(() => roles._routeMiddleware('members.read'), /needs hearthjs.roles.configure/)
    })

    it('should refuse a permission that is not a non-empty string', () => {
      configure()

      assert.throws(() => roles._routeMiddleware(''), /must be a non-empty string/)
      assert.throws(() => roles._routeMiddleware(true), /must be a non-empty string/)
      assert.throws(() => roles._routeMiddleware(['members.read']), /must be a non-empty string/)
      assert.throws(() => roles._routeMiddleware(undefined), /must be a non-empty string/)
    })

    it('should refuse a permission no role grants, so a typo explodes at boot', () => {
      configure()

      // 'members.raed' is granted to nobody, so it would otherwise refuse
      // everyone, in production, silently
      assert.throws(() => roles._routeMiddleware('members.raed'), /granted to no role/)
    })
  })

  describe('_routeMiddleware: the request path', () => {
    it('should let a role holding the permission through', () => {
      configure()

      const _guard = roles._routeMiddleware('apikeys.read')

      assert.strictEqual(run(_guard, { token: { role: 'ADMIN' } }).passed, true)
    })

    it('should refuse a role that does not hold it', () => {
      configure()

      const _guard = roles._routeMiddleware('apikeys.read')
      const _result = run(_guard, { token: { role: 'USER' } })

      assert.strictEqual(_result.passed, false)
      assert.strictEqual(_result.res.statusCode, 403)
    })

    it('should let every role through a permission they share', () => {
      configure()

      const _guard = roles._routeMiddleware('members.read')

      assert.strictEqual(run(_guard, { token: { role: 'ADMIN' } }).passed, true)
      assert.strictEqual(run(_guard, { token: { role: 'USER' } }).passed, true)
    })

    it("should let every declared role through 'any', and nobody else", () => {
      configure()

      const _guard = roles._routeMiddleware('any')

      assert.strictEqual(run(_guard, { token: { role: 'ADMIN' } }).passed, true)
      assert.strictEqual(run(_guard, { token: { role: 'USER' } }).passed, true)
      // 'any' is every KNOWN role: a token carrying a role the table dropped is
      // refused here too, rather than being the one way past the whole system
      assert.strictEqual(run(_guard, { token: { role: 'LEGACY' } }).passed, false)
      assert.strictEqual(run(_guard, {}).passed, false)
    })
  })

  describe('_routeMiddleware: bypass and escalation attempts', () => {
    const _realLog = logger.log
    let _logged = []

    beforeEach(() => {
      _logged = []
    })

    // Restored here, not at the end of the tests that stub it: an assertion
    // throwing above would leave every later test logging into nowhere
    afterEach(() => {
      logger.log = _realLog
    })

    it('should refuse a caller with no role at all', () => {
      configure()

      const _guard = roles._routeMiddleware('members.read')

      assert.strictEqual(run(_guard, {}).passed, false)
      assert.strictEqual(run(_guard, { token: {} }).passed, false)
      assert.strictEqual(run(_guard, { token: { role: null } }).passed, false)
      assert.strictEqual(run(_guard, { token: { role: '' } }).passed, false)
    })

    it('should refuse a role the table no longer holds', () => {
      configure()

      // A token signed while 'SUPERADMIN' existed must not survive its removal
      assert.strictEqual(run(roles._routeMiddleware('members.write'), { token: { role: 'SUPERADMIN' } }).passed, false)
    })

    it('should refuse a role name inherited from Object.prototype', () => {
      configure()

      const _guard = roles._routeMiddleware('members.write')

      // A plain object lookup table would answer a function for these, and a
      // truthy answer is one careless `if` away from a full bypass
      for (const _name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.strictEqual(run(_guard, { token: { role: _name } }).passed, false, _name)
      }
    })

    it('should match the role exactly, never by case or by trimming', () => {
      configure()

      const _guard = roles._routeMiddleware('members.write')

      for (const _name of ['admin', 'Admin', 'ADMIN ', ' ADMIN', 'ADMIN\n', 'ADMINISTRATOR', 'ADMI']) {
        assert.strictEqual(run(_guard, { token: { role: _name } }).passed, false, _name)
      }
    })

    it('should refuse a role that is not a string, with no coercion', () => {
      configure()

      const _guard = roles._routeMiddleware('members.write')

      // String(['ADMIN']) is 'ADMIN': a Map keyed by string never coerces, and
      // this is the test that keeps it that way
      for (const _value of [['ADMIN'], { toString: () => 'ADMIN' }, 1, true, Symbol('ADMIN')]) {
        assert.strictEqual(run(_guard, { token: { role: _value } }).passed, false, String(_value))
      }
    })

    it('should fail closed when the resolver throws', () => {
      configure({ resolve: () => { throw new Error('token store is down') } })

      const _result = run(roles._routeMiddleware('members.read'), {})

      assert.strictEqual(_result.passed, false)
      assert.strictEqual(_result.res.statusCode, 403)
    })

    it('should refuse an async resolver, and never let its rejection kill the process', (done) => {
      logger.log = (msg, level) => _logged.push({ msg: String(msg), level })
      configure({ resolve: async () => { throw new Error('token store is down') } })

      const _guard = roles._routeMiddleware('members.read')

      // A promise is never a role: allowing on one is a bypass, and an
      // unobserved rejection ends the process on node >= 15
      assert.strictEqual(run(_guard, { token: { role: 'ADMIN' } }).passed, false)
      // Refusing everyone in silence is an outage with nothing to diagnose it
      assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
      assert.strictEqual(_logged[0].level, 'error')
      assert.strictEqual(_logged[0].msg.includes('returned a promise'), true)

      // Said once per route, not once per request
      run(_guard, { token: { role: 'ADMIN' } })
      assert.strictEqual(_logged.length, 1)

      // The rejection is observed: nothing reaches the process handler
      const _onUnhandled = () => { throw new Error('the rejection escaped') }

      process.once('unhandledRejection', _onUnhandled)
      setTimeout(() => {
        process.removeListener('unhandledRejection', _onUnhandled)
        done()
      }, 20)
    })

    it('should refuse a resolver returning a plain thenable', () => {
      configure({ resolve: () => ({ then: () => {} }) })

      assert.strictEqual(run(roles._routeMiddleware('members.read'), {}).passed, false)
    })

    it('should not let a permission of another role through', () => {
      // Three roles, so a permission collected under the wrong one shows up
      configure({
        roles: {
          ADMIN: ['members.write'],
          USER: ['self.read'],
          FINANCER: ['billing.read']
        }
      })

      assert.strictEqual(run(roles._routeMiddleware('billing.read'), { token: { role: 'USER' } }).passed, false)
      assert.strictEqual(run(roles._routeMiddleware('billing.read'), { token: { role: 'ADMIN' } }).passed, false)
      assert.strictEqual(run(roles._routeMiddleware('billing.read'), { token: { role: 'FINANCER' } }).passed, true)
      assert.strictEqual(run(roles._routeMiddleware('self.read'), { token: { role: 'FINANCER' } }).passed, false)
    })
  })

  describe('_routeMiddleware: the refusal', () => {
    const _realLog = logger.log

    // Restored here, not at the end of the test that stubs it
    afterEach(() => {
      logger.log = _realLog
    })

    it('should answer 403 with a json body and never call next', () => {
      configure()

      const _result = run(roles._routeMiddleware('apikeys.read'), { token: { role: 'USER' } })

      assert.strictEqual(_result.passed, false)
      assert.strictEqual(_result.res.statusCode, 403)
      assert.strictEqual(_result.res.headers['content-type'], 'application/json')
      assert.deepStrictEqual(JSON.parse(_result.res.endedWith.toString()), {
        success: false,
        data: {},
        message: 'Not allowed'
      })
    })

    it('should answer two different routes identically, leaking no policy', () => {
      configure()

      const _a = run(roles._routeMiddleware('apikeys.read'), { token: { role: 'USER' } })
      const _b = run(roles._routeMiddleware('members.write'), { token: { role: 'USER' } })

      assert.strictEqual(_a.res.statusCode, _b.res.statusCode)
      assert.strictEqual(_a.res.endedWith.toString(), _b.res.endedWith.toString())
    })

    it('should mark the refusal uncacheable', () => {
      configure()

      const _res = run(roles._routeMiddleware('apikeys.read'), { token: { role: 'USER' } }).res

      // A shared cache keys on the url, which an ADMIN and a USER share
      assert.strictEqual(_res.headers['cache-control'], 'no-store')
    })

    it('should write nothing when the response is already sent', () => {
      configure()

      const _res = mockRes()

      _res.headersSent = true
      roles._routeMiddleware('apikeys.read')({ token: { role: 'USER' } }, _res, () => {})

      // setHeader on a finished response throws ERR_HTTP_HEADERS_SENT
      assert.strictEqual(_res.endedWith, null)
      assert.deepStrictEqual(_res.headers, {})
    })

    it('should fall back to the built-in refusal when the project one throws', () => {
      const _logged = []

      logger.log = (msg, level) => _logged.push({ msg: String(msg), level })
      configure({ refuse: () => { throw new Error('template engine is down') } })

      const _guard = roles._routeMiddleware('apikeys.read')
      const _result = run(_guard, { token: { role: 'USER' } })

      // The one project function an attacker triggers at will: a throw must not
      // hand the caller a 500, crash, or leave the socket open
      assert.strictEqual(_result.passed, false)
      assert.strictEqual(_result.res.statusCode, 403)
      assert.deepStrictEqual(JSON.parse(_result.res.endedWith.toString()).message, 'Not allowed')
      assert.strictEqual(_logged[0].level, 'error')
      assert.strictEqual(_logged[0].msg.includes('refuse handler threw'), true)

      // Latched: a refusal that throws is a permanent bug, and one line per
      // refused request lets anyone hammering the route fill the disk
      for (let i = 0; i < 20; i++) {
        run(_guard, { token: { role: 'USER' } })
      }

      assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
    })

    it('should not throw when a refusal that threw had already written headers', () => {
      logger.log = () => {}
      configure({
        refuse: (req, res) => {
          res.setHeader('location', '/login')
          throw new Error('half written')
        }
      })

      const _res = mockRes()

      // The fallback must not setHeader on a response the project already sent
      _res.setHeader = function (name, value) {
        this.headers[name] = value
        this.headersSent = true
      }

      assert.doesNotThrow(() => {
        roles._routeMiddleware('apikeys.read')({ token: { role: 'USER' } }, _res, () => {})
      })
      assert.strictEqual(_res.endedWith, null)
    })

    it('should never call next when the project refusal forgets to answer', () => {
      configure({ refuse: () => {} })

      // A silent refusal leaves the request hanging, which is a bug — but it must
      // never become an allow
      assert.strictEqual(run(roles._routeMiddleware('apikeys.read'), { token: { role: 'USER' } }).passed, false)
    })

    it('should use the project refusal when one is declared', () => {
      let _seen = null

      configure({
        refuse: (req, res) => {
          _seen = req
          res.statusCode = 302
          return res.end()
        }
      })

      const _req = { token: { role: 'USER' } }
      const _result = run(roles._routeMiddleware('apikeys.read'), _req)

      assert.strictEqual(_result.passed, false)
      assert.strictEqual(_result.res.statusCode, 302)
      assert.strictEqual(_seen, _req)
    })
  })

  describe('_checkRoutes: the boot report', () => {
    it('should pass through untouched when roles were never configured', () => {
      // The whole opt-in: a project not using roles must boot exactly as before
      assert.strictEqual(roles._checkRoutes([route({ needAuthentication: true })]), null)
    })

    it('should accept a table where every route is in order', () => {
      configure()

      assert.strictEqual(roles._checkRoutes([
        route({ needAuthentication: true, permission: 'members.read' }),
        route({ needAuthentication: true, permission: 'any' }),
        route({ query: 'login' })
      ]), null)
    })

    it('should report an authenticated route declaring no permission', () => {
      configure()

      const _err = roles._checkRoutes([route({ needAuthentication: true })])

      assert.notStrictEqual(_err, null)
      assert.strictEqual(_err instanceof Error, true)
      assert.strictEqual(_err.message.includes('1 authenticated route(s) declare no `permission`'), true)
      assert.strictEqual(_err.message.includes('GET'), true)
      assert.strictEqual(_err.message.includes('/api/users'), true)
      assert.strictEqual(_err.message.includes('users → getUsers'), true)
      // The message has to name what may be declared, or it is one restart per guess
      assert.strictEqual(_err.message.includes('members.read'), true)
      assert.strictEqual(_err.message.includes('any'), true)
    })

    it('should report every offending route at once, not just the first', () => {
      configure()

      const _err = roles._checkRoutes([
        route({ needAuthentication: true }, { path: '/api/users' }),
        route({ needAuthentication: true }, { path: '/api/user/invitation/new', method: 'POST' }),
        route({ needAuthentication: true }, { path: '/api/tokens/:id', method: 'DELETE' })
      ])

      assert.strictEqual(_err.message.includes('3 authenticated route(s)'), true)
      assert.strictEqual(_err.message.includes('/api/users'), true)
      assert.strictEqual(_err.message.includes('/api/user/invitation/new'), true)
      assert.strictEqual(_err.message.includes('/api/tokens/:id'), true)
    })

    it('should report a permission declared on a route needing no authentication', () => {
      configure()

      const _err = roles._checkRoutes([route({ permission: 'members.read' }, { path: '/api/login', method: 'POST' })])

      assert.strictEqual(_err.message.includes('1 route(s) declare a `permission` but need no authentication'), true)
      assert.strictEqual(_err.message.includes('/api/login'), true)
      assert.strictEqual(_err.message.includes('A role cannot gate a route nobody signs in to reach.'), true)
    })

    it('should report both kinds in one error', () => {
      configure()

      const _err = roles._checkRoutes([
        route({ needAuthentication: true }, { path: '/api/users' }),
        route({ permission: 'members.read' }, { path: '/api/login', method: 'POST' })
      ])

      assert.strictEqual(_err.message.includes('declare no `permission`'), true)
      assert.strictEqual(_err.message.includes('but need no authentication'), true)
    })

    it('should accept an empty route list', () => {
      configure()

      assert.strictEqual(roles._checkRoutes([]), null)
    })

    it('should refuse to boot when requires returns anything but a boolean', () => {
      // Taken as false, a truthy non-boolean would audit NOTHING and report
      // success: `requires: (r) => r.schema.needAuthentication` where one schema
      // holds an object is a server with every guard missing and no warning
      configure({ requires: () => 'yes' })

      const _err = roles._checkRoutes([route({ needAuthentication: true })])

      assert.notStrictEqual(_err, null)
      assert.strictEqual(_err.message.includes('requires() returned a string'), true)
      assert.strictEqual(_err.message.includes('GET /api/users'), true)
    })

    it('should refuse to boot on every non-boolean, truthy or not', () => {
      for (const _value of [1, 0, undefined, null, 'true', {}, []]) {
        roles._reset()
        configure({ requires: () => _value })
        assert.notStrictEqual(roles._checkRoutes([route({ needAuthentication: true })]), null, String(_value))
      }
    })

    it('should refuse to boot when requires throws, naming the route', () => {
      // A predicate dereferencing a key some schema lacks used to escape the boot
      // interval: the process died, or with an uncaughtException handler the
      // server neither listened nor reported, forever
      configure({ requires: (r) => r.schema.permission.length > 0 })

      const _err = roles._checkRoutes([route({ needAuthentication: true })])

      assert.notStrictEqual(_err, null)
      assert.strictEqual(_err.message.includes('requires() threw'), true)
      assert.strictEqual(_err.message.includes('GET /api/users'), true)
    })
  })

  describe('_reset', () => {
    it('should put the module back where a restart finds it', () => {
      configure()
      roles._reset()

      assert.strictEqual(roles._granted, null)
      assert.strictEqual(roles._resolve, null)
      assert.strictEqual(roles._requires, null)
      assert.strictEqual(roles._refuse, null)
      assert.throws(() => roles._routeMiddleware('members.read'), /needs hearthjs.roles.configure/)
      assert.strictEqual(roles._checkRoutes([route({ needAuthentication: true })]), null)
      // And a restart may declare the table again
      assert.doesNotThrow(() => configure())
    })
  })

  describe('api.routes()', () => {
    let _realLog = null
    let _realApp = null
    let _realAddons = null
    let _realDeclared = 0
    let _realServed = 0

    beforeEach(() => {
      _realLog = logger.log
      _realApp = server._app
      _realAddons = server._addons
      _realDeclared = api._nbRouteDeclared
      _realServed = api._nbRouteServed
      logger.log = () => {}
      server._app = { get: () => {}, post: () => {} }
      server._addons = [authAddon]
      configure()
      api._reset()
      api._nbRouteDeclared = 0
      api._nbRouteServed = 0
    })

    afterEach(() => {
      logger.log = _realLog
      server._app = _realApp
      server._addons = _realAddons
      api._reset()
      api._nbRouteDeclared = _realDeclared
      api._nbRouteServed = _realServed
    })

    it('should return nothing when no api is declared', () => {
      assert.deepStrictEqual(api.routes(), [])
    })

    it('should resolve every route to the schema the router used', () => {
      const _schemas = {
        getUsers: { needAuthentication: true, permission: 'members.read' },
        login: { query: 'login' }
      }

      api.define('users', _schemas, (self) => {
        self.get('/api/users', 'getUsers')
        self.post('/api/login', 'login')
      })

      const _routes = api.routes()

      assert.strictEqual(_routes.length, 2)
      assert.deepStrictEqual(_routes[0], {
        method: 'GET',
        path: '/api/users',
        api: 'users',
        schemaName: 'getUsers',
        schema: _schemas.getUsers
      })
      assert.strictEqual(_routes[1].method, 'POST')
      assert.strictEqual(_routes[1].path, '/api/login')
      // The schema is the object itself, so a caller reads any key without
      // redoing the route -> schema resolution the router already did
      assert.strictEqual(_routes[1].schema, _schemas.login)
    })

    it('should keep a path holding a space intact', () => {
      api.define('odd', { thing: {} }, (self) => {
        self.get('/api/a b', 'thing')
      })

      assert.strictEqual(api.routes()[0].method, 'GET')
      assert.strictEqual(api.routes()[0].path, '/api/a b')
    })

    it('should list the routes of every api', () => {
      api.define('users', { a: {} }, (self) => self.get('/api/users', 'a'))
      api.define('billing', { b: {} }, (self) => self.get('/api/billing', 'b'))

      assert.deepStrictEqual(api.routes().map((r) => r.api).sort(), ['billing', 'users'])
    })
  })

  describe('api wiring', () => {
    let _logged = []
    let _realLog = null
    let _realApp = null
    let _realAddons = null
    let _realDeclared = 0
    let _realServed = 0
    let _handlers = null

    beforeEach(() => {
      _logged = []
      _handlers = null
      _realLog = logger.log
      _realApp = server._app
      _realAddons = server._addons
      _realDeclared = api._nbRouteDeclared
      _realServed = api._nbRouteServed
      logger.log = (msg, level) => _logged.push({ msg: String(msg), level })
      server._app = { get: function () { _handlers = [...arguments] }, post: function () { _handlers = [...arguments] } }
      server._addons = [authAddon]
      api._reset()
      api._nbRouteDeclared = 0
      api._nbRouteServed = 0
    })

    afterEach(() => {
      logger.log = _realLog
      server._app = _realApp
      server._addons = _realAddons
      // Restored here, not at the end of the test that builds one: an assertion
      // throwing above would leave the profile behind for the next test
      rateLimit._reset()
      api._reset()
      api._nbRouteDeclared = _realDeclared
      api._nbRouteServed = _realServed
    })

    it('should accept `permission` as a schema key, not report it as a typo', () => {
      configure()
      api.define('users', { getUsers: { permission: 'members.read' } }, (self) => self.get('/api/users', 'getUsers'))

      assert.deepStrictEqual(_logged, [])
      assert.strictEqual(api._nbRouteServed, 1)
    })

    it('should drop a route whose permission no role grants, and say why', () => {
      configure()
      api.define('users', { getUsers: { permission: 'members.raed' } }, (self) => self.get('/api/users', 'getUsers'))

      assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
      assert.strictEqual(_logged[0].level, 'error')
      assert.strictEqual(_logged[0].msg.includes('GET /api/users'), true)
      assert.strictEqual(_logged[0].msg.includes('granted to no role'), true)
      // A route that cannot be guarded is not served: 404, never unguarded
      assert.strictEqual(api._nbRouteDeclared, 0)
      assert.strictEqual(_handlers, null)
    })

    it('should drop a route declaring a permission when roles were never configured', () => {
      api.define('users', { getUsers: { permission: 'members.read' } }, (self) => self.get('/api/users', 'getUsers'))

      assert.strictEqual(_logged[0].level, 'error')
      assert.strictEqual(_logged[0].msg.includes('needs hearthjs.roles.configure'), true)
      assert.strictEqual(api._nbRouteDeclared, 0)
    })

    it('should place the guard after the addons, so an anonymous caller still gets 401', () => {
      configure()

      api.define('users', {
        getUsers: { needAuthentication: true, permission: 'members.read' }
      }, (self) => self.get('/api/users', 'getUsers'))

      const _names = _handlers.map((h) => (typeof h === 'function' ? h.name || 'anonymous' : typeof h))
      const _guardIndex = _names.indexOf('roleMiddleware')

      assert.notStrictEqual(_guardIndex, -1, 'the guard must be wired in')
      // The property, not a position: the guard sits after the addon runner (the
      // first anonymous handler, right after the schema tagger) and before the
      // project middleware, wherever else the chain grows
      assert.strictEqual(_guardIndex > _names.indexOf('anonymous'), true, JSON.stringify(_names))
      assert.strictEqual(_guardIndex < _handlers.findIndex((h) => Array.isArray(h)), true, JSON.stringify(_names))
    })

    it('should place the guard behind the rate limiter', () => {
      configure()
      api.define('users', {
        getUsers: { rateLimit: { max: 10, window: 60 }, permission: 'members.read' }
      }, (self) => self.get('/api/users', 'getUsers'))

      const _names = _handlers.map((h) => (typeof h === 'function' ? h.name : typeof h))

      assert.strictEqual(_names.indexOf('rateLimitMiddleware') < _names.indexOf('roleMiddleware'), true, JSON.stringify(_names))
    })

    it('should still drop a route on a broken rate limit, with its own message', () => {
      // The two resolutions share one try/catch now: the rate limit error must
      // not have been swallowed or relabelled
      api.define('users', { getUsers: { rateLimit: 'undeclared' } }, (self) => self.get('/api/users', 'getUsers'))

      assert.strictEqual(_logged[0].level, 'error')
      assert.strictEqual(_logged[0].msg.includes("profile 'undeclared' is not defined"), true)
      assert.strictEqual(api._nbRouteDeclared, 0)
    })
  })

  describe('backward compatibility', () => {
    let _realLog = null
    let _realApp = null
    let _realAddons = null
    let _realDeclared = 0
    let _realServed = 0
    let _handlers = null

    beforeEach(() => {
      _handlers = null
      _realLog = logger.log
      _realApp = server._app
      _realAddons = server._addons
      _realDeclared = api._nbRouteDeclared
      _realServed = api._nbRouteServed
      logger.log = () => {}
      server._app = { get: function () { _handlers = [...arguments] } }
      server._addons = [authAddon]
      api._reset()
      api._nbRouteDeclared = 0
      api._nbRouteServed = 0
    })

    afterEach(() => {
      logger.log = _realLog
      server._app = _realApp
      server._addons = _realAddons
      api._reset()
      api._nbRouteDeclared = _realDeclared
      api._nbRouteServed = _realServed
    })

    it('should wire no guard on a schema declaring no permission', () => {
      configure()
      api.define('users', { getUsers: { needAuthentication: false } }, (self) => self.get('/api/users', 'getUsers'))

      assert.strictEqual(_handlers.some((h) => typeof h === 'function' && h.name === 'roleMiddleware'), false)
      assert.strictEqual(api._nbRouteServed, 1)
    })

    it('should serve a project that never configures roles exactly as before', () => {
      api.define('users', { getUsers: { needAuthentication: true } }, (self) => self.get('/api/users', 'getUsers'))

      assert.strictEqual(_handlers.some((h) => typeof h === 'function' && h.name === 'roleMiddleware'), false)
      assert.strictEqual(api._nbRouteServed, 1)
      assert.strictEqual(roles._checkRoutes(api.routes()), null)
    })

    it('should keep the handler order of a schema without a permission', () => {
      api.define('users', { getUsers: {} }, (self) => self.get('/api/users', 'getUsers'))

      // [route, tagger, middlewareList, handler]
      assert.strictEqual(_handlers.length, 4)
      assert.strictEqual(_handlers[0], '/api/users')
      assert.deepStrictEqual(_handlers[2], [])
    })
  })
})

describe('Roles over HTTP', () => {
  const app = require('../lib/')
  const path = require('path')
  const rock = require('rock-req')
  const fs = require('fs')
  const authAddon = require('./datasets/addons/permissionAuthAddon')

  /**
   * Call the running app
   * @param {String} method HTTP method
   * @param {String} route Route to call
   * @param {String} role Value of the x-role header, undefined for anonymous
   * @param {Function} callback Called with (response, body), body parsed when it
   * is json — the router's own 404 is html, and parsing it blindly reports a
   * syntax error where the test means to report a status
   */
  function call (method, route, role, callback) {
    const _headers = (role === undefined) ? {} : { 'x-role': role }

    rock({ url: app.server.getEndpoint() + route, method: method, headers: _headers }, (err, response, body) => {
      assert.strictEqual(err, null)

      const _raw = body.toString()
      const _isJson = (response.headers['content-type'] ?? '').includes('application/json')

      return callback(response, _isJson ? JSON.parse(_raw) : _raw)
    })
  }

  /**
   * Remove the log file an app run leaves behind
   * @param {String} appName Dataset app directory
   */
  function cleanLogs (appName) {
    const _logFile = path.join(__dirname, 'datasets', appName, 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

    if (fs.existsSync(_logFile)) {
      fs.unlinkSync(_logFile)
    }
  }

  describe('a served request', () => {
    before((done) => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'permissionApp', 'server')
      app.useAddon(authAddon)
      app.run('test', process.env.HEARTH_SERVER_PATH, done)
    })

    after((done) => {
      app.close(() => {
        cleanLogs('permissionApp')
        done()
      })
    })

    it('should serve a role holding the permission', (done) => {
      call('GET', 'members', 'ADMIN', (response, body) => {
        assert.strictEqual(response.statusCode, 200)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'listed')
        done()
      })
    })

    it('should serve a second role sharing the permission', (done) => {
      call('GET', 'members', 'USER', (response, body) => {
        assert.strictEqual(response.statusCode, 200)
        assert.strictEqual(body.message, 'listed')
        done()
      })
    })

    it('should refuse a role that does not hold the permission', (done) => {
      call('POST', 'members', 'USER', (response, body) => {
        assert.strictEqual(response.statusCode, 403)
        assert.strictEqual(body.success, false)
        assert.strictEqual(body.message, 'Not allowed')
        assert.strictEqual(response.headers['cache-control'], 'no-store')
        done()
      })
    })

    it('should serve the same route to the role that does hold it', (done) => {
      call('POST', 'members', 'ADMIN', (response, body) => {
        assert.strictEqual(response.statusCode, 200)
        assert.strictEqual(body.message, 'added')
        done()
      })
    })

    it('should answer 401, not 403, to an anonymous caller', (done) => {
      // The whole reason the guard is pushed after the addon runner: the
      // front-end matches on this message to send the visitor to the login page
      call('GET', 'members', undefined, (response, body) => {
        assert.strictEqual(response.statusCode, 401)
        assert.strictEqual(body.message, 'You are not authenticated')
        done()
      })
    })

    it("should serve 'any' to every declared role", (done) => {
      call('GET', 'whoami', 'USER', (response, body) => {
        assert.strictEqual(response.statusCode, 200)
        assert.strictEqual(body.message, 'you')
        done()
      })
    })

    it("should refuse 'any' to a role the table does not hold", (done) => {
      // A token signed while the role existed must not survive its removal
      call('GET', 'whoami', 'GHOST', (response, body) => {
        assert.strictEqual(response.statusCode, 403)
        assert.strictEqual(body.message, 'Not allowed')
        done()
      })
    })

    it('should leave a public route untouched', (done) => {
      call('POST', 'login', undefined, (response, body) => {
        assert.strictEqual(response.statusCode, 200)
        assert.strictEqual(body.message, 'logged in')
        done()
      })
    })
  })

  describe('a boot the policies refuse', () => {
    let _error = null

    before((done) => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'permissionBadApp', 'server')
      app.useAddon(authAddon)
      app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
        _error = err
        done()
      })
    })

    after((done) => {
      app.close(() => {
        cleanLogs('permissionBadApp')
        done()
      })
    })

    it('should refuse to start and name every offending route at once', () => {
      assert.notStrictEqual(_error, null, 'the server must not start')
      assert.strictEqual(_error.message.includes('2 authenticated route(s) declare no `permission`'), true, _error.message)
      assert.strictEqual(_error.message.includes('/members'), true, _error.message)
      assert.strictEqual(_error.message.includes('/members/:id'), true, _error.message)
      assert.strictEqual(_error.message.includes('1 route(s) declare a `permission` but need no authentication'), true, _error.message)
      assert.strictEqual(_error.message.includes('/login'), true, _error.message)
    })

    it('should never listen, so no route is served unguarded', (done) => {
      // The claim the whole feature rests on: a missing policy is not a warning
      const _port = require('./datasets/permissionBadApp/server/config/test.json').APP_SERVER_PORT

      rock({ url: `http://localhost:${_port}/members`, headers: { 'x-role': 'ADMIN' } }, (err) => {
        assert.notStrictEqual(err, null, 'the port must not answer')
        assert.strictEqual(err.code, 'ECONNREFUSED', `expected a refused connection, got ${err.code}`)
        done()
      })
    })

    it('should leave nothing behind, so the next boot serves normally', (done) => {
      // Asserting two fields proved nothing: the retry is the claim. A refused
      // boot used to keep the roles table (the retry died on 'configure has
      // already been called') and the addon list (useAddon exits the process on
      // a duplicate), so this boots the good app in the same process, addon and
      // all, exactly as a developer fixing the schema and restarting would.
      assert.strictEqual(roles._granted, null)
      assert.deepStrictEqual(api.routes(), [])

      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'permissionApp', 'server')
      app.useAddon(authAddon)
      app.run('test', process.env.HEARTH_SERVER_PATH, (err) => {
        assert.strictEqual(err, null, String(err))

        call('GET', 'members', 'ADMIN', (response, body) => {
          assert.strictEqual(response.statusCode, 200)
          assert.strictEqual(body.message, 'listed')

          // And the refused app's routes are gone with it
          call('DELETE', 'members/1', 'ADMIN', (response) => {
            assert.strictEqual(response.statusCode, 404)
            app.close(() => {
              cleanLogs('permissionApp')
              done()
            })
          })
        })
      })
    })
  })
})
