const hearthjs = require('../../../../lib')

const server = {
  startSocketServer: true,

  socketCorsOptions: {
    origin: 'http://localhost:9999'
  },

  init: function (server, callback) {
    server.use(hearthjs.express.json())
    return callback()
  }
}

module.exports = server
