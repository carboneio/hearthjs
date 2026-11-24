const helper = require('../lib/helper')
const assert = require('assert')

describe('Helper', () => {
  describe('uid', () => {
    it('should return 15 characters of the URL-safe alphabet', () => {
      for (let i = 0; i < 1000; i++) {
        assert.match(helper.uid(), /^[A-Za-z0-9_-]{15}$/)
      }
    })

    it('should never repeat itself, across many pool refills', () => {
      const _ids = new Set()

      for (let i = 0; i < 100000; i++) {
        _ids.add(helper.uid())
      }

      assert.strictEqual(_ids.size, 100000)
    })

    it('should use the 64 characters evenly', () => {
      const _counts = new Map()
      const _total = 20000 * 15

      for (let i = 0; i < 20000; i++) {
        for (const _char of helper.uid()) {
          _counts.set(_char, (_counts.get(_char) ?? 0) + 1)
        }
      }

      assert.strictEqual(_counts.size, 64)

      // Each character is expected 4687 times: 20% off would be a broken mapping
      for (const [_char, _count] of _counts) {
        assert.ok(Math.abs(_count - _total / 64) < _total / 64 * 0.2, `${_char}: ${_count}`)
      }
    })
  })

  describe('Generic queue', () => {
    it('should concatenate a list of item', (done) => {
      let result = ''
      let items = ['Coucou', ' ', 'ca', ' ', 'va', ' ', '?']

      let queue = helper.genericQueue(items, (item, next) => {
        result += item
        return next()
      }, (err) => {
        assert.strictEqual(err, null)
      }, () => {
        assert.strictEqual(result, 'Coucou ca va ?')
        done()
      })

      assert.strictEqual(result, '')

      queue.start()
    })

    it('should return an error and never call callback', (done) => {
      let result = ''
      let items = ['Coucou', ' ', 'ca', ' ', 'va', ' ', '?']

      helper.genericQueue(items, (item, next) => {
        result += item
        return next(new Error('Nope'))
      }, (err) => {
        assert.notStrictEqual(err, null)
        assert.strictEqual(result, 'Coucou')
        done()
      }, () => {
        assert.strictEqual(1, 2)
      }).start()
    })

    it('should do nothing with an empty list', (done) => {
      let result = ''
      let items = ['']

      helper.genericQueue(items, (item, next) => {
        result += item
        return next()
      }, (err) => {
        assert.strictEqual(err, null)
      }, () => {
        assert.strictEqual(result, '')
        done()
      }).start()
    })
  })
})
