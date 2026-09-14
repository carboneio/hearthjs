const bodyParser = require('body-parser')
const serveStatic = require('serve-static')

/**
 * Keep a parser on the express 4 defaults body-parser 2 dropped
 * @param {Function} parser One of body-parser's four parsers
 * @param {Object} defaults Options body-parser 2 no longer defaults to
 * @returns {Function} The same parser, with the express 4 behaviour restored
 **/
function expressDefaults (parser, defaults) {
  return (options) => {
    const _parse = parser({ ...defaults, ...options })

    // body-parser 2 leaves req.body undefined when it parses nothing, where
    // express 4 always handed the handler an object
    return (req, res, next) => _parse(req, res, (err) => {
      if (req.body === undefined) {
        req.body = {}
      }

      return next(err)
    })
  }
}

/**
 * Body parsing and static file middlewares, exposed as `hearthjs.express`.
 * They are the very packages express re-exports.
 */
const middlewares = {
  json: expressDefaults(bodyParser.json),
  // express 4 parsed `a[b]=c`, body-parser 2 defaults the nesting off
  urlencoded: expressDefaults(bodyParser.urlencoded, { extended: true }),
  raw: expressDefaults(bodyParser.raw),
  text: expressDefaults(bodyParser.text),
  static: serveStatic
}

module.exports = middlewares
