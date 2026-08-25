const fs = require('fs')
const path = require('path')
const debug = require('debug')('hearthjs')
const { nanoid } = require('nanoid')
const helper = require('./helper')

const colors = {
  green: '\u001b[32m',
  red: '\u001b[31m',
  white: '\u001b[37m',
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  underline: '\u001b[4m',
  reverse: '\u001b[7m',
  cyan: '\u001b[36m',
  orange: '\u001b[38;5;208m',
  grey: '\u001b[38;5;242m',
  yellow: '\u001b[33m'
}

const levelColor = {
  info: colors.cyan,
  error: colors.red,
  warn: colors.orange
}

const logger = {
  _writeLogStream: null,
  _currentDate: null,
  _env: null,

  /**
   * Init logger system
   * @param {String} env test, dev or prod
   * @param {Function} callback
   */
  initLogger: function (env) {
    this._env = env

    this._createLogFile()
  },

  /**
   * Stop the log stream. Test helper only.
   * @param {Function} callback Optional, called once everything buffered has
   */
  _stop: function (callback) {
    if (callback === undefined) {
      return this._writeLogStream.end()
    }

    return this._writeLogStream.end(callback)
  },

  /**
   * Create new log file with curren date
   */
  _createLogFile: function () {
    // Nothing to write to until the server has been given a path
    if (process.env.HEARTH_SERVER_PATH === undefined) {
      return
    }

    const _logFilePath = this._getLogFilePath()
    const _date = this._getCurrentDateTime(false)

    /** Init the server/log directory */
    helper._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'logs'))

    this._currentDate = _date

    if (this._writeLogStream !== null) {
      this._writeLogStream.end()
    }

    this._writeLogStream = fs.createWriteStream(_logFilePath, { flags: 'a' })

    this._deleteOldLog()
  },

  /**
   * Delete log files too old
   */
  _deleteOldLog: function () {
    const _logsDirectory = path.join(process.env.HEARTH_SERVER_PATH, 'logs')

    fs.readdir(_logsDirectory, (err, files) => {
      if (err) {
        return this.log(err.toString(), 'error')
      }

      files = files.filter((elem) => elem[0] !== '.' && elem.endsWith('.log'))

      if (files.length > 8) {
        for (let i = 0; i < files.length; i++) {
          let fileName = files[i].split('.')[0]

          let d = new Date(fileName)
          let current = new Date()
          current.setDate(current.getDate() - 7)

          if (d < current) {
            fs.unlink(path.join(_logsDirectory, files[i]), () => {})
          }
        }
      }
    })
  },

  /**
   * Log a message to the log file, and to the console depending on the mode.
   * @param {String} msg Message to log
   * @param {String} level Log level
   * @param {String} options {
   */
  log: function (msg, level, options) {
    if (options && options.mustLog === false) {
      return
    }

    if (level === undefined) {
      level = 'info'
    }

    const _colorLevelStart = levelColor[level] || ''
    const _colorLevelEnd = (_colorLevelStart) ? colors.reset : ''
    const _dateTime = this._getCurrentDateTime(true)
    const _upperLevel = level.toUpperCase()

    let _logFileMsg = `${_dateTime} ${_upperLevel} ${msg}`
    let _logConsoleMsg = `${colors.grey}${_dateTime}${colors.reset} ${_colorLevelStart}${_upperLevel}${_colorLevelEnd} ${msg}`

    if (options && options.logDate === false) {
      _logFileMsg = msg

      if (level === 'error') {
        _logConsoleMsg = `${colors.red}${msg}${colors.reset}`
      } else if (level === 'warn') {
        _logConsoleMsg = `${colors.orange}${msg}${colors.reset}`
      } else {
        _logConsoleMsg = msg
      }
    }

    // Roll the file over when the day changed
    if (this._currentDate !== this._getCurrentDateTime(false)) {
      this._createLogFile()
    }

    // Still null when no server path is set: log to the console only
    if (this._writeLogStream !== null) {
      this._writeLogStream.write(`${_logFileMsg}\n`)
    }

    if (this._mustLogOnStdout()) {
      // Supervisors (systemd, docker) collect stdout, so production logs reach
      // journald. Colours would be stored raw, so drop them off a TTY.
      const _out = process.stdout.isTTY ? _logConsoleMsg : _logFileMsg

      if (level.toLowerCase() === 'error') {
        console.error(_out)
      } else {
        console.log(_out)
      }
    } else if (this._env !== 'prod' && level.toLowerCase() === 'error') {
      console.error(_logConsoleMsg)
    } else if (this._env === 'dev') {
      console.log(_logConsoleMsg)
    }
  },

  /**
   * In dev, use debug lib, else log it in file
   * @param {String} msg Message to log
   */
  debug: function (msg) {
    if (this._env === 'dev') {
      return debug(msg)
    }
  },

  /**
   * Format a duration so it stays readable instead of dumping the raw
   * nanosecond precision of process.hrtime (899.417717ms -> 899ms)
   * @param {Number} ms Duration in milliseconds
   */
  _formatDuration: function (ms) {
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(2)}s`
    }

    if (ms >= 10) {
      return `${Math.round(ms)}ms`
    }

    return `${ms.toFixed(2)}ms`
  },

  /**
   * Request logging middleware: one line per completed request, at a level
   * following the status code. APP_LOG_REQUEST_START adds a line on arrival.
   */
  _logMiddleware: function () {
    const _logStart = this._mustLogRequestStart()

    return (req, res, next) => {
      req.hearth_uid = nanoid(15)
      req.hearth_start = process.hrtime()

      if (_logStart) {
        this.log(`--> ${req.method} ${req.url} [${req.hearth_uid}]`, 'info')
      }

      res.on('finish', () => {
        const _duration = process.hrtime(req.hearth_start)
        // _duration is [seconds, nanoseconds]: the seconds part must be counted
        // too, otherwise a 2.5s request is reported as 500ms
        const _durationMs = _duration[0] * 1e3 + _duration[1] / 1e6
        const _status = res.statusCode
        let _level = 'info'

        if (_status >= 500) {
          _level = 'error'
        } else if (_status >= 400) {
          _level = 'warn'
        }

        let _message = `${req.method} ${req.url} ${_status} ${this._formatDuration(_durationMs)}`
        const _context = this._formatRequestContext(req)

        if (_context !== '') {
          _message += ` ${_context}`
        }

        if (_logStart) {
          // Only needed to pair the line with its "started" counterpart
          _message += ` [${req.hearth_uid}]`
        }

        this.log(_message, _level)
      })
      next()
    }
  },

  /**
   * Contextual fields for a request log line, merged from `req.hearth_log`
   * and the project `getLogContext(req)` hook.
   * @param {Object} req Request
   */
  _formatRequestContext: function (req) {
    let _context = req.hearth_log

    // Required here and not at the top of the file: server.js requires logger.js
    const _server = require('./server')

    if (_server._projectServerFile !== null && _server._projectServerFile !== undefined &&
        typeof _server._projectServerFile.getLogContext === 'function') {
      try {
        const _fromProject = _server._projectServerFile.getLogContext(req)

        if (_fromProject !== undefined && _fromProject !== null) {
          _context = Object.assign({}, _fromProject, _context)
        }
      } catch (e) {
        // Never let logging break a request
        this.log(`getLogContext threw: ${e.toString()}`, 'error')
      }
    }

    if (_context === undefined || _context === null) {
      return ''
    }

    const _parts = []
    const _keys = Object.keys(_context)

    for (let i = 0; i < _keys.length; i++) {
      const _value = _context[_keys[i]]

      if (_value === undefined || _value === null || _value === '') {
        continue
      }

      const _string = String(_value)

      // Keep the line parseable when a value contains spaces
      _parts.push(`${_keys[i]}=${/[\s"]/.test(_string) ? JSON.stringify(_string) : _string}`)
    }

    return _parts.join(' ')
  },

  /**
   * Path of the file the logs are written to today
   * @returns {String|null} Absolute path, null when no server path is set yet
   */
  _getLogFilePath: function () {
    if (process.env.HEARTH_SERVER_PATH === undefined) {
      return null
    }

    return path.join(process.env.HEARTH_SERVER_PATH, 'logs', `${this._getCurrentDateTime(false)}.log`)
  },

  /**
   * Should every log line also go to stdout? On for supervisors that collect
   * process output (APP_LOG_STDOUT), off by default.
   */
  _mustLogOnStdout: function () {
    if (process.env.APP_LOG_STDOUT !== undefined) {
      return process.env.APP_LOG_STDOUT === 'true'
    }

    // Required here and not at the top of the file: server.js requires logger.js
    const _server = require('./server')

    return _server.config !== null && _server.config.APP_LOG_STDOUT === true
  },

  /**
   * Should the middleware also log a line when a request starts?
   * Enabled with APP_LOG_REQUEST_START, in the config file or the environment.
   */
  _mustLogRequestStart: function () {
    if (process.env.APP_LOG_REQUEST_START !== undefined) {
      return process.env.APP_LOG_REQUEST_START === 'true'
    }

    // Required here and not at the top of the file: server.js requires logger.js
    const _server = require('./server')

    return _server.config !== null && _server.config.APP_LOG_REQUEST_START === true
  },

  /**
   * Return a stringify date or date time
   * @param {Boolean} needTime True if we want the time
   */
  _getCurrentDateTime: function (needTime) {
    const _currentDate = new Date()
    let _dateString = ''

    _dateString += ((_currentDate.getMonth() + 1).toString().length === 1) ? `0${_currentDate.getMonth() + 1}` : _currentDate.getMonth() + 1
    _dateString += '-'
    _dateString += (_currentDate.getDate().toString().length === 1) ? `0${_currentDate.getDate()}` : _currentDate.getDate()
    _dateString += '-'
    _dateString += _currentDate.getFullYear()

    if (needTime) {
      _dateString += ' '
      _dateString += (_currentDate.getHours().toString().length === 1) ? `0${_currentDate.getHours()}` : _currentDate.getHours()
      _dateString += ':'
      _dateString += (_currentDate.getMinutes().toString().length === 1) ? `0${_currentDate.getMinutes()}` : _currentDate.getMinutes()
      _dateString += ':'
      _dateString += (_currentDate.getSeconds().toString().length === 1) ? `0${_currentDate.getSeconds()}` : _currentDate.getSeconds()
    }

    return _dateString
  }
}

module.exports = logger
