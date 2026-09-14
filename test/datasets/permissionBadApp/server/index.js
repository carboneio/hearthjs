const hearthjs = require('../../../../lib')

const server = {
  beforeInit: function (callback) {
    hearthjs.roles.configure({
      roles: { ADMIN: ['members.read'] },
      resolve: (req) => req.token?.role,
      requires: (route) => route.schema.needAuthentication === true
    })
    return callback(null)
  },

  init: function (server, callback) {
    return callback(null)
  }
}

module.exports = server
