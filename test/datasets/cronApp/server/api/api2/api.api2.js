const hearth = require('../../../../../../lib/index')
// `t` used to be the translation marker, it only ever returned its key
const t = (key) => key
const cluster = require('cluster')

const schemas = {
  getSchemaA: {
    before: (req, res, next) => {
      next(t('Error...'))
    }
  },

  schema: {
    before: (req, res, next) => {
      return res.send(t('Hello', 'en'))
    }
  },

  crash: {
    before: (req, res, next) => {
      process.exit(1)
    }
  },

  user: {
    before: (req, res, next) => {
      let _id = null

      if (cluster.worker) {
        _id = cluster.worker.id
      }

      return res.json({ id: _id })
    }
  }
}

hearth.api.define('api2', schemas, (server) => {
  server.get('/from-api2', 'schema')
  server.get('/crash', 'crash')
  server.get('/user', 'user')
})
