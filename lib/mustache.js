const converter = require('./converter')
const fs = require('fs')
const helper = require('./helper')

const endLoop = '{{%}}'
const endCond = '{{#}}'
const openingLoop = '{%'
const closingLoop = '%}'
const openingVar = '{{'
const closingVar = '}}'
const openingConst = '{$'
const openingConstRegex = '{\\$'
const closingConst = '$}'
const closingConstRegex = '\\$}'
const openingCond = '{#'
const closingCond = '#}'
const hardPaste = ':'
const openingInclude = '{->'
const closingInclude = '<-}'

const tagList = [endLoop, endCond, openingLoop, closingLoop, openingVar, closingVar, openingConst, closingConst, openingCond, closingCond, hardPaste, openingInclude, closingInclude]
const tagListRegex = [endLoop, endCond, openingLoop, closingLoop, openingVar, closingVar, openingConstRegex, closingConstRegex, openingCond, closingCond, hardPaste, openingInclude, closingInclude]
const extraToken = ['hard']

/**
 * Append every item of source to target in place. Rebuilding the accumulator
 * with concat on every loop iteration is quadratic in the number of items.
 * @param {Array} target Array to append to
 * @param {Array} source Items to append
 */
function appendAll (target, source) {
  if (source === undefined || source === null) {
    return
  }

  for (let i = 0; i < source.length; i++) {
    target.push(source[i])
  }
}

// One `:hard` item: a dotted identifier with optional ASC/DESC and NULLS
// ordering. Anchored, so quotes, semicolons, parens and operators can't slip in.
const HARD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*( +(?:ASC|DESC))?( +NULLS +(?:FIRST|LAST))?$/i
// A positional ORDER BY reference ("ORDER BY 1"), optional direction.
const HARD_POSITION = /^[0-9]+( +(?:ASC|DESC))?( +NULLS +(?:FIRST|LAST))?$/i

const mustache = {
  // filePath -> { mtimeMs, size, tokens }. Tokenizing only depends on the
  // file content, so it is kept between queries.
  _fileCache: new Map(),

  /**
   * Whether a value is safe for the `:hard` token to paste verbatim into SQL.
   * Only a SQL identifier or ORDER BY term (comma-separated list allowed) is
   * accepted; anything else is rejected, which stops SQL injection.
   * @param {*} value The resolved template value
   * @return {Boolean} True when the value is safe to paste verbatim
   */
  _isSafeHardValue: function (value) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return false
    }

    const _string = String(value)

    if (_string.length === 0 || _string.length > 256) {
      return false
    }

    const _items = _string.split(',')

    for (let i = 0; i < _items.length; i++) {
      const _item = _items[i].trim()

      if (HARD_IDENTIFIER.test(_item) === false && HARD_POSITION.test(_item) === false) {
        return false
      }
    }

    return true
  },

  /**
   * Drop the parsed file cache (called when the database pool is closed)
   */
  _clearFileCache: function () {
    this._fileCache.clear()
  },

  /**
   * Parse a string and return final string and final object
   * @param {String} template String to parse
   * @param {Object} data Data to inject
   * @param {Object} model Model for request
   * @param {Object} sqlFiles Key: filename Value: filepath
   */
  render: function (template, data, model, sqlFiles, callback, defaultValues = { varIndex: 1, loopIndexes: [] }) {
    if (sqlFiles === undefined) {
      callback = model
      sqlFiles = {}
      model = null
    } else if (callback === undefined) {
      callback = sqlFiles
      sqlFiles = {}
    }

    let tokens = []

    try {
      tokens = this.parse(template)
    } catch (e) {
      return callback(e)
    }

    return this._renderTokens(tokens, data, model, sqlFiles, callback, defaultValues)
  },

  /**
   * Render a template file, reusing the tokens parsed on a previous call when
   * the file did not change on disk.
   * @param {String} filePath Template file to render
   * @param {Object} data Data to inject
   * @param {Object} model Model for request
   * @param {Object} sqlFiles Key: filename Value: filepath
   * @param {Function} callback
   */
  renderFile: function (filePath, data, model, sqlFiles, callback, defaultValues = { varIndex: 1, loopIndexes: [] }) {
    fs.stat(filePath, (err, stat) => {
      if (err) {
        return callback(err)
      }

      const cached = this._fileCache.get(filePath)

      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return this._renderTokens(cached.tokens, data, model, sqlFiles, callback, defaultValues)
      }

      fs.readFile(filePath, 'utf-8', (err, content) => {
        if (err) {
          return callback(err)
        }

        let tokens = []

        try {
          tokens = this.parse(content)
        } catch (e) {
          return callback(e)
        }

        this._fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, tokens })
        return this._renderTokens(tokens, data, model, sqlFiles, callback, defaultValues)
      })
    })
  },

  /**
   * Build the final string and object from an already parsed template
   * @param {Array} tokens Parsed template
   * @param {Object} data Data to inject
   * @param {Object} model Model for request
   * @param {Object} sqlFiles Key: filename Value: filepath
   * @param {Function} callback
   */
  _renderTokens: function (tokens, data, model, sqlFiles, callback, defaultValues = { varIndex: 1, loopIndexes: [] }) {
    this._buildString(tokens, data, defaultValues.varIndex, defaultValues.loopIndexes, model, sqlFiles, (err, result) => {
      if (err) {
        return callback(err)
      }

      let finalObj = {}
      const resultKeys = Object.keys(result)

      for (var i = 0; i < resultKeys.length; i++) {
        let key = resultKeys[i]

        if (key === 'finalString') {
          finalObj.string = result[key]
        } else if (key === 'finalData') {
          finalObj.data = result[key]
        } else {
          finalObj[key] = result[key]
        }
      }

      return callback(null, finalObj)
    })
  },

  /**
   * Build the final string with prepared value
   * @param {Array} tokens List of tokens
   * @param {Object} data Data to inject
   * @param {Integer} varIndex Index to increment for SQL request ($1, $2...)
   * @param {Integer} loopIndexes Index for loop, it start to i (0), j (1)
   * @param {Object} model Model for order by
   * @param {Function} callback
   */
  _buildString: function (tokens, data, varIndex, loopIndexes, model, sqlFiles, callback) {
    let finalString = ''
    let finalData = []
    let stringIndex = this._createIndexes(loopIndexes)
    let finalObj = {}

    helper.genericQueue(tokens, (token, next) => {
      if (token[0] === 'text') {
        finalString += token[1]
        return process.nextTick(next)
      } else if (token[0] === 'cond') {
        let condResult

        try {
          condResult = eval(stringIndex + token[1])
        } catch (e) {
          return next(new Error(`Error while determining value of ${token[1]}. Error was ${e.toString()}`))
        }

        if (condResult) {
          this._buildString(token[2], data, varIndex, loopIndexes, model, sqlFiles, (err, obj) => {
            if (err) {
              return next(err)
            }

            finalString += obj.finalString
            varIndex = obj.varIndex
            appendAll(finalData, obj.finalData)
            finalObj = Object.assign(finalObj, obj)
            return process.nextTick(next)
          })
        } else {
          return process.nextTick(next)
        }
      } else if (token[0] === 'loop') {
        let source

        try {
          source = eval(stringIndex + token[1])
        } catch (e) {
          return next(new Error(`Error while determining value of ${token[1]}.length. Error was ${e.toString()}`))
        }

        if (source === undefined || source === null) {
          return next(new Error(`Length of ${token[1]} is undefined`))
        }

        // A loop source MUST be a real array. `data` is the live request, so
        // a forged `{"length":1e9}` would otherwise allocate a billion-item
        // index array and crash the process. A real array is bounded upstream
        // by the body-size limit.
        if (Array.isArray(source) === false) {
          return next(new Error(`${token[1]} must be an array to be looped over`))
        }

        const length = source.length
        let indexArray = []

        for (let i = 0; i < length; i++) {
          indexArray.push(i)
        }

        helper.genericQueue(indexArray, (i, next2) => {
          loopIndexes.push(i)
          this._buildString(token[2], data, varIndex, loopIndexes, model, sqlFiles, (err, obj) => {
            if (err) {
              return next2(err)
            }

            loopIndexes.pop()
            finalString += obj.finalString
            varIndex = obj.varIndex
            appendAll(finalData, obj.finalData)
            finalObj = Object.assign(finalObj, obj)
            return process.nextTick(next2)
          })
        }, (err) => {
          return next(err)
        }, next).start()
      } else if (token[0] === 'var') {
        if (token.length > 2) {
          // Only one extra at the moment (hard) so want replace value directly
          if (extraToken.indexOf(token[2]) === -1) {
            return next(new Error(`Unknown extra token ${token[2]}`))
          }

          let hardValue

          try {
            hardValue = eval(stringIndex + token[1])
          } catch (e) {
            return next(new Error(`Error while determining value of ${token[1]}. Error was ${e.toString()}`))
          }

          // `:hard` pastes into the SQL text with no $N binding, and `data` is
          // the live request, so an arbitrary value here is SQL injection. Only
          // a safe identifier / ORDER BY term is allowed; anything else is
          // rejected rather than silently escaped.
          if (this._isSafeHardValue(hardValue) === false) {
            return next(new Error(`Value of ${token[1]} is not a valid SQL identifier for a ':hard' paste (got ${JSON.stringify(hardValue)})`))
          }

          finalString += hardValue

          return process.nextTick(next)
        } else {
          // Want replace with $1, $2
          finalString += `$${varIndex}`
          try {
            finalData.push(eval(stringIndex + token[1]))
          } catch (e) {
            return next(new Error(`Error while determining value of ${token[1]}. Error was ${e.toString()}`))
          }
          varIndex += 1
          return process.nextTick(next)
        }
      } else if (token[0] === 'const') {
        if (token[1] === 'orderby') {
          if (model !== null) {
            let pk = converter.getModelPrimaryKeys(model)

            if (pk.length > 0) {
              finalString += `ORDER BY ` + pk.map(value => `"${value}"`).join(', ')
            }
          }
        } else {
          finalObj[token[1]] = true
        }

        return process.nextTick(next)
      } else if (token[0] === 'include') {
        if (sqlFiles[token[1]] === undefined) {
          return next(new Error(`Unknow file ${token[1]}`))
        }

        let oldParams = []

        if (token[2] !== undefined) {
          const newParams = []
          oldParams = data.parameters

          for (let index = 0; index < token[2].length; index++) {
            newParams.push(eval(stringIndex + token[2][index])) // Do not push in data.parameters for include which include other includes
          }

          data.parameters = newParams
        }

        this.renderFile(sqlFiles[token[1]], data, model, sqlFiles, (err, result) => {
          if (err) {
            // Keep read errors and render errors distinguishable, as before
            if (err.syscall !== undefined) {
              return next(new Error(`Error while reading file ${sqlFiles[token[1]]}: ${err.toString()}`))
            }

            return next(err)
          }

          finalString += result.string
          appendAll(finalData, result.data)
          varIndex = result.varIndex
          loopIndexes = result.loopIndexes
          data.parameters = oldParams // Reset old parameters when a include has been rendered
          return process.nextTick(next)
        }, { varIndex: varIndex, loopIndexes: loopIndexes })
      }
    }, (err) => {
      return callback(err)
    }, () => {
      finalObj['finalString'] = finalString
      finalObj['finalData'] = finalData
      finalObj['varIndex'] = varIndex
      finalObj['loopIndexes'] = loopIndexes

      return callback(null, finalObj)
    }).start()
  },

  /**
   * Return a script with indexes
   * @param {Array} loopIndexes List of index
   */
  _createIndexes: function (loopIndexes) {
    let _stringIndex = ''

    for (var i = 0; i < loopIndexes.length; i++) {
      _stringIndex += `let ${String.fromCharCode(105 + i)} = ${loopIndexes[i]}; `
    }
    return _stringIndex
  },

  /**
   * Tokenize a string
   * @param {String} template String to tokenize
   */
  parse: function (template) {
    const regex = new RegExp('(' + tagListRegex.join('|') + ')')
    let tokens = template.split(regex)
    tokens = tokens.filter(value => value.length > 0)

    let result = this._buildTokens(tokens, 0, [], null)
    return result
  },

  /**
   * Fill the list of organized tokens
   * @param {Array} tokens Array ok pre-splitted tokens
   * @param {Integer} index Index of array
   * @param {Array} currentList List to fill
   * @param {String} returningTag Returning tag to check
   */
  _buildTokens: function (tokens, index, currentList, returningTag) {
    let nbOpenVar = 0
    let nbConstOpen = 0
    let nbIncludeOpen = 0
    let isVarOpen = false
    let isLoopOpen = false
    let isCondOpen = false
    let isConstOpen = false
    let isIncludeOpen = false
    let name = ''
    let extra = []
    let isExtraOpen = false
    let complexValue = null

    for (var i = index; i < tokens.length; i++) {
      if (returningTag !== null) {
        if (tokens[i] === returningTag) {
          // End of loop or cond, returning list
          return {
            index: i,
            list: currentList
          }
        }
      }

      // Check no other token are open when opening new tag
      if ([openingVar, openingLoop, openingCond, openingConst, openingInclude].indexOf(tokens[i]) !== -1) {
        this._checkSyntax(isVarOpen, `unexpected token ${tokens[i]}, looking for ${closingVar} token`)
        this._checkSyntax(isLoopOpen, `unexpected token ${tokens[i]}, looking for ${closingLoop} token`)
        this._checkSyntax(isCondOpen, `unexpected token ${tokens[i]}, looking for ${closingCond} token`)
        this._checkSyntax(isConstOpen, `unexpected token ${tokens[i]}, looking for ${closingConst} token`)
        this._checkSyntax(isIncludeOpen, `unexpected token ${tokens[i]}, looking for ${closingInclude} token`)
      }

      // Check token
      if (tagList.indexOf(tokens[i]) === -1) {
        if (isExtraOpen) {
          if (tokens[i].trim().length > 0) {
            // Don't push spaces in extra
            extra.push(tokens[i].trim())
          }
        } else if (isIncludeOpen) {
          complexValue = this._splitFunctionParams(tokens[i])
        } else if (isVarOpen || isLoopOpen || isCondOpen || isConstOpen) {
          name += tokens[i]
        } else {
          currentList.push(['text', tokens[i]])
        }
      } else if (tokens[i] === openingVar) {
        nbOpenVar += 1
        isVarOpen = true
      } else if (tokens[i] === openingConst) {
        nbConstOpen += 1
        isConstOpen = true
      } else if (tokens[i] === openingLoop) {
        isLoopOpen = true
      } else if (tokens[i] === openingInclude) {
        nbIncludeOpen += 1
        isIncludeOpen = true
      } else if (tokens[i] === openingCond) {
        isCondOpen = true
      } else if (tokens[i] === closingVar) {
        // Check syntax error
        this._checkSyntax(isLoopOpen || isCondOpen || isConstOpen, `unexpected ${tokens[i]}`)
        this._checkSyntax(isVarOpen === false, `unexpected ${tokens[i]}`)

        if (isExtraOpen && extra.length === 0) {
          throw new Error(`Expected extra after ${hardPaste} for var ${name}`)
        }

        currentList.push(['var', name.trim()].concat(extra))
        name = ''
        nbOpenVar -= 1
        isVarOpen = false
        isExtraOpen = false
        extra = []
      } else if (tokens[i] === closingConst) {
        // Check syntax error
        this._checkSyntax(isLoopOpen || isCondOpen || isVarOpen || isIncludeOpen, `unexpected ${tokens[i]}`)
        this._checkSyntax(isConstOpen === false, `unexpected ${tokens[i]}`)

        currentList.push(['const', name.split(' ').join('').toLowerCase()])
        name = ''
        nbConstOpen -= 1
        isConstOpen = false
      } else if (tokens[i] === closingLoop) {
        // Check syntax error
        this._checkSyntax(isVarOpen || isCondOpen || isConstOpen || isIncludeOpen, `unexpected ${tokens[i]}`)
        this._checkSyntax(isLoopOpen === false, `unexpected ${tokens[i]}`)
        let obj = this._buildTokens(tokens, i + 1, [], endLoop)

        // Check we found a closing tag
        this._checkSyntax(Array.isArray(obj), `missing tag ${endLoop}`)

        i = obj.index
        currentList.push(['loop', name.trim(), obj.list])
        name = ''
        isLoopOpen = false
      } else if (tokens[i] === closingCond) {
        // Check syntax error
        this._checkSyntax(isVarOpen || isLoopOpen || isConstOpen || isIncludeOpen, `unexpected ${tokens[i]}`)
        this._checkSyntax(isCondOpen === false, `unexpected ${tokens[i]}`)
        let obj = this._buildTokens(tokens, i + 1, [], endCond)

        // Check we found a closing tag
        this._checkSyntax(Array.isArray(obj), `missing tag ${endCond}`)

        i = obj.index
        currentList.push(['cond', name.trim(), obj.list])
        name = ''
        isCondOpen = false
      } else if (tokens[i] === closingInclude) {
        // Check syntax error
        this._checkSyntax(isVarOpen || isLoopOpen || isConstOpen || isCondOpen, `unexpected ${tokens[i]}`)
        this._checkSyntax(isIncludeOpen === false, `unexpected ${tokens[i]}`)

        if (complexValue === null) {
          throw new SyntaxError(`Error with include near: ${tokens[i]}`)
        }

        currentList.push(['include', complexValue.name, complexValue.params])
        nbIncludeOpen -= 1
        complexValue = null
        isIncludeOpen = false
      } else if (tokens[i] === hardPaste) {
        if (isVarOpen) {
          isExtraOpen = true
        } else {
          // There is `hardPaste` token in the text, let it in text
          currentList.push(['text', tokens[i]])
        }
      }
    }

    if (nbOpenVar > 0) {
      throw new SyntaxError(`Missing tag ${closingVar}`)
    } else if (nbConstOpen > 0) {
      throw new SyntaxError(`Missing tag ${closingConst}`)
    } else if (nbIncludeOpen > 0) {
      throw new SyntaxError(`Missing tag ${closingInclude}`)
    }
    return currentList
  },

  /**
   * Return an array of params and name
   * @param {String} value Function prototype
   */
  _splitFunctionParams: function (value) {
    if (value.includes('(') === false) {
      return {
        name: value.trim(),
        params: []
      }
    }

    const indexFirstParenthesis = value.indexOf('(')
    const indexLastParenthesis = value.indexOf(')')

    if (indexLastParenthesis < indexFirstParenthesis) {
      throw new SyntaxError(`Bad parenthesis near: ${value}`)
    }

    let name = value.slice(0, indexFirstParenthesis).trim()
    let params = value.slice(indexFirstParenthesis + 1, indexLastParenthesis)

    if (params.length === 0) {
      return {
        name: name,
        params: []
      }
    }

    return {
      name: name,
      params: params.split(',').map(item => {
        let trimed = item.trim()

        if (trimed.length === 0) {
          throw new SyntaxError(`Missing parameter near: ${value}`)
        }

        return trimed
      })
    }
  },

  /**
   * Check value and throw message if necessary
   * @param {boolean} value Value to check
   * @param {String} message Message to throw
   */
  _checkSyntax: function (value, message) {
    if (value) {
      throw new SyntaxError(`Syntax error: ${message}`)
    }
  }
}

module.exports = mustache
