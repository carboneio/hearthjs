const assert = require('assert')
const http = require('http')
const cookies = require('../lib/cookies')
const expressCompat = require('../lib/expressCompat')

/**
 * Run the middleware on a request carrying this Cookie header
 * @param {String} [header] Cookie header, none when undefined
 * @param {Object} [preset] req.cookies set before the middleware
 * @returns {Object} The request, after next() was called
 */
function parse (header, preset) {
  const _req = { headers: (header === undefined) ? {} : { cookie: header } }
  let _nextCalled = false

  if (preset !== undefined) {
    _req.cookies = preset
  }

  cookies(_req, {}, () => {
    _nextCalled = true
  })
  assert.strictEqual(_nextCalled, true)
  return _req
}

/**
 * Set cookies with res.cookie and send them back as a browser would
 * @param {Function} write Receives the response, calls res.cookie
 * @returns {Object} req.cookies parsed from the cookies written
 */
function roundTrip (write) {
  const _req = new http.IncomingMessage(null)
  const _res = new http.ServerResponse(_req)

  expressCompat.decorateResponse(_req, _res)
  write(_res)

  const _header = _res.getHeader('set-cookie').map((setCookie) => setCookie.split(';')[0]).join('; ')

  return parse(_header).cookies
}

describe('cookies', function () {
  describe('round trip with res.cookie', function () {
    it('should read back a string, a number, an object and an array', function () {
      const _cookies = roundTrip((res) => {
        res.cookie('text', 'hello world; é=%')
        res.cookie('number', 42)
        res.cookie('object', { a: 1, b: { c: 'd' } })
        res.cookie('array', [1, 'two', null])
      })

      assert.deepStrictEqual(_cookies, {
        text: 'hello world; é=%',
        number: '42',
        object: { a: 1, b: { c: 'd' } },
        array: [1, 'two', null]
      })
    })

    it('should read back null as the raw j:null string', function () {
      assert.deepStrictEqual(roundTrip((res) => res.cookie('nothing', null)), { nothing: 'j:null' })
    })
  })

  describe('values', function () {
    it('should keep the raw value on a malformed % escape, never throw', function () {
      assert.deepStrictEqual(parse('a=%E0%A4%A; b=%; c=%zz; d=%C3%A9').cookies, { a: '%E0%A4%A', b: '%', c: '%zz', d: 'é' })
    })

    it('should decode j: JSON only when it parses to a truthy value', function () {
      const _cookies = parse('a=j:{"x":1}; b=j:[]; c=j:1; d=j:"x"; e=j:true; f=j:null; g=j:0; h=j:false; i=j:""; j=j:{bad; k=j:').cookies

      assert.deepStrictEqual(_cookies, {
        a: { x: 1 },
        b: [],
        c: 1,
        d: 'x',
        e: true,
        f: 'j:null',
        g: 'j:0',
        h: 'j:false',
        i: 'j:""',
        j: 'j:{bad',
        k: 'j:'
      })
    })

    it('should decode j: JSON after percent-decoding', function () {
      assert.deepStrictEqual(parse('a=j%3A%7B%22x%22%3A1%7D').cookies, { a: { x: 1 } })
    })

    it('should strip surrounding double quotes and spaces around names and values', function () {
      assert.deepStrictEqual(parse(' a = "b c" ;\tq="; e=""; f= " g " ').cookies, { a: 'b c', q: '', e: '', f: ' g ' })
    })

    it('should keep the first occurrence of a duplicate name', function () {
      assert.deepStrictEqual(parse('a=1; b=2; a=3; a=j:{"x":1}').cookies, { a: '1', b: '2' })
    })

    it('should skip a pair without "=" and keep empty names and values', function () {
      assert.deepStrictEqual(parse('a; b=c; =d; e=').cookies, { b: 'c', '': 'd', e: '' })
    })
  })

  describe('request shape', function () {
    it('should set the same properties as cookie-parser without secret', function () {
      const _req = parse('a=b; s=s:value.signature')

      assert.deepStrictEqual(Object.keys(_req), ['headers', 'secret', 'cookies', 'signedCookies'])
      assert.strictEqual(_req.secret, undefined)
      // without a secret, signed cookies are never unsigned: they stay raw in req.cookies
      assert.deepStrictEqual(_req.signedCookies, Object.create(null))
      assert.deepStrictEqual(_req.cookies, { a: 'b', s: 's:value.signature' })
      assert.strictEqual(Object.getPrototypeOf(_req.cookies), Object.prototype)
    })

    it('should set null-prototype empty objects without a Cookie header, or with an empty one', function () {
      for (const _header of [undefined, '']) {
        const _req = parse(_header)

        assert.deepStrictEqual(_req.cookies, Object.create(null))
        assert.deepStrictEqual(_req.signedCookies, Object.create(null))
        assert.strictEqual('secret' in _req, true)
      }
    })

    it('should set a plain empty object for a header with no cookie', function () {
      assert.deepStrictEqual(parse('a').cookies, {})
      assert.deepStrictEqual(parse('abc; def').cookies, {})
    })

    it('should leave a pre-set req.cookies untouched, and set nothing else', function () {
      const _preset = { mine: 'yes' }
      const _req = parse('a=b', _preset)

      assert.strictEqual(_req.cookies, _preset)
      assert.deepStrictEqual(_req.cookies, { mine: 'yes' })
      assert.deepStrictEqual(Object.keys(_req), ['headers', 'cookies'])
    })

    it('should parse when the pre-set req.cookies is falsy', function () {
      assert.deepStrictEqual(parse('a=b', null).cookies, { a: 'b' })
    })

    it('should throw the cookie-parser TypeError on a non string header', function () {
      assert.throws(() => cookies({ headers: { cookie: ['a=b'] } }, {}, () => {}), { name: 'TypeError', message: 'argument str must be a string' })
    })
  })

  describe('prototype safety', function () {
    it('should drop a __proto__ cookie and never touch any prototype', function () {
      const _cookies = parse('__proto__=j:{"polluted":1}; a=b; __proto__=x').cookies

      assert.deepStrictEqual(_cookies, { a: 'b' })
      assert.strictEqual(Object.getPrototypeOf(_cookies), Object.prototype)
      assert.strictEqual(Object.hasOwn(_cookies, '__proto__'), false)
      assert.strictEqual(_cookies.polluted, undefined)
      assert.strictEqual({}.polluted, undefined)
    })

    it('should keep constructor and other Object.prototype names as own cookies', function () {
      const _cookies = parse('constructor=x; toString=j:{"a":1}; hasOwnProperty=1').cookies

      assert.deepStrictEqual(_cookies, { constructor: 'x', toString: { a: 1 }, hasOwnProperty: '1' })
      assert.strictEqual(Object.prototype.toString.call(_cookies), '[object Object]')
    })

    it('should not pollute through a JSON cookie carrying __proto__', function () {
      const _cookies = parse('a=j:{"__proto__":{"polluted":1}}').cookies

      assert.strictEqual({}.polluted, undefined)
      assert.strictEqual(Object.hasOwn(_cookies.a, '__proto__'), true)
    })
  })
})
