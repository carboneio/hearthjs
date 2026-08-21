const api = require('./api')
const server = require('./server')
const db = require('./database')
const converter = require('./converter')
const datasets = require('./datasets')
const cron = require('./cron')
const logger = require('./logger')
const testClient = require('./testClient')
const middlewares = require('./middlewares')
const helper = require('./helper')
const validation = require('./validation')
const mustache = require('./mustache')

const hearth = {
  server: server,
  // Kept under the `express` name for backward compatibility: these are the
  // body-parser / serve-static middlewares express itself re-exports
  express: middlewares,
  middlewares: middlewares,
  api: api,
  db: db,
  converter: converter,
  datasets: datasets,
  logger: logger,
  cron: cron,
  httpClient: testClient,
  helpers: helper,
  validation: validation,
  mustache: mustache,
  env: server.getEnv(),
  /**
   * Register an addon
   * @param {Object} addon Addon to register
   * @param {String} schemaKeyName Schema key that triggers it
   */
  useAddon: function (addon, schemaKeyName) {
    server.useAddon(addon, schemaKeyName)
  },

  /**
   * Run the server
   * @param {String} env Environment
   * @param {Function} callback
   */
  run: function (env, serverPath, options, callback) {
    server.run(env, serverPath, options, callback)
  },

  /**
   * Read a configuration key, the environment winning over the config file
   * @param {String} key Key to read
   */
  getConfig: function (key) {
    return process.env[key] || server.config[key]
  },

  /**
   * Close server and reset everything
   */
  close: function (callback) {
    api._reset()
    server.close(callback)
  }
}
module.exports = hearth
