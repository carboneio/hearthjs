const logger = require('./logger')

/** The policy every signed-in caller satisfies. It has to be written: a route open
    to everyone is a decision, and an omission must never be able to look like one. */
const ANY = 'any'

const CONFIGURE_OPTIONS = ['roles', 'resolve', 'requires', 'refuse']

/** Built once: an attacker must never make us serialize. One message for every
    refused route — a message per guard tells a caller which one they hit. */
const REFUSED_BODY = Buffer.from(JSON.stringify({ success: false, data: {}, message: 'Not allowed' }))

/**
 * The answer a refused caller gets when the project declares no `refuse`.
 * Takes `req` it does not read, so a project's own handler can replace it.
 * @param {Object} req Req from request
 * @param {Object} res Res from request
 */
function defaultRefuse (req, res) {
  if (res.headersSent === true) {
    return
  }

  res.statusCode = 403
  res.setHeader('content-type', 'application/json')
  // The answer varies by the caller's role on a url an ADMIN and a USER share,
  // and a shared cache keys on the url alone: a cached refusal would lock out
  // whoever is allowed, and a cached success is worse
  res.setHeader('cache-control', 'no-store')
  return res.end(REFUSED_BODY)
}

/**
 * The offending routes of a boot report, one per line
 * @param {Array} routes Routes to list
 * @return {String}
 */
function listRoutes (routes) {
  return routes.map((route) => `  ${route.method} ${route.path}  ${route.api} → ${route.schemaName}`).join('\n')
}

const roles = {
  /** Permission -> the set of roles granting it. Null until configure() is called,
      which is the whole opt-in: a project that never calls it is served as before. */
  _granted: null,
  _resolve: null,
  _requires: null,
  _refuse: null,

  /**
   * Declare the closed set of roles, what each one may do, and how to read the
   * caller's role. Misconfiguration throws: an authorization rule must never be
   * silently dropped.
   * @param {Object} options { roles, resolve, requires, refuse }
   */
  configure: function (options) {
    if (this._granted !== null) {
      throw new Error('hearthjs.roles.configure has already been called')
    }

    if (options === null || typeof options !== 'object') {
      throw new Error('roles.configure takes an object')
    }

    for (const _name of Object.keys(options)) {
      if (CONFIGURE_OPTIONS.includes(_name) === false) {
        throw new Error(`Unknown roles option '${_name}'`)
      }
    }

    // resolve says what role the caller holds, requires says which routes owe a
    // policy. Both answer questions about this application's authentication, which
    // hearthjs has no opinion on, so both are the project's to write.
    for (const _name of ['resolve', 'requires']) {
      if (typeof options[_name] !== 'function') {
        throw new Error(`roles.configure: '${_name}' must be a function`)
      }
    }

    if (options.refuse !== undefined && typeof options.refuse !== 'function') {
      throw new Error("roles.configure: 'refuse' must be a function")
    }

    if (options.roles === null || typeof options.roles !== 'object' || Array.isArray(options.roles) === true) {
      throw new Error("roles.configure: 'roles' must be an object of role name -> permissions")
    }

    const _names = Object.keys(options.roles)

    if (_names.length === 0) {
      throw new Error('roles.configure: declare at least one role')
    }

    const _granted = new Map()

    for (const _role of _names) {
      // An empty name is the value `req.token?.role ?? ''` hands an anonymous
      // caller: left in the table it is a role, and that caller holds it
      if (_role.length === 0) {
        throw new Error('roles.configure: a role name must not be empty')
      }

      const _permissions = options.roles[_role]

      if (Array.isArray(_permissions) === false) {
        throw new Error(`roles.configure: role '${_role}' must hold an array of permissions`)
      }

      for (const _permission of _permissions) {
        if (typeof _permission !== 'string' || _permission.length === 0) {
          throw new Error(`roles.configure: role '${_role}' grants a permission that is not a non-empty string`)
        }

        if (_permission === ANY) {
          throw new Error(`roles.configure: '${ANY}' is reserved and cannot be granted to '${_role}'`)
        }

        if (_granted.has(_permission) === false) {
          _granted.set(_permission, new Set())
        }

        _granted.get(_permission).add(_role)
      }
    }

    // This table is the closed vocabulary: a permission no role grants does not
    // exist, so a typo in a schema fails at boot instead of quietly refusing
    // everyone. There is no wildcard on purpose — a role that may do everything
    // lists everything, and the check never becomes a prefix match that can drift.
    // 'any' is every DECLARED role, so a token naming a role the table dropped is
    // refused there too rather than finding the one way past the whole system.
    _granted.set(ANY, new Set(_names))

    this._granted = _granted
    this._resolve = options.resolve
    this._requires = options.requires
    this._refuse = options.refuse ?? defaultRefuse
  },

  /**
   * Put the module back in its initial state, for server restarts: roles are
   * declared again by the project beforeInit function
   */
  _reset: function () {
    this._granted = null
    this._resolve = null
    this._requires = null
    this._refuse = null
  },

  /**
   * Middleware for the `permission` schema key. Called at route registration, so
   * an unknown permission throws there, at startup, never at request time.
   * @param {String} permission Permission the route demands
   * @return {Function} Middleware
   */
  _routeMiddleware: function (permission) {
    if (this._granted === null) {
      throw new Error('a `permission` needs hearthjs.roles.configure, called in beforeInit')
    }

    if (typeof permission !== 'string' || permission.length === 0) {
      throw new Error(`permission must be a non-empty string, or '${ANY}'`)
    }

    const _allowed = this._granted.get(permission)

    if (_allowed === undefined) {
      throw new Error(`permission '${permission}' is granted to no role. Grant it in hearthjs.roles.configure, or use '${ANY}'`)
    }

    const _resolve = this._resolve
    const _refuse = this._refuse
    let _asyncLogged = false
    let _refuseLogged = false

    return function roleMiddleware (req, res, next) {
      let _role = null

      // A throwing resolver must not open the gate, the rule the rate limiter's
      // key generator already follows. Reading `.then` is inside the try too: a
      // getter on it throws just as easily, and an authorization decision must
      // never leave here as a server fault.
      try {
        _role = _resolve(req)

        // An async resolver returns a promise, never a role. Refusing on one is
        // the safe half; the other is that an unobserved rejection ends the
        // process on node >= 15, which turns any request into a kill switch.
        if (_role !== null && _role !== undefined && typeof _role.then === 'function') {
          Promise.resolve(_role).catch(() => {})
          _role = null

          // Said once per route: every caller being refused is an outage, and
          // silence leaves nothing to diagnose it with
          if (_asyncLogged === false) {
            _asyncLogged = true
            logger.log('roles resolve() returned a promise: it must return the role synchronously, every caller is refused', 'error')
          }
        }
      } catch (e) {
        _role = null
      }

      // No role, or one the table does not hold, is simply not in the set: a
      // refusal runs the same lookup as an allow, never a separate test that
      // could be written the wrong way round
      if (_allowed.has(_role) === true) {
        return next()
      }

      // The one project function on a path an attacker reaches at will: a throw
      // must degrade to the built-in refusal, never crash or hang the socket
      try {
        return _refuse(req, res)
      } catch (e) {
        // Latched like the async warning above: a refusal that throws is a
        // permanent project bug, and one line per refused request hands anyone
        // hammering a route they do not hold a way to fill the disk
        if (_refuseLogged === false) {
          _refuseLogged = true
          logger.log(`roles refuse handler threw: ${String(e)}`, 'error')
        }

        return defaultRefuse(req, res)
      }
    }
  },

  /**
   * Every route the project calls authenticated must declare a permission, and no
   * other route may. Reported as one list: an error naming a single route is ten
   * restarts to fix ten routes. Covers the routes declared through hearthjs.api,
   * which is not every route the server answers — a handler mounted on the app in
   * init or afterInit is the project's own to guard.
   * @param {Array} routeList Output of hearthjs.api.routes()
   * @return {Error|null} Null when every route is in order
   */
  _checkRoutes: function (routeList) {
    if (this._granted === null) {
      return null
    }

    const _missing = []
    const _public = []

    for (const _route of routeList) {
      let _owes = null

      // requires() is project code, and it is the single thing that makes this
      // check total. A throw, or anything but a boolean, stops the server: taken
      // as false it would quietly audit nothing and report success.
      try {
        _owes = this._requires(_route)
      } catch (e) {
        return new Error(`roles: requires() threw on ${_route.method} ${_route.path}: ${String(e)}`)
      }

      if (typeof _owes !== 'boolean') {
        return new Error(`roles: requires() returned a ${typeof _owes} on ${_route.method} ${_route.path}, it must return true or false`)
      }

      if (_owes === (_route.schema.permission !== undefined)) {
        continue
      }

      if (_owes === true) {
        _missing.push(_route)
      } else {
        _public.push(_route)
      }
    }

    if (_missing.length === 0 && _public.length === 0) {
      return null
    }

    const _lines = []

    if (_missing.length > 0) {
      _lines.push(`${_missing.length} authenticated route(s) declare no \`permission\`:`)
      _lines.push(listRoutes(_missing))
      _lines.push(`Declare one of: ${[...this._granted.keys()].join(', ')}.`)
    }

    if (_public.length > 0) {
      _lines.push(`${_public.length} route(s) declare a \`permission\` but need no authentication:`)
      _lines.push(listRoutes(_public))
      _lines.push('A role cannot gate a route nobody signs in to reach.')
    }

    return new Error(_lines.join('\n'))
  }
}

module.exports = roles
