const hearth = require('../../../../../../lib/index')
// `t` used to be the translation marker, it only ever returned its key
const t = (key) => key
const multer = require('multer')

let upload = multer({ dest: '../uploads/' })

let myMiddleware = function (req, res, next) {
  req.val = 'value'
  next()
}

const schemas = {
  // Used to check the log level follows the response status code
  // Answers, then answers again from a callback
  answerTwice: {
    function: (req, res) => {
      res.send('first')
      setImmediate(() => res.send('second'))
    }
  },

  // Sets a header after the answer was already sent
  headerTooLate: {
    function: (req, res) => {
      res.send('sent')
      setImmediate(() => res.setHeader('x-late', '1'))
    }
  },

  // A body JSON.stringify cannot handle, answered from a callback
  circularBody: {
    function: (req, res) => {
      const _circular = { name: 'x' }

      _circular.self = _circular
      setImmediate(() => res.status(200).json(_circular))
    }
  },

  // Held open on purpose: lets a test close the server mid-request.
  // It signals when the handler is entered so the test never has to guess how
  // long the request takes to arrive, and it answers when the test says so.
  slowShutdown: {
    function: (req, res) => {
      process.once('test:release-slow-shutdown', () => res.send('finished'))
      process.emit('test:slow-shutdown-received')
    }
  },

  // Never answers, so only the shutdown timeout can end the request
  neverAnswers: {
    function: (req, res) => {
      process.emit('test:never-answers-received')
    }
  },

  // Used to check the contextual fields appended to the request log line
  getLogContext: {
    function: (req, res) => {
      req.hearth_log = { account: 4821, template: 'my invoice.odt', skipped: null }
      return res.send('ok')
    }
  },

  getStatus404: {
    function: (req, res) => res.status(404).send('not found')
  },

  getStatus500: {
    function: (req, res) => res.status(500).send('boom')
  },

  getSchemaA: {
    before: (req, res, next) => {
      next(t('Error...', 'fr'), 402)
    }
  },

  getSchemaB: {
    after: (req, res, data, next) => {
      return res.send(t('Coucou', req.lang))
    }
  },

  getSchemaC: {
    before: (req, res, next) => {
      req.msg = t('ououlala')
      next()
    },

    after: (req, res, data, next) => {
      return res.send(req.msg.replace('la', 'le'))
    }
  },

  postSchemaD: {
    before: (req, res, next) => {
      req.value = req.body.value1 + req.body.value2 + req.body.value3
      next()
    },

    after: (req, res, data, next) => {
      return res.send(req.value)
    }
  },

  putSchemaE: {
    before: (req, res, next) => {
      req.value = req.body.value1 + req.body.value2 + req.body.value3
      next()
    },

    after: (req, res, data, next) => {
      return res.send(req.value)
    }
  },

  delSchemaF: {
    before: (req, res, next) => {
      req.value = req.params.id
      next()
    },

    after: (req, res, data, next) => {
      return res.send(req.value)
    }
  },

  testMiddleware: {
    middleware: [myMiddleware],
    before: (req, res, next) => {
      return res.send(req.val)
    }
  },

  uploadFile: {
    middleware: [upload.single('file')],
    before: (req, res, next) => {
      return res.send(req.file.originalname)
    }
  },

  emptySchema: {
    successMsg: t('Great!')
  },

  schemaWithIn: {
    in: ['object', {
      accounts: ['array', {
        name: ['>', '5', 'errorMessage', '> 5'],
        users: ['array', {
          firstname: ['>=', 4, 'startsWith', 'Jo', 'endsWith', 'hn', 'error>=Message', '4 char min', 'errorStartsWithMessage', 'begin with Jo', 'errorendsWithMessage', 'end with hn'],
          mail: ['type', 'mail']
        }]
      }]
    }],

    after: (req, res, data, next) => {
      next(null, 201, req.body)
    }
  },

  getWithIn: {
    in: ['object', {
      firstname: [],
      age: []
    }]
  },

  schemaWithFunction: {
    function: myFunc
  },

  schemaWithRoles: {
    before: (req, res, next) => {
      res.send(t('OK'))
    }
  }
}

hearth.api.define('ApiName', schemas, (server) => {
  server.get('/error')
  server.get('/schema-a', 'getSchemaA')
  server.get('/schema-b', 'getSchemaB')
  server.get('/schema-c', 'getSchemaC')
  server.post('/schema-d', 'postSchemaD')
  server.put('/schema-e', 'putSchemaE')
  server.delete('/schema-f/:id', 'delSchemaF')
  server.get('/middleware', 'testMiddleware')
  server.post('/upload-file', 'uploadFile')
  server.get('/empty-schema', 'emptySchema')
  server.get('/func', 'schemaWithFunction')
  server.post('/schema-with-in', 'schemaWithIn')
  server.get('/get-with-in', 'getWithIn')
  server.get('forgot-slash', 'schemaWithFunction')
  server.get('schema-with-roles', 'schemaWithRoles')
  server.get('/answer-twice', 'answerTwice')
  server.get('/header-too-late', 'headerTooLate')
  server.get('/circular-body', 'circularBody')
  server.get('/slow-shutdown', 'slowShutdown')
  server.get('/never-answers', 'neverAnswers')
  server.get('/log-context', 'getLogContext')
  server.get('/status-404', 'getStatus404')
  server.get('/status-500', 'getStatus500')
})

function myFunc (req, res) {
  return res.send(t('OK!'))
}
