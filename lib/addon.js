/**
 * Call an addon hook, routing a rejected promise or a synchronous throw to
 * the callback instead of letting it become an unhandled rejection.
 * @param {Function} fn Hook to call
 * @param {Object} owner Addon owning the hook, kept as `this` so a hook calling
 * @param {Array} args Arguments, the last one being the callback
 */
function callHook (fn, owner, args) {
  const callback = args[args.length - 1]
  let alreadyCalled = false

  args[args.length - 1] = function (err, code) {
    if (alreadyCalled === true) {
      return
    }

    alreadyCalled = true
    return callback(err, code)
  }

  let result = null

  try {
    result = fn.apply(owner, args)
  } catch (e) {
    return args[args.length - 1](e)
  }

  if (result !== null && result !== undefined && typeof result.then === 'function') {
    result.catch((e) => args[args.length - 1](e))
  }

  return result
}

let addon = {
  /**
   * Init an addon
   * @param {Object} hearth Herathjs instance
   * @param {Object} addon Addon to add
   * @param {Function} callback
   */
  initAddon: function (database, addon, callback) {
    if (addon.init !== undefined) {
      return callHook(addon.init, addon, [database, callback])
    }
    return callback(null)
  },

  /**
   * Init addon for schema
   * @param {Object} addon Addon register in server
   * @param {Object} database Database object
   * @param {String} route Route associated with schema
   * @param {Object} schema Schema where the key has been used
   * @param {Function} callback
   */
  initSchemaAddon: function (addon, addonValue, database, route, schema, callback) {
    if (addon.initSchema !== undefined) {
      return callHook(addon.initSchema, addon, [addonValue, database, route, schema, callback])
    }
    return callback(null)
  },

  /**
   * Exec addon exec function
   * @param {Object} addon Addon register in server
   * @param {Object} database Database instance
   * @param {String} route Route called
   * @param {Object} schema Schema where the key has been used
   * @param {Object} req Req from request
   * @param {Object} res Res from request
   * @param {Function} callback
   */
  execAddon: function (addon, addonValue, database, route, schema, req, res, callback) {
    if (addon.exec !== undefined) {
      return callHook(addon.exec, addon, [addonValue, database, route, schema, req, res, callback])
    }
    return callback(null)
  }
}

module.exports = addon
