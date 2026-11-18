const hearth = require('../../../../../../lib/index')

const schemas = {
  addNote: {
    query: 'insertNote',
    out: ['object', {
      id: ['<id>'],
      text: ['<text>']
    }]
  },

  getNotes: {
    query: 'getNotes',
    out: [{
      id: ['<<id>>'],
      text: ['<text>'],
      done: ['<done>'],
      meta: ['<meta>']
    }]
  }
}

hearth.api.define('Note', schemas, (server) => {
  server.post('/notes', 'addNote')
  server.get('/notes', 'getNotes')
})
