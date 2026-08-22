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

// Every case is `[name, method, url, handler]`
const cases = [
  ['status + send', 'get', '/status-send', (req, res) => res.status(201).send('created')],
  ['status + json', 'get', '/status-json', (req, res) => res.status(422).json({ ok: false, n: 1 })],
  ['send string', 'get', '/send-string', (req, res) => res.send('plain text')],
  ['send object', 'get', '/send-object', (req, res) => res.send({ a: 1, b: [2, 3] })],
  ['send buffer', 'get', '/send-buffer', (req, res) => res.send(Buffer.from('buffered'))],
  ['send empty', 'get', '/send-empty', (req, res) => res.send()],
  ['json only', 'get', '/json-only', (req, res) => res.json({ hello: 'world' })],
  ['redirect default', 'get', '/redirect', (req, res) => res.redirect('/target')],
  ['redirect with status', 'get', '/redirect-301', (req, res) => res.redirect(301, '/permanent')],
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
  const [, method, url] = testCase
  // Fill route params and add a query string so both servers get the same input
  const realUrl = url
    .replace(':postId', '77')
    .replace(':id', '42')
    .replace(':enc', 'https%3A%2F%2Fexample.com%2Fa%20b') + '?a=1&b=two'

  const options = {
    url: `http://localhost:${port}${realUrl}`,
    headers: { 'x-probe': 'probe-value' },
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
