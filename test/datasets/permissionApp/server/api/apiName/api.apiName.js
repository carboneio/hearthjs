const hearth = require('../../../../../../lib/index')

const schemas = {
  getMembers: {
    needAuthentication: true,
    permission: 'members.read',
    successMsg: 'listed'
  },

  addMember: {
    needAuthentication: true,
    permission: 'members.write',
    successMsg: 'added'
  },

  whoami: {
    needAuthentication: true,
    permission: 'any',
    successMsg: 'you'
  },

  login: {
    successMsg: 'logged in'
  }
}

hearth.api.define('ApiName', schemas, (server) => {
  server.get('/members', 'getMembers')
  server.post('/members', 'addMember')
  server.get('/whoami', 'whoami')
  server.post('/login', 'login')
})
