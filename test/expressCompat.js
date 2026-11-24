const assert = require('assert')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const express = require('express')
const restana = require('restana')
const rock = require('rock-req')
const expressCompat = require('../lib/expressCompat')

/**
 * Differential tests: every case runs the same handler on express and on
 * restana + expressCompat, and asserts both answered identically.
 */

const EXPRESS_PORT = 9871
const RESTANA_PORT = 9872
const fixtureDir = path.join(os.tmpdir(), 'hearthjs-compat-test')
const fixtureFile = path.join(fixtureDir, 'hello.txt')

// Every case is `[name, method, url, handler, requestHeaders]`
const cases = [
  ['status + send', 'get', '/status-send', (req, res) => res.status(201).send('created')],
  ['status + json', 'get', '/status-json', (req, res) => res.status(422).json({ ok: false, n: 1 })],
  ['send string', 'get', '/send-string', (req, res) => res.send('plain text')],
  ['send object', 'get', '/send-object', (req, res) => res.send({ a: 1, b: [2, 3] })],
  ['send buffer', 'get', '/send-buffer', (req, res) => res.send(Buffer.from('buffered'))],
  ['send empty', 'get', '/send-empty', (req, res) => res.send()],
  // express 5 dropped res.send(status): a number is now serialized as a body
  ['send number', 'get', '/send-number', (req, res) => res.send(404)],
  ['json only', 'get', '/json-only', (req, res) => res.json({ hello: 'world' })],
  ['redirect default', 'get', '/redirect', (req, res) => res.redirect('/target')],
  ['redirect with status', 'get', '/redirect-301', (req, res) => res.redirect(301, '/permanent')],
  ['redirect html', 'get', '/redirect-html', (req, res) => res.redirect('/target?a=<b>'), { accept: 'text/html' }],
  // express 5.3 stopped sending content-length beside it, which no client parses
  ['send chunked', 'get', '/send-chunked', (req, res) => res.set('transfer-encoding', 'chunked').send('chunked')],
  ['set header', 'get', '/set-header', (req, res) => res.set('x-custom', 'value').send('ok')],
  ['set headers object', 'get', '/set-headers', (req, res) => res.set({ 'x-a': '1', 'x-b': '2' }).send('ok')],
  ['header alias', 'get', '/header-alias', (req, res) => res.header('x-alias', 'yes').send('ok')],
  ['type', 'get', '/type', (req, res) => res.type('json').send('{"raw":true}')],
  ['cookie', 'get', '/cookie', (req, res) => res.cookie('sid', 'abc123', { httpOnly: true, path: '/' }).send('ok')],
  ['clear cookie', 'get', '/clear-cookie', (req, res) => res.clearCookie('sid').send('ok')],
  ['sendStatus', 'get', '/send-status', (req, res) => res.sendStatus(403)],
  ['route params', 'get', '/users/:id/posts/:postId', (req, res) => res.json({ p: req.params })],
  ['query string', 'get', '/query', (req, res) => res.json({ q: req.query })],
  ['req.path', 'get', '/req-path', (req, res) => res.json({ path: req.path })],
  ['req.protocol', 'get', '/req-protocol', (req, res) => res.json({ protocol: req.protocol })],
  ['req.get header', 'get', '/req-get', (req, res) => res.json({ ua: req.get('x-probe') })],
  ['req.method + url', 'get', '/req-basic', (req, res) => res.json({ m: req.method, u: req.url })],
  ['post body echo', 'post', '/echo', (req, res) => res.json({ body: req.body })],
  // Only what express answers the same way: the extras are tested apart
  ['req.is', 'post', '/req-is', (req, res) => res.json([
    req.is(), req.is('json'), req.is('application/json'), req.is('application/*'), req.is('*/*'), req.is('+json'),
    req.is('html'), req.is(['html', 'json']), req.is('html', 'json'), req.is('urlencoded'), req.is('nope'), req.is('text/*')
  ])],
  ['req.is without body', 'get', '/req-is-get', (req, res) => res.json([req.is('json'), req.is()])],
  ['status then end', 'get', '/status-end', (req, res) => { res.status(204); res.end() }],
  ['sendFile', 'get', '/send-file', (req, res) => res.sendFile(fixtureFile)],
  // express decoded the captured param but left the url and the path raw, so
  // routing still matches on %2F rather than on a real slash
  ['encoded param', 'get', '/enc/:enc', (req, res) => res.json({
    id: req.params.enc, url: req.url, path: req.path
  })]
]

/**
 * Register every case on an app exposing the express-like routing API
 * @param {Object} app express app or restana service
 */
function registerRoutes (app) {
  for (let i = 0; i < cases.length; i++) {
    const [, method, url, handler] = cases[i]

    app[method](url, handler)
  }
}

/**
 * Perform the request matching a case and return what the server answered
 * @param {Number} port Server port
 * @param {Array} testCase One entry of `cases`
 * @param {Function} callback
 */
function call (port, testCase, callback) {
  const [, method, url, , requestHeaders] = testCase
  // Fill route params and add a query string so both servers get the same input
  const realUrl = url
    .replace(':postId', '77')
    .replace(':id', '42')
    .replace(':enc', 'https%3A%2F%2Fexample.com%2Fa%20b') +
    // nested and repeated keys: the parity that the `extended` parser buys
    '?a=1&b=two&c[d]=3&e[]=4&e[]=5'

  const options = {
    url: `http://localhost:${port}${realUrl}`,
    headers: { 'x-probe': 'probe-value', ...requestHeaders },
    maxRetry: 1,
    // Compare what the server actually sent, do not follow redirects
    followRedirects: false
  }

  const done = (err, res, body) => {
    if (err) {
      return callback(err)
    }

    return callback(null, {
      statusCode: res.statusCode,
      contentType: res.headers['content-type'],
      location: res.headers.location,
      setCookie: res.headers['set-cookie'],
      custom: {
        'x-custom': res.headers['x-custom'],
        'x-a': res.headers['x-a'],
        'x-b': res.headers['x-b'],
        'x-alias': res.headers['x-alias']
      },
      body: body.toString()
    })
  }

  if (method === 'post') {
    return rock.postJSON(options, { hello: 'body' }, done)
  }

  return rock.get(options, done)
}

describe('Express compatibility (restana vs express)', function () {
  this.timeout(30000)

  let expressServer = null
  let restanaServer = null

  before((done) => {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.mkdirSync(fixtureDir, { recursive: true })
    fs.writeFileSync(fixtureFile, 'file content\n')

    const expressApp = express()

    // express 5 defaults to `simple`, which drops nesting. The compatibility
    // layer keeps the express 4 default, so the oracle has to state it.
    expressApp.set('query parser', 'extended')

    expressApp.use(express.json())
    registerRoutes(expressApp)
    expressServer = expressApp.listen(EXPRESS_PORT, () => {
      const service = restana({ securityHeaders: false, prioRequestsProcessing: false })

      service.use(expressCompat())
      service.use(express.json())
      registerRoutes(service)
      service.get('/circular', (req, res) => {
        const _circular = { name: 'x' }

        _circular.self = _circular
        setImmediate(() => res.status(200).json(_circular))
      })
      service.get('/bigint', (req, res) => setImmediate(() => res.json({ n: BigInt(10) })))
      restanaServer = http.createServer(service)
      restanaServer.listen(RESTANA_PORT, done)
    })
  })

  after((done) => {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    expressServer.close(() => restanaServer.close(done))
  })

  describe('unserializable bodies', () => {
    // res.json is normally called from a database callback, where a throw is
    // caught by nobody and takes the whole process down.
    it('should answer 500 instead of throwing on a circular structure', (done) => {
      rock.get({ url: `http://localhost:${RESTANA_PORT}/circular`, maxRetry: 1 }, (err, res, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.statusCode, 500)
        assert.strictEqual(body.toString(), '{"error":"Internal Server Error"}')
        done()
      })
    })

    it('should answer 500 instead of throwing on a BigInt', (done) => {
      rock.get({ url: `http://localhost:${RESTANA_PORT}/bigint`, maxRetry: 1 }, (err, res, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.statusCode, 500)
        done()
      })
    })

    it('should keep serving after a failed serialization', (done) => {
      rock.get({ url: `http://localhost:${RESTANA_PORT}/json-only`, maxRetry: 1 }, (err, res, body) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.statusCode, 200)
        assert.strictEqual(body.toString(), '{"hello":"world"}')
        done()
      })
    })
  })

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i]

    it(`should behave like express: ${testCase[0]}`, (done) => {
      call(EXPRESS_PORT, testCase, (err, expressResult) => {
        assert.strictEqual(err, null)

        call(RESTANA_PORT, testCase, (err, restanaResult) => {
          assert.strictEqual(err, null)

          assert.strictEqual(restanaResult.statusCode, expressResult.statusCode,
            `status differs for ${testCase[0]}`)
          assert.strictEqual(restanaResult.body, expressResult.body,
            `body differs for ${testCase[0]}`)
          assert.strictEqual(restanaResult.location, expressResult.location,
            `location differs for ${testCase[0]}`)
          assert.deepStrictEqual(restanaResult.custom, expressResult.custom,
            `custom headers differ for ${testCase[0]}`)
          assert.deepStrictEqual(restanaResult.setCookie, expressResult.setCookie,
            `set-cookie differs for ${testCase[0]}`)
          assert.strictEqual(restanaResult.contentType, expressResult.contentType,
            `content-type differs for ${testCase[0]}`)
          done()
        })
      })
    })
  }
})

describe('req.is()', function () {
  /**
   * A request decorated like hearthjs does, with a body
   * @param {String} contentType Content-Type header, none when undefined
   * @param {Object} headers Other headers
   * @return {Object} request
   */
  function request (contentType, headers = { 'content-length': '2' }) {
    const req = { headers: { ...headers } }

    if (contentType !== undefined) {
      req.headers['content-type'] = contentType
    }

    expressCompat.decorateRequest(req)
    return req
  }

  it('should return null without a body, whatever the Content-Type', () => {
    assert.strictEqual(request('application/json', {}).is('json'), null)
    assert.strictEqual(request('application/json', { 'content-length': 'abc' }).is('json'), null)
    assert.strictEqual(request('application/json', { 'transfer-encoding': 'chunked' }).is('json'), 'json')
    assert.strictEqual(request('application/json', { 'content-length': '0' }).is('json'), 'json')
  })

  it('should return false without a Content-Type or with an invalid one', () => {
    for (const _contentType of [undefined, '', 'invalid', 'text/', '/html', 'text/html/x', 'te xt/html', 'text/htmlé']) {
      assert.strictEqual(request(_contentType).is('*/*'), false, String(_contentType))
      assert.strictEqual(request(_contentType).is(), false, String(_contentType))
    }
  })

  it('should return the request media type without argument, lowercase and without parameters', () => {
    assert.strictEqual(request(' TEXT/HTML ; Charset=UTF-8').is(), 'text/html')
    assert.strictEqual(request('application/vnd.api+json').is([]), 'application/vnd.api+json')
  })

  it('should resolve any extension of the mime database', () => {
    const _cases = [
      ['application/json', 'json'], ['text/html', 'html'], ['text/html', 'htm'], ['image/png', 'png'], ['image/svg+xml', 'svg'],
      ['application/pdf', 'pdf'], ['text/csv', 'csv'], ['application/xml', 'xml'], ['video/mp4', 'mp4'], ['font/woff2', 'woff2'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'], ['application/wasm', 'wasm'],
      ['application/octet-stream', 'bin'], ['text/markdown', 'md'], ['application/zip', 'zip'], ['text/javascript', 'js']
    ]

    for (const [_contentType, _extension] of _cases) {
      assert.strictEqual(request(_contentType).is(_extension), _extension, _extension)
      assert.strictEqual(request(_contentType).is(`.${_extension}`), `.${_extension}`, _extension)
      assert.strictEqual(request(_contentType).is(`file.${_extension}`), `file.${_extension}`, _extension)
    }
  })

  it('should resolve the urlencoded and multipart shorthands', () => {
    assert.strictEqual(request('application/x-www-form-urlencoded; charset=utf-8').is('urlencoded'), 'urlencoded')
    assert.strictEqual(request('multipart/form-data; boundary=x').is('multipart'), 'multipart')
    assert.strictEqual(request('multipart/mixed').is('multipart'), 'multipart')
    assert.strictEqual(request('application/json').is('multipart', 'urlencoded'), false)
  })

  it('should return the type as given for an exact match, the request one for a wildcard', () => {
    const req = request('application/vnd.api+json; charset=utf-8')

    assert.strictEqual(req.is('application/vnd.api+json'), 'application/vnd.api+json')
    assert.strictEqual(req.is('*/*'), 'application/vnd.api+json')
    assert.strictEqual(req.is('application/*'), 'application/vnd.api+json')
    assert.strictEqual(req.is('*/vnd.api+json'), 'application/vnd.api+json')
    assert.strictEqual(req.is('+json'), 'application/vnd.api+json')
    assert.strictEqual(req.is('*/*+json'), 'application/vnd.api+json')
    assert.strictEqual(req.is('application/*+json'), 'application/vnd.api+json')
    assert.strictEqual(req.is('text/*'), false)
    assert.strictEqual(req.is('*/json'), false)
    assert.strictEqual(req.is('+xml'), false)
    assert.strictEqual(req.is('text/*+json'), false)
  })

  it('should not take a bare suffix for a type of it', () => {
    assert.strictEqual(request('application/+json').is('+json'), false)
    assert.strictEqual(request('application/+json').is('application/*+json'), false)
    assert.strictEqual(request('application/a+json').is('+json'), 'application/a+json')
  })

  it('should match the type arguments in any case', () => {
    assert.strictEqual(request('application/json').is('JSON'), 'JSON')
    assert.strictEqual(request('application/json').is('Application/JSON'), 'Application/JSON')
    assert.strictEqual(request('Application/JSON').is('application/json'), 'application/json')
  })

  it('should match the parameters of a type argument, the charset in any case', () => {
    assert.strictEqual(request('text/html; charset=UTF-8').is('text/html; charset=utf-8'), 'text/html; charset=utf-8')
    assert.strictEqual(request('text/html;CHARSET="utf-8"').is('html; charset=utf-8'), 'html; charset=utf-8')
    assert.strictEqual(request('text/html').is('text/html; charset=utf-8'), false)
    assert.strictEqual(request('text/html; charset=latin1').is('text/html; charset=utf-8'), false)
    assert.strictEqual(request('text/plain; format=Flowed').is('text/plain; format=flowed'), false)
    assert.strictEqual(request('text/plain; format=flowed; charset=utf-8').is('text/*; format=flowed'), 'text/plain')
  })

  it('should parse quoted parameters and keep the first of a repeated one', () => {
    assert.strictEqual(request('application/ld+json; profile="a;b"').is('application/ld+json; profile="a;b"'), 'application/ld+json; profile="a;b"')
    assert.strictEqual(request('text/plain; a="x\\"y"').is('text/plain; a="x\\"y"'), 'text/plain; a="x\\"y"')
    assert.strictEqual(request('text/plain; a=1; a=2').is('text/plain; a=1'), 'text/plain; a=1')
    assert.strictEqual(request('text/plain; a=1; a=2').is('text/plain; a=2'), false)
  })

  it('should take the types as an array or as arguments, and return the first match', () => {
    assert.strictEqual(request('image/png').is(['json', 'png', 'image/*']), 'png')
    assert.strictEqual(request('image/png').is('json', 'image/*', 'png'), 'image/png')
  })

  it('should match an extension against every media type it has', () => {
    const _cases = [
      ['application/javascript', 'js'], ['text/javascript', 'js'], ['text/xml', 'xml'], ['application/xml', 'xml'],
      ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'], ['application/zip', 'zip'], ['application/x-zip-compressed', 'zip'],
      ['video/mp4', 'mp4'], ['application/mp4', 'mp4'], ['text/rtf', 'rtf'], ['application/rtf', 'rtf'], ['image/x-icon', 'ico'], ['audio/mp3', 'mp3']
    ]

    for (const [_contentType, _extension] of _cases) {
      assert.strictEqual(request(_contentType).is(_extension), _extension, `${_contentType} ${_extension}`)
    }

    assert.strictEqual(request('text/xml').is('js'), false)
  })

  it('should not take any binary body for an extension that has a real type', () => {
    for (const _extension of ['iso', 'exe', 'dmg', 'msi', 'deb', 'dll']) {
      assert.strictEqual(request('application/octet-stream').is(_extension), false, _extension)
    }

    assert.strictEqual(request('application/octet-stream').is('bin'), 'bin')
  })

  it('should cut only spaces and tabs around the type, like body-parser', () => {
    assert.strictEqual(request(' \tapplication/json\t ; charset=utf-8').is('json'), 'json')
    assert.strictEqual(request('application/json\u00a0').is('json'), false)
    assert.strictEqual(request('\u00a0application/json').is('json'), false)
    assert.strictEqual(request('text/plain; a=b\u00a0').is('text/plain; a=b'), false)
    assert.strictEqual(request('text/plain; a=b \t').is('text/plain; a=b'), 'text/plain; a=b')
  })

  it('should not unquote a value whose quote is not closed', () => {
    assert.strictEqual(request('text/plain; charset=utf-').is('text/plain; charset="utf-8'), false)
    assert.strictEqual(request('text/plain; charset="utf-8').is('text/plain; charset=utf-'), false)
    assert.strictEqual(request('text/plain; charset="utf-8').is('text/plain; charset="utf-8'), 'text/plain; charset="utf-8')
  })

  it('should stay linear on hostile headers', () => {
    const _headers = [
      'a' + ' '.repeat(1 << 20) + 'b/c', 'text/html' + ' '.repeat(1 << 20), 'text/html;a="' + '\\'.repeat(1 << 20),
      'text/html' + ';'.repeat(1 << 20), 'text/html;a=x' + ' '.repeat(1 << 20) + 'y', 'text/html' + ';a="\\"'.repeat(1 << 17)
    ]

    for (const _header of _headers) {
      const _start = Date.now()

      request(_header).is('text/html; charset=utf-8')
      assert.ok(Date.now() - _start < 200, `${Date.now() - _start} ms`)
    }
  })

  it('should keep answering right when more distinct types than its cache holds were asked', () => {
    const req = request('application/json')

    for (let i = 0; i < 2500; i++) {
      assert.strictEqual(req.is(`application/x-${i}`), false)
    }

    assert.strictEqual(req.is('json'), 'json')
    assert.strictEqual(req.is('application/json'), 'application/json')
  })

  it('should skip an unknown or invalid type argument rather than throw', () => {
    const req = request('application/json')

    for (const _type of ['nope', '', '/', 'a/b/c', 'te xt/html', 42, null, undefined, {}, [42]]) {
      assert.strictEqual(req.is(_type), false, String(_type))
    }

    assert.strictEqual(req.is('nope', 42, 'json'), 'json')
  })
})
