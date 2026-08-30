const database = require('./database')
const helper = require('./helper')

const datasets = {
  _isDatabaseInitialized: false,
  // Datasets inserted by every resetHook(), before the per-test extra sets
  _defaultSeed: [],

  /**
   * Insert a set of data in database
   * @param {Array} datasetsName Datasets name to insert in database
   * @param {Function} callback
   */
  insert: function (datasetsName, callback) {
    // Check if database has been initialized
    if (this._isDatabaseInitialized === false) {
      return helper.loadConfForDatabase('test', (err, databaseConf) => {
        if (err) {
          return callback(err)
        }

        // Initialize the database for datasets
        database.init(databaseConf, (err) => {
          if (err) {
            return callback(err)
          }

          this._isDatabaseInitialized = true
          this._insertDatasets(datasetsName, 0, callback)
        })
      })
    }
    this._insertDatasets(datasetsName, 0, callback)
  },

  /**
   * Insert a list of datasets
   * @param {Array} datasetsName List of datasets to insert
   * @param {Integer} index Inder of datasetsName
   * @param {Function} callback
   */
  _insertDatasets: function (datasetsName, index, callback) {
    if (datasetsName[index] === undefined) {
      return callback(null)
    }

    // Insert dataset
    database.exec(datasetsName[index], (err) => {
      if (err) {
        return callback(err)
      }

      this._insertDatasets(datasetsName, index + 1, callback)
    })
  },

  /**
   * The seed every resetHook() inserts before its per-test extra sets. Set it
   * once so each test file stops repeating the same base list.
   * @param {Array} datasetsName Datasets inserted on every reset
   */
  setDefaultSeed: function (datasetsName) {
    this._defaultSeed = Array.isArray(datasetsName) ? datasetsName : []
  },

  /**
   * Build a beforeEach function that cleans the database then inserts the
   * default seed plus any extra sets. hearthjs never touches the test runner's
   * globals itself: the project wires the returned function into its own hook,
   * e.g. `beforeEach(hearthjs.datasets.resetHook(['analytics']))`.
   * @param {Array} extraSeed Datasets to insert after the default seed
   * @return {Function} A `(done) => {}` hook
   */
  resetHook: function (extraSeed) {
    const _self = this

    return function (done) {
      _self.clean((err) => {
        if (err) {
          return done(err)
        }

        const _seed = _self._defaultSeed.concat(Array.isArray(extraSeed) ? extraSeed : [])

        if (_seed.length === 0) {
          return done()
        }

        return _self.insert(_seed, done)
      })
    }
  },

  /**
   * Clean all tables
   * @param {Function} callback
   */
  clean: function (callback) {
    this._clean(callback, 0)
  },

  /**
   * Truncate every table, retrying a deadlock.
   * A fire-and-forget write from the previous test can straddle this TRUNCATE;
   * Postgres then picks a deadlock victim (40P01). The write is gone once
   * rolled back, so the clean is simply retried, a bounded number of times.
   * @param {Function} callback
   * @param {Integer} attempt Retry counter
   */
  _clean: function (callback, attempt) {
    database.exec('getTableList', (err, res, rows) => {
      if (err) {
        return callback(err)
      }

      if (rows.length === 0) {
        return callback(null)
      }

      // Construct query to truncate all tables
      let _queryToExecute = 'TRUNCATE TABLE '
      // Double the quotes: an identifier holding one would otherwise close it
      _queryToExecute += rows.map(elem => `"${String(elem.table_name).split('"').join('""')}"`).join(', ')
      _queryToExecute += ' CASCADE;'

      // Clean table
      database.query(_queryToExecute, (err, result, resultRows) => {
        if (err && err.code === '40P01' && attempt < 2) {
          return this._clean(callback, attempt + 1)
        }

        return callback(err, result, resultRows)
      })
    })
  }
}

module.exports = datasets
