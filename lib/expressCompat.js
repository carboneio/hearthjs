const path = require('path')
const { STATUS_CODES } = require('http')
const cookie = require('cookie')
const send = require('send')
const escapeHtml = require('escape-html')
const etag = require('etag')
const fresh = require('fresh')
const encodeUrl = require('encodeurl')
const accepts = require('accepts')
const mime = require('mime-types')
const qs = require('qs')
const typeis = require('type-is')

/**
 * Express request/response API on top of restana, which only provides
 * res.send(). Keeps application code and express middleware working.
 */

// Like express' "trust proxy", off by default: X-Forwarded-* is attacker
// controlled until the application opts in with APP_TRUST_PROXY.
let trustProxy = false

/**
 * Enable or disable trusting the X-Forwarded-* headers
 * @param {Boolean} value True to trust the proxy headers
 */
function setTrustProxy (value) {
  trustProxy = (value === true)
}

/**
 * Resolve the value of a request header the way express does
 * @param {Object} req Request
 * @param {String} field Header name
 */
function getHeader (req, field) {
  if (field === undefined || field === null) {
    throw new TypeError('name argument is required to req.get')
  }

  if (typeof field !== 'string') {
    throw new TypeError('name must be a string to req.get')
  }

  const _name = field.toLowerCase()

  if (_name === 'referer' || _name === 'referrer') {
    return req.headers.referrer || req.headers.referer
  }

  return req.headers[_name]
}

/**
 * Add the express request helpers restana does not provide.
 * `params`, `query` and `originalUrl` already come from restana.
 * @param {Object} req Request
 */
// Pre-built once: defining these per request cost six defineProperty calls
const REQUEST_DESCRIPTORS = {
  get: { configurable: true, writable: true, value: reqGet },
  header: { configurable: true, writable: true, value: reqGet },
  accepts: { configurable: true, writable: true, value: reqAccepts },
  acceptsCharsets: { configurable: true, writable: true, value: reqAcceptsCharsets },
  acceptsEncodings: { configurable: true, writable: true, value: reqAcceptsEncodings },
  acceptsLanguages: { configurable: true, writable: true, value: reqAcceptsLanguages },
  is: { configurable: true, writable: true, value: reqIs },
  query: {
    configurable: true,
    get: function () {
      if (this._hearthQuery === undefined) {
        const _index = this.url.indexOf('?')

        this._hearthQuery = (_index === -1)
          ? {}
          : qs.parse(this.url.slice(_index + 1), { allowPrototypes: true })
      }

      return this._hearthQuery
    },
    set: function (value) {
      this._hearthQuery = value
    }
  },
  protocol: {
    configurable: true,
    get: function () {
      if (this.socket !== undefined && this.socket.encrypted === true) {
        return 'https'
      }

      if (trustProxy === false) {
        return 'http'
      }

      const _forwarded = this.headers['x-forwarded-proto']

      if (_forwarded !== undefined) {
        return _forwarded.split(',')[0].trim()
      }

      return 'http'
    }
  },
  secure: {
    configurable: true,
    get: function () {
      return this.protocol === 'https'
    }
  },
  fresh: {
    configurable: true,
    get: function () {
      const _res = this.res

      if (this.method !== 'GET' && this.method !== 'HEAD') {
        return false
      }

      if (_res === undefined) {
        return false
      }

      const _status = _res.statusCode

      if ((_status >= 200 && _status < 300) || _status === 304) {
        return fresh(this.headers, {
          etag: _res.getHeader('etag'),
          'last-modified': _res.getHeader('last-modified')
        })
      }

      return false
    }
  },
  stale: {
    configurable: true,
    get: function () {
      return !this.fresh
    }
  },
  hostname: {
    configurable: true,
    get: function () {
      const _host = (trustProxy === true && this.headers['x-forwarded-host'] !== undefined)
        ? this.headers['x-forwarded-host'].split(',')[0].trim()
        : this.headers.host

      if (_host === undefined) {
        return undefined
      }

      // Keep the port out, and support IPv6 literals ([::1]:8080)
      const _offset = _host[0] === '[' ? _host.indexOf(']') + 1 : 0
      const _index = _host.indexOf(':', _offset)

      return (_index === -1) ? _host : _host.slice(0, _index)
    }
  }
}

const PATH_DESCRIPTOR = {
  configurable: true,
  get: function () {
    const _index = this.url.indexOf('?')

    return (_index === -1) ? this.url : this.url.slice(0, _index)
  }
}

/**
 * Read a request header the way express does
 * @param {String} field Header name
 */
function reqGet (field) {
  return getHeader(this, field)
}

/**
 * Content negotiation helpers, same signatures as express (they are the very
 * same `accepts` package express uses)
 */
function reqAccepts (...args) {
  return accepts(this).types(...args)
}

/**
 * Content negotiation on charsets, like express req.acceptsCharsets()
 */
function reqAcceptsCharsets (...args) {
  return accepts(this).charsets(...args)
}

/**
 * Content negotiation on encodings, like express req.acceptsEncodings()
 */
function reqAcceptsEncodings (...args) {
  return accepts(this).encodings(...args)
}

/**
 * Content negotiation on languages, like express req.acceptsLanguages()
 */
function reqAcceptsLanguages (...args) {
  return accepts(this).languages(...args)
}

/**
 * Check the Content-Type of the request, like express req.is()
 * @param {String|Array} types Types to test
 */
function reqIs (types) {
  const _types = Array.isArray(types) ? types : Array.prototype.slice.call(arguments)

  return typeis(this, _types)
}

/**
 * Add the express request helpers restana does not provide.
 * `params` and `originalUrl` already come from restana.
 * @param {Object} req Request
 */
function decorateRequest (req) {
  if (req.get !== undefined) {
    return
  }

  Object.defineProperties(req, REQUEST_DESCRIPTORS)

  // restana already exposes `path`, only add it when missing
  if (req.path === undefined) {
    Object.defineProperty(req, 'path', PATH_DESCRIPTOR)
  }
}

/**
 * Add the express response helpers. They are module level functions using
 * `this`, so a request assigns references instead of building closures.
 * @param {Object} req Request
 * @param {Object} res Response
 */
function resStatus (code) {
  // express only assigns: an out of range code raises from node itself when
  // the response is written, keep that behaviour identical
  this.statusCode = code
  return this
}

/**
 * Send the status message as plain text
 * @param {Number} code Status code
 */
function resSendStatus (code) {
  const _body = STATUS_CODES[code] || String(code)

  this.statusCode = code
  // express sends the status message as plain text
  this.type('txt')
  return this.send(_body)
}

/**
 * Set one header, or every key of an object
 * @param {String|Object} field Header name, or an object of headers
 * @param {String|Array} value Header value when field is a name
 */
function resSetHeader (name, value) {
  if (alreadyAnswered(this, `set the header ${name}`)) {
    return this
  }

  try {
    return this._nativeSetHeader(name, value)
  } catch (e) {
    // A value holding a newline (from the database, from user input) makes node
    // throw ERR_INVALID_CHAR, usually from a callback where nothing catches it
    require('./logger').log(`Dropped the header ${name}: ${e.message}`, 'error')
    return this
  }
}

/**
 * Set one header, or every key of an object
 * @param {String|Object} field Header name, or an object of headers
 * @param {String|Array} value Header value when field is a name
 */
function resSet (field, value) {
  if (arguments.length === 1) {
    for (const key in field) {
      this.set(key, field[key])
    }

    return this
  }

  let _value = Array.isArray(value) ? value.map(String) : String(value)

  if (field.toLowerCase() === 'content-type') {
    if (Array.isArray(_value)) {
      throw new TypeError('Content-Type cannot be set to an Array')
    }

    if (/;\s*charset\s*=/.test(_value) === false) {
      const _charset = mime.charset(_value)

      if (_charset !== false) {
        _value += '; charset=' + _charset.toLowerCase()
      }
    }
  }

  this.setHeader(field, _value)
  return this
}


/**
 * Read a header already set on the response
 * @param {String} field Header name
 */
function resGet (field) {
  return this.getHeader(field)
}

/**
 * Set the Content-Type from a short name (json, html) or a full type
 * @param {String} value Short name or content type
 */
function resType (value) {
  const _type = (value.indexOf('/') === -1) ? mime.contentType(value) : value

  return this.set('content-type', _type || 'application/octet-stream')
}

/**
 * Answer with JSON
 * @param {Any} body Value to serialize
 */
function resJson (body) {
  let _body = body

  // express 3 signatures, still accepted by express 4
  if (arguments.length === 2) {
    if (typeof arguments[1] === 'number') {
      this.statusCode = arguments[1]
    } else {
      this.statusCode = arguments[0]
      _body = arguments[1]
    }
  }

  let _payload = null

  try {
    _payload = JSON.stringify(_body)
  } catch (e) {
    // A circular structure or a BigInt throws here, and res.json is usually
    // called from a callback where nothing would catch it.
    return failedToSerialize(this, e)
  }

  if (this.getHeader('content-type') === undefined) {
    this.setHeader('content-type', 'application/json; charset=utf-8')
  }

  return sendBody(this, _payload)
}

/**
 * Has the response already been answered? Logs when it has, because a second
 * answer is always a bug in the handler
 * @param {Object} res Response
 * @param {String} what What the caller was trying to do
 */
function alreadyAnswered (res, what) {
  if (res.headersSent !== true) {
    return false
  }

  const _url = (res.req !== undefined) ? `${res.req.method} ${res.req.url}` : 'unknown route'

  require('./logger').log(`Cannot ${what} on ${_url}: the response has already been sent`, 'error')
  return true
}

/**
 * Answer 500 when a body cannot be serialized, instead of throwing and taking
 * the process down with it
 * @param {Object} res Response
 * @param {Error} err Error raised while serializing
 */
function failedToSerialize (res, err) {
  // Required here to keep this module free of hearthjs internals at load time
  require('./logger').log(`Cannot serialize the response body: ${err.toString()}`, 'error')

  if (res.headersSent === true) {
    return res.end()
  }

  res.statusCode = 500
  res.setHeader('content-type', 'application/json; charset=utf-8')
  return res.end('{"error":"Internal Server Error"}')
}

/**
 * Answer with a string, a buffer, a stream or an object
 * @param {Any} body Body to send
 */
function resSend (body) {
  let _chunk = body

  // express 3 signatures, still accepted by express 4
  if (arguments.length === 2) {
    if (typeof arguments[0] !== 'number' && typeof arguments[1] === 'number') {
      this.statusCode = arguments[1]
    } else {
      this.statusCode = arguments[0]
      _chunk = arguments[1]
    }
  }

  // res.send(status) sends the status message as text
  if (typeof _chunk === 'number' && arguments.length === 1) {
    if (this.getHeader('content-type') === undefined) {
      this.type('txt')
    }

    this.statusCode = _chunk
    _chunk = STATUS_CODES[_chunk]
  }

  if (typeof _chunk === 'string') {
    if (this.getHeader('content-type') === undefined) {
      this.type('html')
    }
  } else if (typeof _chunk === 'boolean' || typeof _chunk === 'number' || typeof _chunk === 'object') {
    if (_chunk === null) {
      _chunk = ''
    } else if (Buffer.isBuffer(_chunk)) {
      if (this.getHeader('content-type') === undefined) {
        this.type('bin')
      }
    } else if (typeof _chunk.pipe === 'function') {
      return this._restanaSend( _chunk, this.statusCode)
    } else {
      return this.json(_chunk)
    }
  }

  return sendBody(this, _chunk)
}

/**
 * Set the url-encoded Location header
 * @param {String} url Target url
 */
function resLocation (url) {
  return this.set('location', encodeUrl(String(url)))
}

/**
 * Redirect, defaulting to 302, with the short body express sends
 * @param {Number|String} statusOrUrl Status code, or the url when alone
 * @param {String} maybeUrl Target url when a status was given
 */
function resRedirect (statusOrUrl, maybeUrl) {
  if (alreadyAnswered(this, 'redirect')) {
    return this
  }

  let _status = 302
  let _url = statusOrUrl

  if (arguments.length === 2) {
    if (typeof statusOrUrl === 'number') {
      _status = statusOrUrl
      _url = maybeUrl
    } else {
      _status = maybeUrl
    }
  }

  // The Location header is url-encoded, exactly like express
  this.location(_url)

  const _address = this.getHeader('location')
  const _message = STATUS_CODES[_status] || ''
  let _body = ''

  // express content-negotiates a short body, and sends none when the client
  // accepts neither text nor html
  this.set('vary', 'Accept')

  switch (accepts(this.req).type(['text', 'html'])) {
    case 'text':
      _body = `${_message}. Redirecting to ${_address}`
      this.type('txt')
      break
    case 'html':
      // No anchor tag on purpose: express dropped it to avoid rendering
      // javascript: urls as clickable links
      _body = `<p>${_message}. Redirecting to ${escapeHtml(_address)}</p>`
      this.type('html')
      break
  }

  this.statusCode = _status
  this.set('content-length', Buffer.byteLength(_body))

  if (this.req.method === 'HEAD') {
    return this.end()
  }

  return this.end(_body)
}

/**
 * Set a cookie, taking maxAge in milliseconds like express
 * @param {String} name Cookie name
 * @param {String|Object} value Cookie value
 * @param {Object} options Cookie options
 */
function resCookie (name, value, options = {}) {
  const _options = Object.assign({}, options)

  if (_options.maxAge !== undefined && _options.maxAge !== null) {
    // express takes maxAge in ms, the cookie header wants seconds
    const _maxAge = _options.maxAge - 0

    if (isNaN(_maxAge) === false) {
      _options.expires = new Date(Date.now() + _maxAge)
      _options.maxAge = Math.floor(_maxAge / 1000)
    }
  } else if (_options.maxAge === null) {
    delete _options.maxAge
  }

  if (_options.path === undefined) {
    _options.path = '/'
  }

  const _value = (typeof value === 'object') ? 'j:' + JSON.stringify(value) : String(value)
  const _serialized = cookie.serialize(name, _value, _options)
  const _previous = this.getHeader('set-cookie')

  if (_previous === undefined) {
    this.setHeader('set-cookie', [_serialized])
  } else {
    this.setHeader('set-cookie', [].concat(_previous, _serialized))
  }

  return this
}

/**
 * Expire a cookie
 * @param {String} name Cookie name
 * @param {Object} options Cookie options
 */
function resClearCookie (name, options = {}) {
  return this.cookie(name, '', Object.assign({ expires: new Date(1), path: '/' }, options))
}

/**
 * Stream a file as the response
 * @param {String} filePath Absolute path, or relative to options.root
 * @param {Object} options send() options
 * @param {Function} callback Optional, called on error or when done
 */
function resSendFile (filePath, options = {}, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }

  if (path.isAbsolute(filePath) === false && options.root === undefined) {
    throw new TypeError('path must be absolute or specify root to res.sendFile')
  }

  const _stream = send(this.req, encodeURI(filePath), options)

  _stream.on('error', (err) => {
    if (callback !== undefined) {
      return callback(err)
    }

    this.statusCode = err.status || 500
    this.end()
  })

  if (callback !== undefined) {
    _stream.on('end', callback)
  }

  _stream.pipe(this)
  return this
}


/**
 * Add the express response helpers on top of restana's `res.send`.
 *
 * The helpers above are module level functions using `this`, so a request only
 * assigns already existing references instead of building a new closure per
 * method per request.
 * @param {Object} req Request
 * @param {Object} res Response
 */
function decorateResponse (req, res) {
  if (res.status !== undefined) {
    return
  }

  // restana's own send, kept so its (data, code, headers) form still works
  res._restanaSend = res.send
  res._nativeSetHeader = res.setHeader
  res.setHeader = resSetHeader
  res.locals = res.locals || {}
  res.req = req

  res.status = resStatus
  res.sendStatus = resSendStatus
  res.set = resSet
  res.get = resGet
  res.type = resType
  res.json = resJson
  res.send = resSend
  res.location = resLocation
  res.redirect = resRedirect
  res.cookie = resCookie
  res.clearCookie = resClearCookie
  res.sendFile = resSendFile
  res.header = resSet
}

/**
 * Finish a response like express: utf-8 on text, Content-Length, a weak
 * ETag, a 304 on a conditional request, and no body on 204/304.
 * @param {Object} res Response
 * @param {String|Buffer} chunk Body to send
 */
function sendBody (res, chunk) {
  // Answering twice throws ERR_HTTP_HEADERS_SENT, usually from a callback where
  // nothing catches it. Report it instead of taking the process down.
  if (alreadyAnswered(res, 'send a body')) {
    return res
  }

  let _chunk = chunk
  let _encoding

  if (typeof _chunk === 'string') {
    _encoding = 'utf8'

    const _type = res.getHeader('content-type')

    if (typeof _type === 'string') {
      res._nativeSetHeader('content-type', setCharset(_type, 'utf-8'))
    }
  }

  const _generateETag = res.getHeader('etag') === undefined
  let _length

  if (_chunk !== undefined) {
    if (Buffer.isBuffer(_chunk)) {
      _length = _chunk.length
    } else {
      _chunk = Buffer.from(_chunk, _encoding)
      _encoding = undefined
      _length = _chunk.length
    }

    res._nativeSetHeader('content-length', _length)
  }

  if (_generateETag === true && _length !== undefined) {
    // express default: a weak ETag over the payload
    res._nativeSetHeader('etag', etag(_chunk, { weak: true }))
  }

  // Conditional request: nothing changed, answer 304 without a body
  if (res.req !== undefined && res.req.fresh === true) {
    res.statusCode = 304
  }

  if (res.statusCode === 204 || res.statusCode === 304) {
    res.removeHeader('content-type')
    res.removeHeader('content-length')
    res.removeHeader('transfer-encoding')
    _chunk = ''
  }

  if (res.req !== undefined && res.req.method === 'HEAD') {
    return res.end()
  }

  return res.end(_chunk)
}

/**
 * Replace (or add) the charset of a content-type header
 * @param {String} type Content type
 * @param {String} charset Charset to force
 */
function setCharset (type, charset) {
  const _withoutCharset = type.replace(/;\s*charset\s*=\s*[^;]*/i, '')

  return `${_withoutCharset}; charset=${charset}`
}

/**
 * Middleware adding the express request/response API on every request
 */
/**
 * Decode the route params, like express did. A value holding no percent escape
 * is left alone, which is the common case and costs a single scan.
 * @param {Object} req Request
 * @returns {Boolean} False when a param holds a malformed escape
 */
function decodeParams (req) {
  const _params = req.params

  if (_params === null || _params === undefined) {
    return true
  }

  for (const _key in _params) {
    const _value = _params[_key]

    // decodeURIComponent never changes a value without a percent escape, and
    // leaves '+' alone, which is what express relied on
    if (typeof _value !== 'string' || _value.indexOf('%') === -1) {
      continue
    }

    try {
      _params[_key] = decodeURIComponent(_value)
    } catch (e) {
      return false
    }
  }

  return true
}

module.exports = function expressCompat () {
  return (req, res, next) => {
    // express cross-links them, and the compatibility layer relies on it
    req.res = res
    res.req = req
    decorateRequest(req)
    decorateResponse(req, res)

    // A string reaches the client as is, and is not logged as a server error:
    // a malformed url is the caller's mistake and must not flood the logs
    if (decodeParams(req) === false) {
      return next('Malformed URL parameter')
    }
    return next()
  }
}

module.exports.decorateRequest = decorateRequest
module.exports.decorateResponse = decorateResponse
module.exports.setTrustProxy = setTrustProxy
module.exports.decodeParams = decodeParams
