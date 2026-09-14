/** The shape carbone-account's needAuth addon has: a 401 of its own, answered
    before any role is considered. The identity comes from a header here so the
    test drives it without signing a token. */
const permissionAuthAddon = {
  schemaKeyName: 'needAuthentication',

  exec: function (addonValue, db, route, schema, req, res, next) {
    if (addonValue !== true) {
      return next()
    }

    if (req.headers['x-role'] === undefined) {
      return res.status(401).json({ success: false, data: {}, message: 'You are not authenticated' })
    }

    req.token = { role: req.headers['x-role'] }
    return next()
  }
}

module.exports = permissionAuthAddon
