const bodyParser = require('body-parser')
const serveStatic = require('serve-static')

/**
 * Body parsing and static file middlewares, exposed as `hearthjs.express`.
 * They are the very packages express re-exports.
 */
const middlewares = {
  json: bodyParser.json,
  urlencoded: bodyParser.urlencoded,
  raw: bodyParser.raw,
  text: bodyParser.text,
  static: serveStatic
}

module.exports = middlewares
