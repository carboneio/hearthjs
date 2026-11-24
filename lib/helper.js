const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// Request ids: 15 characters of the URL-safe alphabet nanoid uses, 90 random
// bits. The random bytes are drawn and mapped to characters once per 128 ids:
// a crypto call per request would cost 20 times more.
const UID_ALPHABET = Buffer.from('useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict')
const UID_SIZE = 15
const UID_POOL_SIZE = UID_SIZE * 128
const uidBytes = Buffer.allocUnsafe(UID_POOL_SIZE)
let uidPool = ''
let uidOffset = UID_POOL_SIZE

const modeName = {
  dev: 'DEVELOPMENT',
  prod: 'PRODUCTION',
  test: 'TEST'
}

const helper = {
  /**
   * Ask a question to the user and return his response
   * @param {String} question Question to ask
   * @param {Regex} format The format expected for the answer
   * @param {Function} callback
   */
  ask: function (question, format, callback, response) {
    if (response !== undefined) {
      return callback(response)
    }

    process.stdin.resume()
    process.stdout.write(question)
    process.stdin.once('data', (data) => {
      // Remove \n
      data = data.toString().slice(0, -1)

      if (format === null || format.test(data)) {
        return callback(data)
      }

      process.stdout.write('It should match ' + format + '\n')
      this.ask(question, format, callback)
    })
  },

  /**
   * Return an object to send to database
   * @param {String} mode Application mode (test, dev or prod)
   * @param {Function} callback
   */
  loadConfForDatabase: function (mode, callback) {
    const _confPath = path.join(process.env.HEARTH_SERVER_PATH, 'config', mode + '.json')

    // Read conf file
    fs.readFile(_confPath, 'utf8', (err, content) => {
      if (err) {
        return callback(err)
      }

      let _conf = {}

      // Parse conf file
      try {
        _conf = JSON.parse(content)
      } catch (e) {
        return callback(e)
      }

      // Transform conf file for database
      const _databaseConf = {
        ...this._databaseClientConf(_conf, process.env.HEARTH_SERVER_PATH),
        user: _conf.APP_DATABASE_USERNAME,
        host: _conf.APP_DATABASE_HOST,
        database: _conf.APP_DATABASE_NAME,
        password: _conf.APP_DATABASE_PASSWORD,
        port: _conf.APP_DATABASE_PORT
      }

      return callback(null, _databaseConf)
    })
  },

  /**
   * The database client and SQLite file, the environment winning over the
   * config. A relative SQLite file lives in the server directory, wherever the
   * process was started from.
   * @param {Object} conf Config file content
   * @param {String} serverPath Server directory
   * @return {Object} { client, filename }
   */
  _databaseClientConf: function (conf, serverPath) {
    const _filename = process.env.APP_DATABASE_SQLITE_FILENAME ?? conf.APP_DATABASE_SQLITE_FILENAME

    return {
      client: process.env.APP_DATABASE_CLIENT ?? conf.APP_DATABASE_CLIENT,
      filename: (typeof _filename === 'string' && _filename.length > 0 && _filename !== ':memory:') ? path.resolve(serverPath, _filename) : _filename
    }
  },

  /**
   * Create all basic architecture
   * @param {Function} callback
   */
  createArchitecture: function (callback) {
    // Create all directory
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH))
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'cron'))
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'logs'))
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'migration'))
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'config'))
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'api'))
    this._createDirectoryIfNotExists(path.join(process.env.HEARTH_SERVER_PATH, 'commands'))

    // Create base for config file
    this.createDefaultConfigFile('test', (err) => {
      if (err) {
        return callback(err)
      }

      this.createDefaultConfigFile('dev', (err) => {
        if (err) {
          return callback(err)
        }

        this.createDefaultConfigFile('prod', callback)
      })
    })
  },

  /**
   * Create a directory if it does not exist
   * @param {String} path Directory path
   */
  _createDirectoryIfNotExists: function (dirPath) {
    if (fs.existsSync(dirPath) === false) {
      fs.mkdirSync(dirPath)
      fs.writeFileSync(path.join(dirPath, '.gitkeep'), '')
    }
  },

  /**
   * Write a basic config file
   * @param {String} env test, dev or prod
   * @param {Function} callback
   */
  createDefaultConfigFile: function (env, callback) {
    if (modeName[env] === undefined) {
      return callback(null)
    }

    fs.writeFile(path.join(process.env.HEARTH_SERVER_PATH, 'config', `${env}.json`), JSON.stringify({
      // 'sqlite' to use APP_DATABASE_SQLITE_FILENAME instead of the keys below
      APP_DATABASE_CLIENT: 'postgresql',
      APP_DATABASE_SQLITE_FILENAME: 'database.sqlite',
      APP_DATABASE_USERNAME: 'postgres',
      APP_DATABASE_HOST: 'localhost',
      APP_DATABASE_NAME: 'db_name',
      APP_DATABASE_PASSWORD: 'password',
      APP_DATABASE_PORT: 5432,
      APP_SERVER_PORT: 8080
    }, null, 2), callback)
  },

  /**
   * Loop on an array to process all items. Reads with a cursor, so it does
   * not consume `items`, and a synchronous next() does not grow the stack.
   * @param {Array} items List of item to process
   * @param {Function} itemHandler Function which will process every item
   * @param {Function} errorHandler Function which will be called in case of error
   * @param {Function} callback
   */
  genericQueue: function (items, itemHandler, errorHandler, callback) {
    const queue = {
      items: items,
      currentItem: null,
      isRunning: false,

      _index: 0,
      _insideHandler: false,
      _advanceRequested: false,
      _next: null,

      /**
       * Process the next item, or finish the queue
       * @param {Error} err Error raised by the previous item
       */
      processNextItem: function (err) {
        if (errorHandler && err) {
          return errorHandler(err)
        }

        // The handler called next() synchronously: let the loop below pick the
        // next item up once the current handler has returned
        if (this._insideHandler === true) {
          this._advanceRequested = true
          return
        }

        do {
          this._advanceRequested = false

          if (this._index >= this.items.length) {
            this.isRunning = false

            if (callback) {
              return callback()
            }

            return
          }

          this.currentItem = this.items[this._index]
          this._index += 1
          this._insideHandler = true

          try {
            itemHandler.call(this, this.currentItem, this._next)
          } finally {
            this._insideHandler = false
          }
        } while (this._advanceRequested === true)
      },

      /**
       * Start processing, unless the queue is already running
       */
      start: function () {
        if (this.isRunning === false) {
          this.isRunning = true
          this.processNextItem()
        }
      }
    }

    // Bound once instead of allocating a new bound function for every item
    queue._next = queue.processNextItem.bind(queue)
    return queue
  },

  /**
   * Check if a is a real array
   * @param {Any} a Value to test
   */
  isArray: function (a) {
    return (!!a) && (a.constructor === Array)
  },

  /**
   * Check if a is a real object
   * @param {Any} a Value to test
   */
  isObject: function (a) {
    return (!!a) && (a.constructor === Object)
  },

  /**
   * A random id, unique enough to tell requests apart in the logs
   * @return {String} 15 characters of [A-Za-z0-9_-]
   */
  uid: function () {
    if (uidOffset === UID_POOL_SIZE) {
      crypto.randomFillSync(uidBytes)

      for (let i = 0; i < UID_POOL_SIZE; i++) {
        uidBytes[i] = UID_ALPHABET[uidBytes[i] & 63]
      }

      uidPool = uidBytes.toString('latin1')
      uidOffset = 0
    }

    uidOffset += UID_SIZE
    return uidPool.substring(uidOffset - UID_SIZE, uidOffset)
  }

}

module.exports = helper
