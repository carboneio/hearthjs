const app = require('../lib/')
const assert = require('assert')
const path = require('path')
const rock = require('rock-req')
const validateMailAddon = require('./datasets/addons/validateMailAddon')
const roleAddon = require('./datasets/addons/roleAddon')
const roleAddon2 = require('./datasets/addons/roleAddon2')
const errorAddon = require('./datasets/addons/errorAddon')
const sinon = require('sinon')
const logger = require('../lib/logger')
const fs = require('fs')

describe('Addons', () => {
  after(() => {
    const _logFile = path.join(__dirname, 'datasets', 'addonApp', 'server', 'logs', `${logger._getCurrentDateTime(false)}.log`)

    if (fs.existsSync(_logFile)) {
      fs.unlinkSync(_logFile)
    }
  })

  describe('Part 1', () => {
    before((done) => {
      process.env.HEARTH_SERVER_PATH = path.join(__dirname, 'datasets', 'addonApp', 'server')
      app.useAddon(validateMailAddon)
      app.useAddon(roleAddon)
      app.run('test', process.env.HEARTH_SERVER_PATH, done)
    })

    after((done) => {
      app.db.query('DROP TABLE IF EXISTS "RoleTest"', () => {
        app.close(done)
      })
    })

    it('should save all roles in RoleTest', (done) => {
      app.db.query('SELECT "role", "route" FROM "RoleTest" ORDER BY "role", "route"', (err, res, rows) => {
        assert.strictEqual(err, null)
        assert.strictEqual(rows.length, 5)
        assert.deepStrictEqual(rows[0], { role: 'ADMIN', route: '/schema-b' })
        assert.deepStrictEqual(rows[1], { role: 'NONAME', route: '/schema-c' })
        assert.deepStrictEqual(rows[2], { role: 'UNKNOWN', route: '/schema-c' })
        assert.deepStrictEqual(rows[3], { role: 'USER', route: '/schema-b' })
        assert.deepStrictEqual(rows[4], { role: 'USER', route: '/schema-c' })
        done()
      })
    })

    it('should acces route /schema-b', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'schema-b'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Nice')
        done()
      })
    })

    it('should not acces route /schema-c', (done) => {
      rock.get({
        url: app.server.getEndpoint() + 'schema-c'
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.strictEqual(body.success, false)
        assert.strictEqual(body.message, 'Only ADMIN can access')
        done()
      })
    })

    it('should validate email', (done) => {
      rock.post({
        url: app.server.getEndpoint() + 'schema-a',
        form: {
          mail: 'toto@gmail.com'
        }
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.strictEqual(body.success, true)
        assert.strictEqual(body.message, 'Yes')
        done()
      })
    })

    it('should not validate email', (done) => {
      rock.post({
        url: app.server.getEndpoint() + 'schema-a',
        form: {
          mail: 'totogmail.com'
        }
      }, function (err, response, body) {
        assert.strictEqual(err, null)
        body = JSON.parse(body)
        assert.strictEqual(body.success, false)
        assert.strictEqual(body.message, 'Invalid mail')
        done()
      })
    })
  })

  describe('Part 2: Error', () => {
    beforeEach(() => {
      sinon.stub(process, 'exit')
    })

    afterEach(() => {
      process.exit.restore()
      app.server._addons = []
    })

    it('should exit if addons does not have name', (done) => {
      app.useAddon(errorAddon)
      assert(process.exit.calledWith(1))
      done()
    })

    it('should exit if two addons have the same name', (done) => {
      app.useAddon(roleAddon)
      app.useAddon(roleAddon2)
      assert(process.exit.calledWith(1))
      done()
    })

    it('should use schemaKeyName define in useAddon', (done) => {
      app.useAddon(roleAddon, 'myName')
      app.useAddon(roleAddon2, 'oulala')
      assert.strictEqual(app.server._addons.length, 2)
      assert.strictEqual(app.server._addons[0].schemaKeyName, 'myName')
      assert.strictEqual(app.server._addons[1].schemaKeyName, 'oulala')
      done()
    })
  })
})

describe('Addon ordering and initialization', () => {
  const api = require('../lib/api')
  const server = require('../lib/server')
  const logger = require('../lib/logger')

  let _ran = []
  let _inited = []
  let _handlers = null
  let _realLog = null
  let _realApp = null
  let _realAddons = null
  let _realDeclared = 0
  let _realServed = 0

  /**
   * An addon recording when it is initialized and when it runs
   * @param {String} name Schema key it answers to
   */
  function recorder (name) {
    return {
      schemaKeyName: name,
      initSchema: (value, db, route, schema, callback) => {
        _inited.push(name)
        return callback(null)
      },
      exec: (value, db, route, schema, req, res, next) => {
        _ran.push(name)
        return next()
      }
    }
  }

  /**
   * Declare one route with the given schema and run its addon chain
   * @param {Object} schema Route schema
   */
  function declareAndRun (schema) {
    _ran = []
    _inited = []
    api._reset()
    api._nbRouteDeclared = 0
    api._nbRouteServed = 0
    api.define('ordering', { s: schema }, (self) => self.get('/x', 's'))

    // The addon runner is the anonymous handler the route registration pushed
    const _runner = _handlers.find((h) => typeof h === 'function' && h.name === '')

    _runner({ hearthjs: { apiName: 'ordering', schemaName: 's' }, originalUrl: '/x' }, {}, () => {})
  }

  beforeEach(() => {
    _handlers = null
    _realLog = logger.log
    _realApp = server._app
    _realAddons = server._addons
    _realDeclared = api._nbRouteDeclared
    _realServed = api._nbRouteServed
    logger.log = () => {}
    server._app = { get: function () { _handlers = [...arguments] } }
    // Registered auth first, the order the project writes in its index.js
    server._addons = [recorder('needAuthentication'), recorder('getIdCustomer')]
  })

  afterEach(() => {
    logger.log = _realLog
    server._app = _realApp
    server._addons = _realAddons
    api._reset()
    api._nbRouteDeclared = _realDeclared
    api._nbRouteServed = _realServed
  })

  it('should run addons in registration order, not in schema key order', () => {
    declareAndRun({ needAuthentication: true, getIdCustomer: true })
    assert.deepStrictEqual(_ran, ['needAuthentication', 'getIdCustomer'])

    // The same schema written the other way round used to invert them, letting
    // an addon that reads the caller run before the one that refuses anonymous
    declareAndRun({ getIdCustomer: true, needAuthentication: true })
    assert.deepStrictEqual(_ran, ['needAuthentication', 'getIdCustomer'])
  })

  it('should keep that order whatever else the schema declares', () => {
    declareAndRun({ successMsg: 'ok', getIdCustomer: true, rateLimit: { max: 10, window: 60 }, needAuthentication: true })
    assert.deepStrictEqual(_ran, ['needAuthentication', 'getIdCustomer'])
    require('../lib/rateLimit')._reset()
  })

  it('should initialize every addon of a schema, not only the first key', () => {
    // _initAllAddons called back instead of advancing, so the second addon was
    // never initialized
    declareAndRun({ needAuthentication: true, getIdCustomer: true })
    assert.deepStrictEqual(_inited, ['needAuthentication', 'getIdCustomer'])
  })

  it('should initialize them even when the schema starts with a non-addon key', () => {
    // A schema starting with `rateLimit` or `successMsg` — which is every schema
    // in a real project — used to initialize no addon at all
    declareAndRun({ successMsg: 'ok', needAuthentication: true, getIdCustomer: true })
    assert.deepStrictEqual(_inited, ['needAuthentication', 'getIdCustomer'])
  })

  it('should initialize in registration order too', () => {
    declareAndRun({ getIdCustomer: true, needAuthentication: true })
    assert.deepStrictEqual(_inited, ['needAuthentication', 'getIdCustomer'])
  })

  it('should not run an addon the schema does not declare', () => {
    declareAndRun({ needAuthentication: true })
    assert.deepStrictEqual(_ran, ['needAuthentication'])
    assert.deepStrictEqual(_inited, ['needAuthentication'])
  })

  it('should report an addon whose initSchema fails, naming it', () => {
    const _logged = []

    logger.log = (msg, level) => _logged.push({ msg: String(msg), level })
    server._addons = [{
      schemaKeyName: 'broken',
      initSchema: (value, db, route, schema, callback) => callback(new Error('table is missing'))
    }]

    api._reset()
    api._nbRouteDeclared = 0
    api._nbRouteServed = 0
    api.define('ordering', { s: { broken: true } }, (self) => self.get('/x', 's'))

    assert.strictEqual(_logged.length, 1, JSON.stringify(_logged))
    assert.strictEqual(_logged[0].msg.includes('broken'), true, _logged[0].msg)
    assert.strictEqual(_logged[0].msg.includes('table is missing'), true, _logged[0].msg)
  })
})
