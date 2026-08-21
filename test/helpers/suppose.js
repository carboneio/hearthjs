const { spawn } = require('child_process')

/**
 * Minimal replacement for the abandoned `suppose` package. Spawns a command
 * and answers its prompts in order, then calls back with the exit code.
 */
class Suppose {
  constructor (command, args, options = {}) {
    this._command = command
    this._args = args || []
    this._options = options
    this._expectations = []
    this._errorHandler = null
    this._buffer = ''
    this._child = null
  }

  /**
   * Register a prompt and the answer to write on stdin when it shows up
   * @param {String|RegExp} prompt Expected prompt
   * @param {String} response Answer to write on stdin
   */
  when (prompt, response) {
    this._expectations.push({ prompt, response, done: false })
    return this
  }

  /**
   * Only the 'error' event is used by the test suite
   * @param {String} event Event name
   * @param {Function} handler
   */
  on (event, handler) {
    if (event === 'error') {
      this._errorHandler = handler
    }

    return this
  }

  /**
   * Spawn the process and call back with its exit code
   * @param {Function} callback
   */
  end (callback) {
    this._child = spawn(this._command, this._args, { stdio: ['pipe', 'pipe', 'pipe'] })

    const onData = (chunk) => {
      const text = chunk.toString()

      this._buffer += text

      if (this._options.debug !== undefined && this._options.debug.write !== undefined) {
        this._options.debug.write(text)
      }

      this._checkExpectations()
    }

    this._child.stdout.on('data', onData)
    this._child.stderr.on('data', onData)

    this._child.on('error', (err) => {
      if (this._errorHandler !== null) {
        this._errorHandler(err)
      }
    })

    this._child.on('close', (code) => {
      if (this._options.debug !== undefined && this._options.debug.end !== undefined) {
        this._options.debug.end()
      }

      return callback(code)
    })

    return this
  }

  /**
   * Answer every prompt already present in the output buffer
   */
  _checkExpectations () {
    for (let i = 0; i < this._expectations.length; i++) {
      const expectation = this._expectations[i]

      if (expectation.done) {
        continue
      }

      const matched = (expectation.prompt instanceof RegExp)
        ? expectation.prompt.test(this._buffer)
        : this._buffer.includes(expectation.prompt)

      if (matched === false) {
        // Expectations are answered in order, stop at the first pending one
        return
      }

      expectation.done = true
      // Drop what has been consumed so the same prompt can be expected twice
      this._buffer = ''
      this._child.stdin.write(expectation.response)
      return
    }
  }
}

/**
 * Spawn a command and answer its prompts
 * @param {String} command Command to run
 * @param {Array} args Command arguments
 * @param {Object} options { debug: WritableStream }
 */
module.exports = function suppose (command, args, options) {
  return new Suppose(command, args, options)
}
