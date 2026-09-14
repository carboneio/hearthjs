const hearth = require('../../../../../../lib/index')

/** Two authenticated routes with no `permission`, and one that declares a
    permission while needing no authentication: the three the boot report names */
const schemas = {
  getMembers: {
    needAuthentication: true,
    successMsg: 'listed'
  },

  deleteMember: {
    needAuthentication: true,
    successMsg: 'deleted'
  },

  login: {
    permission: 'members.read',
    successMsg: 'logged in'
  }
}

hearth.api.define('ApiName', schemas, (server) => {
  server.get('/members', 'getMembers')
  server.delete('/members/:id', 'deleteMember')
  server.post('/login', 'login')
})
