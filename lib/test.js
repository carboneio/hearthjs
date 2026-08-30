const database = require('./database')

/**
 * Race-safe waiting helpers for tests. A fixed setTimeout is both slow (it
 * always pays the full delay) and unreliable (it still races on a loaded
 * machine). Polling a condition returns as soon as the work is done, and
 * behaves the same whether an external call is mocked or real.
 */
const test = {
  /**
   * Call back as soon as isReady() returns true, or with an error once the
   * deadline passed.
   * @param {Function} isReady Returns true when the test can go on
   * @param {Function} callback Called once, with an Error on timeout
   * @param {Object} options { timeout = 5000 ms, interval = 5 ms }
   */
  waitUntil: function (isReady, callback, options) {
    const _timeout = options?.timeout ?? 5000
    const _interval = options?.interval ?? 5
    const _deadline = Date.now() + _timeout

    ;(function poll () {
      let _ready = false

      try {
        _ready = isReady() === true
      } catch (err) {
        return callback(err)
      }

      if (_ready === true) {
        return callback(null)
      }

      if (Date.now() > _deadline) {
        return callback(new Error(`waitUntil: condition still false after ${_timeout}ms`))
      }

      return setTimeout(poll, _interval)
    })()
  },

  /**
   * Poll a query until isReady(rows) is true. The API often answers before its
   * fire-and-forget writes land, so the test waits for the row rather than for
   * a fixed duration.
   * @param {String} sql Query to run
   * @param {Array} params Query parameters
   * @param {Function} isReady Receives the rows, returns true when ready
   * @param {Function} callback Called with (err, rows)
   * @param {Object} options { timeout = 5000 ms, interval = 5 ms }
   */
  waitForRow: function (sql, params, isReady, callback, options) {
    const _timeout = options?.timeout ?? 5000
    const _interval = options?.interval ?? 5
    const _deadline = Date.now() + _timeout

    ;(function poll () {
      database.query(sql, params, (err, result, rows) => {
        if (err) {
          return callback(err)
        }

        let _ready = false

        try {
          _ready = isReady(rows) === true
        } catch (e) {
          return callback(e)
        }

        if (_ready === true) {
          return callback(null, rows)
        }

        if (Date.now() > _deadline) {
          return callback(new Error(`waitForRow: no matching row after ${_timeout}ms | ${sql}`))
        }

        return setTimeout(poll, _interval)
      })
    })()
  }
}

module.exports = test
