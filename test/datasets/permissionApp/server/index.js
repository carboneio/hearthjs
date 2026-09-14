const hearthjs = require('../../../../lib')

const server = {
  /**
   * The roles table is declared here, like a rate limit profile: before any api
   * file is loaded, so a route can reference a permission by name
   */
  beforeInit: function (callback) {
    hearthjs.roles.configure({
      roles: {
        ADMIN: ['members.read', 'members.write'],
        USER: ['members.read']
      },
      resolve: (req) => req.token?.role,
      requires: (route) => route.schema.needAuthentication === true
    })
    return callback(null)
  },

  init: function (server, callback) {
    server.use(hearthjs.express.json())
    return callback(null)
  }
}

module.exports = server
