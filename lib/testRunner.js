const server = require('./server')
const path = require('path')
const fs = require('fs')
const watch = require('./watch')

const testFileRegex = /^test\.\S+\.js$/

const test = {
  _testFiles: [],
  _nbCallStart: 0,
  _nbCallEnd: 0,

  /**
   * Launch a test server and run tests
   * @param {Object} options Mocha options
   * @param {Function} callback
   */
  runTest: function (options, callback) {
    // -s runs the suite once and exits: watching could only reload the server
    // in the middle of a run, which wipes the SQL registry under the tests
    if (options !== null && options !== undefined && options.stop === true) {
      return this._bootAndRun(options, callback)
    }

    // Watch files for any change
    watch.watchServerFiles([/^\/api\/\S*\/test\/test\.\S*\.js$/, /^\/test\/test\.\S*\.js$/], () => {
      server.close((err) => {
        if (err) {
          return callback(err)
        }

        server.run('test', process.env.HEARTH_SERVER_PATH, options, (err) => {
          if (err) {
            return callback(err)
          }

          // Run tests
          this._runMocha(options)
        })
      })
    }, (err) => {
      if (err) {
        return callback(err)
      }

      return this._bootAndRun(options, callback)
    })
  },

  /**
   * Read the test files, start the test server and run the suite
   * @param {Object} options Cli options
   * @param {Function} callback
   */
  _bootAndRun: function (options, callback) {
    // Read all tests files
    this._readTestDirectory('/', (err) => {
      if (err) {
        return callback(err)
      }

      // Run server for tests
      server.run('test', process.env.HEARTH_SERVER_PATH, options, (err) => {
        if (err) {
          return callback(err)
        }

        // Run tests
        this._runMocha(options)
      })
    })
  },

  /**
   * Run suite tests
   * @param {Options} options Cli options
   */
  _runMocha: function (options) {
    // mocha is an optional peer dependency: only the `hearthjs test` command
    // needs it, so a deployed application does not have to ship a test runner
    let Mocha = null

    try {
      Mocha = require('mocha')
    } catch (e) {
      console.error('`hearthjs test` needs mocha. Run `npm install --save-dev mocha` in your project.')
      return process.exit(1)
    }

    let mocha = new Mocha()

    mocha.suite.on('require', function (global, file) {
      delete require.cache[file]
    })

    // Sorted here rather than at readdir: the directory walk recurses
    // asynchronously, so the order files arrive in depends on when the IO
    // completes as much as on the listing. Sorting at the point of use is what
    // makes one test polluting the next reproduce off CI instead of only on it.
    this._testFiles.sort()

    this._testFiles.forEach((filepath) => {
      mocha.addFile(filepath)
    })

    const _runner = mocha
      .bail(true)
      .ui('bdd')
      .run((code) => {
        // A suite that ran nothing is not a pass. Zero covers both "no test file
        // was found" and "the files were found and registered nothing", which is
        // what a dependency throwing at require time looks like: a run that is
        // green, instant, and has tested none of the code it was asked to.
        if (_runner.stats.tests === 0) {
          console.error('No test ran. Check that the test files match `test.<name>.js`, and that none of them failed to load.')
          code = 1
        }

        if (options.stop !== true) {
          return
        }

        // process.exit() drops whatever stdout still holds when it is a pipe,
        // which is how a failing CI run loses the trace that explains it. The
        // code is set and the server released instead, so the process ends on
        // its own once the output has drained.
        process.exitCode = code

        server.close(() => {
          // Whatever the project left running would otherwise hold the loop
          // open. Unref'd: it never delays an exit that can already happen, and
          // it forces one that cannot.
          setTimeout(() => process.exit(code), 2000).unref()
        })
      })
  },

  /**
   * Read directory files
   * @param {String} directoryPath Directory path to read
   * @param {Function} callback
   */
  _readTestDirectory: function (directoryPath, callback) {
    let _completePath = path.join(process.env.HEARTH_SERVER_PATH, directoryPath)

    fs.readdir(_completePath, (err, files) => {
      if (err) {
        return callback(err)
      }

      this._nbCallStart += 1
      this._checkFiles(_completePath, directoryPath, files, 0, (err) => {
        if (err) {
          return callback(err)
        }

        this._nbCallEnd += 1

        // Check if we parse all files
        if (this._nbCallStart === this._nbCallEnd) {
          return callback(null)
        }
      })
    })
  },

  /**
   * Loop recursively on all server files and check if there is test files
   * @param {String} completePath Directory path of files list
   * @param {String} directoryPath Directory path from server directory
   * @param {Array} files List of file/directory to check
   * @param {Integer} index files index
   * @param {Function} callback
   */
  _checkFiles: function (completePath, directoryPath, files, index, callback) {
    if (index >= files.length) {
      return callback(null)
    }

    let _currentFile = files[index]
    let _filePath = path.join(completePath, _currentFile)
    let _isDirectory = fs.existsSync(_filePath) && fs.lstatSync(_filePath).isDirectory()

    // Check if path is a directory. If it is, parse it too
    if (_isDirectory && _filePath.includes('uploads') === false) {
      this._readTestDirectory(path.join(directoryPath, _currentFile), (err) => {
        if (err) {
          return callback(err)
        }
      })
    } else {
      // Check if file is a test file
      if (testFileRegex.test(_currentFile)) {
        this._testFiles.push(_filePath)
      }
    }

    this._checkFiles(completePath, directoryPath, files, index + 1, callback)
  }
}

module.exports = test
