const path = require('path')
const fs = require('fs')
const nodeCron = require('node-cron')
const helper = require('./helper')

const cron = {
  // Null prototype: a cron named toString would otherwise look declared
  _cronList: Object.create(null),

  /**
   * Load all cron located in the cron directory
   * @param {Function} callback
   */
  loadCron: function (callback) {
    const _cronDirectory = path.join(process.env.HEARTH_SERVER_PATH, 'cron')

    /** Init the server/cron directory */
    helper._createDirectoryIfNotExists(_cronDirectory)

    // Read cron directory
    fs.readdir(_cronDirectory, (err, files) => {
      if (err) {
        return callback(err)
      }

      // Loop on all files to require only cron files
      for (let i = 0; i < files.length; i++) {
        if (files[i].startsWith('cron.') && files[i].endsWith('.js')) {
          const _cronPath = path.join(_cronDirectory, files[i])

          if (require.cache[_cronPath]) {
            delete require.cache[_cronPath]
          }

          // A syntax error in a cron file would otherwise throw from this
          // callback, where nothing catches it
          try {
            require(_cronPath)
          } catch (e) {
            return callback(new Error(`Error while loading cron ${files[i]}: ${e.toString()}`))
          }
        }
      }

      return callback(null)
    })
  },

  /**
   * Destroy all registered cron
   */
  destroyCrons: function () {
    for (let key in this._cronList) {
      this._cronList[key].cron.destroy()
    }
    this._cronList = Object.create(null)
  },

  /**
   * Add a cron to the list
   * @param {String} name Cron name
   * @param {String} expression Cron expression
   * @param {Function} action Cron action
   * @param {Object} options Cron options
   */
  add: function (name, expression, action, options) {
    if (this._cronList[name] !== undefined) {
      throw new Error(`A cron ${name} has already been declared`)
    }

    this._cronList[name] = {
      expression: expression,
      action: action,
      cron: nodeCron.createTask(expression, action)
    }

    if (options !== undefined && options.start) {
      this._cronList[name].cron.start()
    }
  },

  /**
   * Stop a cron
   * @param {String} name Cron name
   */
  stop: function (name) {
    if (this._cronList[name] === undefined) {
      throw new Error(`Unknown cron ${name}`)
    }

    this._cronList[name].cron.stop()
  },

  /**
   * Start a cron
   * @param {String} name Cron name
   */
  start: function (name) {
    if (this._cronList[name] === undefined) {
      throw new Error(`Unknown cron ${name}`)
    }

    this._cronList[name].cron.start()
  }

}

module.exports = cron
