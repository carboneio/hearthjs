const { parseCookie } = require('cookie')

const PARSE_OPTIONS = { decode: decodeValue }

/**
 * Decode one cookie value exactly like cookie-parser 1.4.7 (cookie 0.7.2 + JSONCookie):
 * surrounding double quotes stripped, percent-decoded unless malformed, then a
 * "j:" value replaced by its JSON when the parse succeeds with a truthy result
 * @param {String} value Raw value, already trimmed by parseCookie
 * @return {*} Decoded string, or the JSON value of a "j:" cookie
 */
function decodeValue (value) {
  let _value = (value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22) ? value.slice(1, -1) : value

  if (_value.indexOf('%') !== -1) {
    try {
      _value = decodeURIComponent(_value)
    } catch {
      // malformed escape: keep the raw value, never throw
    }
  }

  if (_value.startsWith('j:') === true) {
    try {
      // falsy JSON (0, false, null, "") keeps the raw string, like JSONCookies
      return JSON.parse(_value.slice(2)) || _value
    } catch {
      return _value
    }
  }

  return _value
}

/**
 * Populate req.cookies, req.signedCookies and req.secret, a drop-in for cookieParser()
 * without secret: same values, same object shapes, and a pre-set req.cookies is left alone
 * @param {Object} req Request
 * @param {Object} res Response
 * @param {Function} next Next middleware
 */
function cookies (req, res, next) {
  if (req.cookies) {
    return next()
  }

  const _header = req.headers.cookie

  // same own properties, in the same order, as cookie-parser
  req.secret = undefined
  req.cookies = (typeof _header === 'string' && _header !== '') ? parse(_header) : Object.create(null)
  req.signedCookies = Object.create(null)

  if (_header && typeof _header !== 'string') {
    // the message cookie 0.7.2 threw
    throw new TypeError('argument str must be a string')
  }

  next()
}

/**
 * Parse a Cookie header into the plain object cookie-parser returned
 * @param {String} header Non-empty Cookie header
 * @return {Object} Cookies by name, the first occurrence of a name wins
 */
function parse (header) {
  const _parsed = parseCookie(header, PARSE_OPTIONS)
  // cookie-parser returned a plain object, not parseCookie's null-prototype one. Copying
  // is cheaper than Object.setPrototypeOf, and keeps the same key order
  const _cookies = {}

  for (const _name in _parsed) {
    // assigning "__proto__" on a plain object was a no-op: the cookie is dropped and never
    // reaches the prototype
    if (_name !== '__proto__') {
      _cookies[_name] = _parsed[_name]
    }
  }

  return _cookies
}

module.exports = cookies
