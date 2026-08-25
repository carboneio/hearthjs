const restana = require('restana')
const escapeHtml = require('escape-html')
const expressCompat = require('./expressCompat')
const fs = require('fs')
const path = require('path')
const database = require('./database')
const addon = require('./addon')
const cookieParser = require('cookie-parser')
const migration = require('./migration')
const cron = require('./cron')
const logger = require('./logger')
const helper = require('./helper')
const { createServer } = require('http')
const { version } = require('../package.json')

const modeName = {
  dev: 'DEVELOPMENT',
  prod: 'PRODUCTION',
  test: 'TEST'
}

const server = {
  _defaultConfig: {
    APP_SERVER_PORT: 8080
  },

  config: null,
  io: null,

  _app: null,
  _httpServer: null,
  _server: null,
  _serverPath: null,
  _addons: [],
  _apiReady: true, // Api declaration has async calls, we need to be sure every API has been declared to run the server
  _projectServerFile: null,
  _env: null,

  // Graceful shutdown state
  _closing: false,
  _closeCallbacks: [],
  _draining: false,
  _signalHandlers: null,

  /**
   * Return the current env of the app
   */
  getEnv: function () {
    return this._env
  },

  /**
   * Return URL endpoint
   * @param {Boolean} https HTTPS variante
   */
  getEndpoint: function (https) {
    if (https) {
      return `https://localhost/`
    } else {
      return `http://localhost:${this.config.APP_SERVER_PORT}/`
    }
  },

  /**
   * Put the server back in its initial state
   */
  _reset: function () {
    this._app = null
    this.io = null
    this._draining = false
    this._httpServer = null
    this._server = null
    this._serverPath = null
    this._addons = []
    this._apiReady = true
    this._projectServerFile = null
  },

  /**
   * Initialize the server
   * @param {Object} env Choosen envirenment dev/prod/test
   * @param {Function} callback
   */
  _init: function (env, callback) {
    // Call project beforeInit function
    this._callFunctionIfExists('beforeInit', [], (err) => {
      if (err) {
        return callback(err)
      }

      // Opt in to the X-Forwarded-* headers, like express' "trust proxy"
      expressCompat.setTrustProxy(this.config.APP_TRUST_PROXY === true || process.env.APP_TRUST_PROXY === 'true')

      // Node defaults to 300s, which leaves a slow client holding a socket for
      // five minutes. Headers never get longer than the whole request.
      const _requestTimeout = this._getRequestTimeout()

      // Node only enforces the timeout on a sweep, every 30s by default: a
      // shorter timeout would otherwise be rounded up to the next sweep
      const _checkInterval = (_requestTimeout > 0 && _requestTimeout < 30000)
        ? Math.max(500, Math.floor(_requestTimeout / 2))
        : 30000

      this._httpServer = createServer({ connectionsCheckingInterval: _checkInterval })
      this._httpServer.requestTimeout = _requestTimeout

      if (_requestTimeout > 0 && this._httpServer.headersTimeout > _requestTimeout) {
        this._httpServer.headersTimeout = _requestTimeout
      }
      this._app = restana({
        server: this._httpServer,
        // hearthjs reports errors itself through _initErrorMiddleware
        errorHandler: (err, req, res) => this._handleError(err, req, res),
        // Reply to unmatched routes exactly like express did, so upgrading the
        // router does not change what a client sees on a wrong URL
        defaultRoute: (req, res) => this._handleNotFound(req, res),
        // Off by default like express. APP_SECURITY_HEADERS turns on restana's
        // nosniff / frame-options / HSTS defaults for apps that set none.
        securityHeaders: this.config.APP_SECURITY_HEADERS === true || process.env.APP_SECURITY_HEADERS === 'true',
        // Keep the request handled on the same tick, like express, so the
        // logger middleware measures the real handler time
        prioRequestsProcessing: false
      })

      if (this._projectServerFile !== null) {
        const startSocketServer = this._projectServerFile['startSocketServer']

        if (startSocketServer !== undefined && startSocketServer === true) {
          const cors = (this._projectServerFile['socketCorsOptions'] !== undefined) ? this._projectServerFile['socketCorsOptions'] : null

          // Optional peer dependency: only required by the projects that actually
          // ask for a socket server.
          let Server = null

          try {
            Server = require('socket.io').Server
          } catch (e) {
            return callback(new Error('startSocketServer is true but socket.io is not installed. Run `npm install socket.io` in your project.'))
          }

          this.io = new Server(this._httpServer, { cors })
        }
      }

      // Register hearthjs SQL files
      this._loopDirectory(path.join(__dirname, 'sqlRequest'), '^[a-zA-Z0-9]+\\.sql$', (filePath) => {
        database.registerSQLFile(filePath)
      })

      // Connect database
      database.init({
        user: this.config.APP_DATABASE_USERNAME,
        host: this.config.APP_DATABASE_HOST,
        database: this.config.APP_DATABASE_NAME,
        password: this.config.APP_DATABASE_PASSWORD,
        port: this.config.APP_DATABASE_PORT,
        timeout: this.config.APP_DATABASE_TIMEOUT
      }, (err) => {
          if (err) {
            return callback(err)
          }

          // Init migration system
          migration.init(this._serverPath, database, (err) => {
            if (err) {
              return callback(err)
            }

            this._initMiddleware()

              // Call project init function, user can add middleware here
              this._callFunctionIfExists('init', [this._app], (err) => {
                if (err) {
                  return callback(err)
                }

                // Init all addons registered
                this._initAddons(this._addons, 0, (err) => {
                  if (err) {
                    return callback(err)
                  }

                  // Init the server/api directory
                  helper._createDirectoryIfNotExists(path.join(this._serverPath, 'api'))

                  // Register all API. A syntax error in one of those files
                  // would otherwise throw from this callback and kill the process
                  try {
                    this._loopDirectory(path.join(this._serverPath, 'api'), 'api\\.\\S+\\.js', (filePath) => {
                      this._apiReady = false
                      if (require.cache[filePath]) {
                        delete require.cache[filePath]
                      }
                      require(filePath)
                    })
                  } catch (e) {
                    return callback(new Error(`Error while loading the API files: ${e.toString()}`))
                  }

                  // Register all SQL files
                  this._loopDirectory(path.join(this._serverPath), '^[a-zA-Z0-9]+\\.sql$', (filePath) => {
                    database.registerSQLFile(filePath)
                  })

                  let interval = setInterval(() => {
                    if (this._apiReady) {
                      // When application is started, load all cron
                      cron.loadCron((err) => {
                        if (err) {
                          return callback(err)
                        }

                        clearInterval(interval)

                        // Call after init function from server project
                        this._callFunctionIfExists('afterInit', [this._app], (err) => {
                          if (err) {
                            return callback(err)
                          }

                          this._initErrorMiddleware()
                          return callback(null)
                        })
                      })
                    }
                  }, 120)
                })
              })
            })
          })
        })
  },

  /**
   * api.js calls this function to tell the server all API avec been declared and served
   * @param {Boolean} value
   */
  _setApiReady: function (value) {
    this._apiReady = value
  },

  /**
   * Load config file depends on environment
   * @param {String} env Choosen envirenment dev/prod/test
   * @param {Object} options Parameters send via CLI which can override the conf file
   */
  _loadConfig: function (env, options, callback) {
    const mandatoryKey = ['APP_SERVER_PORT'] // Add mandatory key here
    helper._createDirectoryIfNotExists(path.join(this._serverPath, 'config'))
    const configPath = path.join(this._serverPath, 'config', env + '.json')
    const cliKeys = [{ confName: 'APP_SERVER_PORT', cliName: 'port', type: 'integer' },
      { confName: 'APP_DATABASE_USERNAME', cliName: 'db_username', type: 'string' },
      { confName: 'APP_DATABASE_HOST', cliName: 'db_host', type: 'string' },
      { confName: 'APP_DATABASE_NAME', cliName: 'db_name', type: 'string' },
      { confName: 'APP_DATABASE_PASSWORD', cliName: 'db_password', type: 'string' },
      { confName: 'APP_DATABASE_PORT', cliName: 'db_port', type: 'integer' }]

    // Check if file exists before reading it
    fs.access(configPath, fs.constants.F_OK, (err) => {
      if (err) {
        return helper.createDefaultConfigFile(env, (err) => {
          if (err) {
            logger.log('An error occured while writing config file: ' + JSON.stringify(err, null, 2), 'error', { logDate: false })
          }

          return callback(new Error('A config file has been created, please check values are correct'))
        })
      }

      fs.readFile(configPath, 'utf-8', (err, data) => {
        if (err) {
          return callback(err)
        }

        try {
          this.config = JSON.parse(JSON.stringify(this._defaultConfig))
          this.config = Object.assign(this.config, JSON.parse(data))

          // Override keys sent via cli in conf
          for (let i = 0; i < cliKeys.length; i++) {
            if (options[cliKeys[i].cliName] !== undefined) {
              if (cliKeys[i].type === 'integer') {
                this.config[cliKeys[i].confName] = parseInt(options[cliKeys[i].cliName])
              } else {
                this.config[cliKeys[i].confName] = options[cliKeys[i].cliName]
              }
            }
          }

          // Check if mandatory keys are missing
          for (let i = 0; i < mandatoryKey.length; i++) {
            if (this.config[mandatoryKey[i]] === undefined) {
              return callback(new Error(`Missing mandatory key ${mandatoryKey[i]} in ${configPath}`))
            }
          }

          // Check database key value
          return this._checkDatabaseConfiguration(env, (err) => {
            if (err) {
              return callback(err)
            }

            return callback(null)
          })
        } catch (e) {
          return callback(e)
        }
      })
    })
  },

  /**
   * Check if the database has a valid configuration, else write a basic sample
   * @param {String} env test, dev or prod
   * @param {Function} callback
   */
  _checkDatabaseConfiguration: function (env, callback) {
    /**
     * Check if key name has value in config file or in process.env
     * @param {String} keyName Key name to check
     */
    const _checkFunction = (keyName) => {
      if ((this.config[keyName] === undefined || this.config[keyName] === null) && (process.env[keyName] === undefined || process.env[keyName] === null)) {
        return new Error(`A valid value is missing for ${keyName}, open your configuration file and update it`)
      }

      return null
    }

    const _keys = ['APP_DATABASE_USERNAME', 'APP_DATABASE_HOST', 'APP_DATABASE_NAME', 'APP_DATABASE_PASSWORD', 'APP_DATABASE_PORT']
    let _error = null

    for (let i = 0; i < _keys.length; i++) {
      _error = _checkFunction(_keys[i])

      if (_error !== null) {
        break
      }
    }

    if (_error === null) {
      return callback(null)
    }

    return helper.createDefaultConfigFile(env, (err) => {
      if (err) {
        logger.log('An error occured while writing config file: ' + JSON.stringify(err, null, 2), 'error', { logDate: false })
      }

      return callback(_error)
    })
  },


  /**
   * Init all middlewares
   */
  _initMiddleware: function () {
    // Must come first: everything below expects the express request/response API
    this._app.use(expressCompat())
    this._app.use(this._drainMiddleware())
    this._app.use(logger._logMiddleware())
    this._app.use(cookieParser())
  },

  /**
   * While draining, tell clients not to reuse the connection: it is about to
   * be closed.
   */
  _drainMiddleware: function () {
    return (req, res, next) => {
      if (this._draining === true) {
        res.setHeader('connection', 'close')
      }

      return next()
    }
  },

  /**
   * How long a client may take to send a whole request, headers included.
   * 0 disables the limit and restores node's behaviour of waiting.
   */
  _getRequestTimeout: function () {
    const _fromEnv = process.env.APP_REQUEST_TIMEOUT

    if (_fromEnv !== undefined) {
      const _parsed = parseInt(_fromEnv, 10)

      return (Number.isInteger(_parsed) && _parsed >= 0) ? _parsed : 60000
    }

    if (this.config !== null && this.config.APP_REQUEST_TIMEOUT !== undefined) {
      const _parsed = parseInt(this.config.APP_REQUEST_TIMEOUT, 10)

      return (Number.isInteger(_parsed) && _parsed >= 0) ? _parsed : 60000
    }

    return 60000
  },

  /**
   * How long in-flight requests are given to finish before their sockets are
   * destroyed. 0 disables the force close and waits indefinitely.
   */
  _getShutdownTimeout: function () {
    const _fromEnv = process.env.APP_SHUTDOWN_TIMEOUT

    if (_fromEnv !== undefined) {
      const _parsed = parseInt(_fromEnv, 10)

      return (Number.isInteger(_parsed) && _parsed >= 0) ? _parsed : 10000
    }

    if (this.config !== null && this.config.APP_SHUTDOWN_TIMEOUT !== undefined) {
      const _parsed = parseInt(this.config.APP_SHUTDOWN_TIMEOUT, 10)

      return (Number.isInteger(_parsed) && _parsed >= 0) ? _parsed : 10000
    }

    return 10000
  },

  /**
   * Should hearthjs catch SIGTERM/SIGINT itself? Applications embedding the
   * server can opt out with APP_GRACEFUL_SHUTDOWN=false and call close()
   * themselves.
   */
  _isGracefulShutdownEnabled: function () {
    if (process.env.APP_GRACEFUL_SHUTDOWN !== undefined) {
      return process.env.APP_GRACEFUL_SHUTDOWN !== 'false'
    }

    if (this.config !== null && this.config.APP_GRACEFUL_SHUTDOWN === false) {
      return false
    }

    return true
  },

  /**
   * Catch SIGTERM/SIGINT so the supervisor gets a clean shutdown.
   * A second signal stops waiting and exits straight away.
   */
  _installShutdownHandlers: function () {
    if (this._signalHandlers !== null || this._isGracefulShutdownEnabled() === false) {
      return
    }

    this._signalHandlers = {}

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const _handler = () => {
        if (this._closing === true) {
          logger.log(`Received ${signal} while shutting down, exiting now`, 'warn', { logDate: false })
          return process.exit(1)
        }

        logger.log(`Received ${signal}, shutting down gracefully`, 'info', { logDate: false })

        this.close((err) => {
          if (err) {
            logger.log(`Error while shutting down: ${err.toString()}`, 'error', { logDate: false })
            return process.exit(1)
          }

          logger.log('Shutdown complete', 'info', { logDate: false })
          return process.exit(0)
        })
      }

      this._signalHandlers[signal] = _handler
      process.on(signal, _handler)
    }
  },

  /**
   * Detach the signal handlers, so a process running several servers in a row
   * (the test suite) does not pile listeners up
   */
  _removeShutdownHandlers: function () {
    if (this._signalHandlers === null) {
      return
    }

    for (const signal in this._signalHandlers) {
      process.removeListener(signal, this._signalHandlers[signal])
    }

    this._signalHandlers = null
  },

  /**
   * Kept for call order: restana takes its error handler at creation time.
   */
  _initErrorMiddleware: function () {},

  /**
   * Reply to an unmatched route with the body express produced.
   * @param {Object} req Request
   * @param {Object} res Response
   */
  _handleNotFound: function (req, res) {
    const _path = req.url.split('?')[0]
    const _body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${escapeHtml(req.method)} ${escapeHtml(_path)}</pre>\n</body>\n</html>\n`

    res.statusCode = 404
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('content-security-policy', "default-src 'none'")
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(_body)
  },

  /**
   * Turn an error raised by a middleware or a handler into a response
   * @param {Error} err Error raised
   * @param {Object} req Request
   * @param {Object} res Response
   */
  _handleError: function (err, req, res) {
    let _code = 400

    if (err !== null && err !== undefined && typeof err.code === 'number') {
      _code = err.code || 400
    }

    // A string passed to next() is a message written for the caller, an Error is
    // not: its text carries table names, file paths and stack details.
    const _isIntentional = (typeof err === 'string')
    const _expose = _isIntentional || this._env !== 'prod' || (err !== null && err !== undefined && err.expose === true)
    const _detail = (err !== null && err !== undefined && err.message !== undefined) ? err.message : String(err)

    if (_isIntentional === false) {
      logger.log(`${req.method} ${req.url} failed: ${_detail}`, 'error')
    }

    expressCompat.decorateRequest(req)
    expressCompat.decorateResponse(req, res)

    return res.status(_code).json({
      success: false,
      message: _expose ? _detail : 'An error occured'
    })
  },

  /**
   * Loop on all file and require all API
   * @param {String} dirPath Begin path
   * @param {String} stringRegex String regex to match files
   * @param {Function} toDo Function to call if match
   */
  _loopDirectory: function (dirPath, stringRegex, toDo) {
    const list = fs.readdirSync(dirPath)
    let regex = RegExp(stringRegex)

    for (let i = 0; i < list.length; i++) {
      let filePath = path.join(dirPath, list[i])
      let stat = fs.statSync(filePath)

      if (stat && stat.isDirectory() && filePath.includes('uploads') === false) {
        this._loopDirectory(filePath, stringRegex, toDo)
      } else if (regex.test(list[i])) {
        toDo(filePath)
      }
    }
  },

  /**
   * Register an addon in application
   * @param {Object} userAddon Addon to add
   * @param {String} schemaKeyName Name of the key in schema. This key override the schemaKeyName defined in userAddon
   */
  useAddon: function (userAddon, schemaKeyName) {
    if (userAddon.schemaKeyName === undefined && schemaKeyName === undefined) {
      logger.log('Error: all addons must have a schemaKeyName', 'error', { logDate: false })
      return process.exit(1)
    }

    if (schemaKeyName !== undefined) {
      userAddon.schemaKeyName = schemaKeyName
    }

    // Check if an addon with this name already exists or not
    let index = this._addons.findIndex(elem => elem.schemaKeyName === userAddon.schemaKeyName)

    if (index !== -1) {
      logger.log(`An addon ${userAddon.schemaKeyName} has already been defined`, 'error', { logDate: false })
      return process.exit(1)
    }

    // Register addon
    this._addons.push(userAddon)
  },




  /**
   * Init all addons registered
   * @param {Array} addons Array of addons
   * @param {Integer} index addons index
   * @param {Function} callback
   */
  _initAddons: function (addons, index, callback) {
    if (index >= addons.length) {
      return callback(null)
    }

    let currentAddon = addons[index]

    // Init the addon with it's init function if it exists
    addon.initAddon(database, currentAddon, (err) => {
      if (err) {
        logger.log(`Error while initializing addon ${currentAddon.schemaKeyName}: ${JSON.stringify(err, null, 2)}`, 'error', { logDate: false })
        return process.exit(1)
      }

      this._initAddons(addons, index + 1, callback)
    })
  },

  /**
   * Run the server
   * @param {Object} newConfig Server config
   * @param {Function} callback
   */
  run: function (env, serverPath, options, callback) {
    if (callback === undefined) {
      callback = options
      options = {}
    }

    // Read back by _logStartup, which runs from _startServer
    this._startedAt = Date.now()

    this._env = env

    // Check server path has been set
    this._serverPath = serverPath

    logger.initLogger(env)

    const _serverFilePath = path.join(this._serverPath, 'index.js')

    // Check if server.js exists to require it
    fs.access(_serverFilePath, fs.constants.F_OK, (err) => {
      if (err) {
        // File does not exists, this is not a problem
        return this._startServer(env, options, callback)
      }

      // File exists, require it
      if (require.cache[_serverFilePath]) {
        delete require.cache[_serverFilePath]
      }

      try {
        this._projectServerFile = require(_serverFilePath)
      } catch (e) {
        return callback(new Error(`Error while loading ${_serverFilePath}: ${e.toString()}`))
      }

      return this._startServer(env, options, callback)
    })
  },

  /**
   * Call a function of the project server file
   * @param {String} functionName Function name in project server file
   * @param {Array} args List of arguments to pass
   * @param {Function} callback
   */
  _callFunctionIfExists: function (functionName, args, callback) {
    if (this._projectServerFile === null) {
      return callback(null)
    }

    if (this._projectServerFile?.[functionName] !== undefined) {
      return this._projectServerFile[functionName].apply(null, args.concat([callback]))
    }

    return callback(null)
  },

  /**
   * Load the configuration and start the HTTP server
   * @param {String} env test, dev or prod
   * @param {Function} callback
   */
  _startServer: function (env, options, callback) {
    this._loadConfig(env, options, (err) => {
      if (err) {
        return callback(err)
      }

      this._init(env, (err) => {
        if (err) {
          return callback(err)
        }

        // listen() reports EADDRINUSE through an event: without this it is an
        // uncaught exception and the run() callback never fires
        let _listenFailed = false

        this._httpServer.once('error', (err) => {
          _listenFailed = true
          return callback(err)
        })

        this._server = this._httpServer.listen(this.config.APP_SERVER_PORT, () => {
          if (_listenFailed === true) {
            return
          }

          this._installShutdownHandlers()

          this._logStartup(env)
          return callback(null)
        })
      })
    })
  },

  /**
   * Format a duration the way an operator reads it
   * @param {Number} ms Duration in milliseconds
   * @returns {String} Human readable duration
   */
  _humanMs: function (ms) {
    return (ms >= 1000) ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`
  },

  /**
   * Address the server actually bound to. Node reports '::' for every interface,
   * which is written 0.0.0.0 everywhere else.
   * @returns {String} host:port
   */
  _getBoundAddress: function () {
    const _address = (this._server !== null && this._server !== undefined) ? this._server.address() : null

    if (_address === null || typeof _address !== 'object') {
      return `0.0.0.0:${this.config.APP_SERVER_PORT}`
    }

    const _host = (_address.address === '::' || _address.address === '') ? '0.0.0.0' : _address.address

    return `${_host}:${_address.port}`
  },

  /**
   * Report what is running, where, and against what. Printed once on startup so
   * an incident starts with the facts instead of a guess.
   * @param {String} env Environment the server was started in
   */
  _logStartup: function (env) {
    const _options = { logDate: false }
    const _read = (key) => (this.config[key] !== undefined && this.config[key] !== null) ? this.config[key] : process.env[key]
    const _api = require('./api')
    // Two space indent and a fixed label column: the values line up in a terminal
    const _row = (label, value) => logger.log(`  ${label.padEnd(11)}${value}`, 'info', _options)

    const _nbApi = Object.keys(_api._apiList).length
    const _nbCron = Object.keys(cron._cronList).length
    const _dbTimeout = Number(_read('APP_DATABASE_TIMEOUT') || database._defaultTimeout)
    const _requestTimeout = this._getRequestTimeout()
    const _shutdownTimeout = this._getShutdownTimeout()

    // 0 means opposite things: no limit on a request, an unbounded shutdown wait
    const _request = (_requestTimeout === 0) ? 'disabled' : this._humanMs(_requestTimeout)
    const _statement = (_dbTimeout === 0) ? 'none' : this._humanMs(_dbTimeout)
    let _shutdown = 'none'

    if (this._isGracefulShutdownEnabled() === true) {
      _shutdown = (_shutdownTimeout === 0) ? 'no limit' : this._humanMs(_shutdownTimeout)
    }

    logger.log(`hearthjs ${version} · node ${process.version} · pid ${process.pid} · env ${modeName[env]}`, 'info', _options)
    _row('listening', this._getBoundAddress())
    _row('database', `${_read('APP_DATABASE_NAME')}@${_read('APP_DATABASE_HOST')}:${_read('APP_DATABASE_PORT')} · statement timeout ${_statement}`)
    _row('loaded', `${_nbApi} apis · ${_api._nbRouteDeclared} routes · ${_nbCron} crons · ${this._addons.length} addons`)
    _row('timeouts', `request ${_request} · shutdown ${_shutdown}`)
    _row('logs', `${logger._getLogFilePath()} · stdout ${logger._mustLogOnStdout() ? 'on' : 'off'}`)
    _row('ready', `${Date.now() - (this._startedAt || Date.now())}ms`)

    this._logStartupWarnings(env)
  },

  /**
   * Point out the settings that only hurt once the server is already in trouble
   * @param {String} env Environment the server was started in
   */
  _logStartupWarnings: function (env) {
    const _options = { logDate: false }

    // Without this the process writes nothing to journald, so a crash leaves a
    // stack trace with no request context around it
    if (env === 'prod' && logger._mustLogOnStdout() === false) {
      logger.log('logs are written to the file only: journalctl will show nothing. Set APP_LOG_STDOUT=true', 'warn', _options)
    }

    if (this._getRequestTimeout() === 0) {
      logger.log('request timeout is disabled: a client that never finishes its request holds a socket forever', 'warn', _options)
    }

    if (this._isGracefulShutdownEnabled() === false) {
      logger.log('graceful shutdown is off: a deploy drops the requests in flight', 'warn', _options)
    }
  },

  /**
   * Close the server: stop the crons, stop accepting connections, let the
   * in-flight requests finish, then release the database pool.
   * @param {String} signal Ignored, kept so close(signal, callback) still works
   * @param {Function} callback
   */
  close: function (signal, callback) {
    if (callback === undefined) {
      callback = signal
    }

    if (typeof callback !== 'function') {
      callback = function () {}
    }

    // A close already in progress: join it instead of starting a second one
    if (this._closing === true) {
      this._closeCallbacks.push(callback)
      return
    }

    this._closing = true
    this._closeCallbacks = [callback]

    /**
     * Answer every caller waiting on this shutdown, once
     * @param {Error} err Error to report, null when the shutdown went through
     */
    const _done = (err) => {
      const _callbacks = this._closeCallbacks

      this._closeCallbacks = []
      this._closing = false

      for (let i = 0; i < _callbacks.length; i++) {
        _callbacks[i](err || null)
      }
    }

    // Require api here because api requires this file
    const _api = require('./api')

    this._removeShutdownHandlers()

    // No new scheduled work while we are shutting down
    cron.destroyCrons()

    const _server = this._server

    // Nothing is listening: only the database is left to release
    if (_server === null) {
      _api._reset()

      return database.close(() => {
        this._reset()
        this.config = JSON.parse(JSON.stringify(this._defaultConfig))
        return _done(null)
      })
    }

    // Answers sent from now on tell the client not to reuse the connection
    this._draining = true

    let _idleInterval = null
    let _forceTimer = null

    /**
     * Release the routes and the database once nothing is being served
     * @param {Error} err Error to report, null when the shutdown went through
     */
    const _finish = (err) => {
      if (_idleInterval !== null) {
        clearInterval(_idleInterval)
        _idleInterval = null
      }

      if (_forceTimer !== null) {
        clearTimeout(_forceTimer)
        _forceTimer = null
      }

      // The routes are only released once nothing is being served any more
      _api._reset()

      return database.close(() => {
        this._reset()
        this.config = JSON.parse(JSON.stringify(this._defaultConfig))
        return _done(err)
      })
    }

    // socket.io keeps long lived connections which would hold the server open.
    // Closing it also closes the HTTP server it is attached to.
    if (this.io !== null && this.io !== undefined) {
      const _io = this.io

      this.io = null

      try {
        _io.close(() => _finish(null))
      } catch (e) {
        _finish(null)
      }
    } else {
      _server.close(() => _finish(null))
    }

    // server.close() waits for every connection, and an idle keep-alive socket
    // never ends on its own: close them as they go idle.
    _server.closeIdleConnections()

    _idleInterval = setInterval(() => {
      _server.closeIdleConnections()
    }, 50)

    if (_idleInterval.unref !== undefined) {
      _idleInterval.unref()
    }

    const _timeout = this._getShutdownTimeout()

    if (_timeout > 0) {
      _forceTimer = setTimeout(() => {
        logger.log(`Shutdown timeout reached after ${_timeout}ms, closing the remaining connections`, 'warn', { logDate: false })
        _server.closeAllConnections()
      }, _timeout)

      if (_forceTimer.unref !== undefined) {
        _forceTimer.unref()
      }
    }
  }
}

module.exports = server
