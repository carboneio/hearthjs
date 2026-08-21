const helper = require('./helper')

const converter = {

  /**
   * Index of the arrays being built, replacing the linear scans that made
   * sqlToJson quadratic. WeakMap<array, Map<key, { indexed, map }>>.
   */
  _createIndexes: function () {
    return new WeakMap()
  },

  /**
   * Same result as `arr.findIndex(item => item[key] === value)`, but backed by
   * an index instead of a full scan.
   * @param {WeakMap} indexes Index store created by _createIndexes
   * @param {Array} arr Array to search
   * @param {String} key Key to compare
   * @param {Any} value Value to look for
   */
  _findIndexByKey: function (indexes, arr, key, value) {
    // A Map matches NaN with NaN while === never does, keep === semantics
    if (value !== value) { // eslint-disable-line no-self-compare
      return -1
    }

    let byKey = indexes.get(arr)

    if (byKey === undefined) {
      byKey = new Map()
      indexes.set(arr, byKey)
    }

    let entry = byKey.get(key)

    if (entry === undefined) {
      entry = { indexed: 0, map: new Map() }
      byKey.set(key, entry)
    }

    // Index the elements appended since the last lookup. findIndex returns the
    // first match, so an already known value is never overwritten.
    for (let i = entry.indexed; i < arr.length; i++) {
      const itemValue = arr[i][key]

      if (entry.map.has(itemValue) === false) {
        entry.map.set(itemValue, i)
      }
    }

    entry.indexed = arr.length

    const found = entry.map.get(value)

    return (found === undefined) ? -1 : found
  },

  /**
   * Turn flat SQL rows into the nested structure described by the model
   * @param {Array} model Model describing the shape to build
   * @param {Array} data Rows returned by the database
   */
  sqlToJson: function (model, data) {
    let current = (this._getColumnInfo(model, false) === 'TYPE_ARRAY') ? [] : {}
    let currentType = (this._getColumnInfo(model, false) === 'TYPE_ARRAY') ? 'TYPE_ARRAY' : 'TYPE_OBJECT'

    const indexes = this._createIndexes()
    const result = this.parseModel(model, Object.create(null), [])
    const dataKeys = (data.length > 0) ? Object.keys(data[0]) : {}
    const parsedModel = result.info
    const complexPrimaryKeys = result.complexPrimaryKeys

    for (let i = 0; i < data.length; i++) {
      const dataLine = data[i]

      const ids = this.getListOfNewId(dataLine, complexPrimaryKeys, parsedModel, current, indexes)

      let objToUpdate = this.buildMissingItemWithIds(dataLine, ids, parsedModel)

      // Loop on data keys
      for (let j = 0; j < dataKeys.length; j++) {
        const currentKey = dataKeys[j]
        const keyInfo = parsedModel[currentKey]

        if (keyInfo === undefined) {
          continue
        }

        // indexOf instead of findIndex: no closure allocated per key per row
        const elemIsNew = ids.indexOf(currentKey) !== -1

        if (elemIsNew) {
          this.setDeepProperty(objToUpdate, keyInfo.path, dataLine[currentKey], keyInfo.parents[keyInfo.parents.length - 1])
        } else {
          this.setDeepProperty(objToUpdate, keyInfo.path, dataLine[currentKey])
        }
      }

      if (currentType === 'TYPE_OBJECT' && i === 0) {
        current = objToUpdate
      } else {
        if (currentType === 'TYPE_OBJECT') {
          this.deepMergeObject(current, objToUpdate)
        }

        // If we have multiple ids, we are in an array
        for (let j = 0; j < ids.length; j++) {
          let currentArray = current
          let currentObjToUpdate = objToUpdate
          let nextIndex = -1
          let depthToGo = 0

          // Hoisted: this used to be re-resolved a dozen times per iteration
          const idInfo = parsedModel[ids[j]]
          const idParents = idInfo.parents
          const idPath = idInfo.path
          const idKey = idPath[idPath.length - 1]

          for (let k = 0; k < idParents.length; k++) {
            const parentKey = idParents[k]

            if (nextIndex !== -1) {
              currentArray = currentArray[nextIndex]
              nextIndex = -1
            }

            if (idParents[k + 1] === undefined) {
              // Check if it already exists
              if (parentKey !== 'root') {
                if (Array.isArray(currentArray)) {
                  const index = this._findIndexByKey(indexes, currentArray, idKey, currentObjToUpdate[idKey])

                  if (index !== -1) {
                    currentArray = currentArray[index]
                  }
                }

                currentArray = currentArray[parentKey]

                if (Array.isArray(currentObjToUpdate[parentKey])) {
                  currentObjToUpdate = currentObjToUpdate[parentKey]

                  if (currentObjToUpdate.length === 0) {
                    break
                  }

                  currentObjToUpdate = currentObjToUpdate[0]
                } else {
                  currentObjToUpdate = currentObjToUpdate[parentKey]
                }
              }

              if (Array.isArray(currentArray)) {
                const index = this._findIndexByKey(indexes, currentArray, idKey, currentObjToUpdate[idKey])
                const value = currentObjToUpdate[idKey]

                if (index === -1 &&
                  ((typeof value === 'string' && value.length > 0) ||
                  (typeof value !== 'string' && value !== null))) {
                  currentArray.push(currentObjToUpdate)
                }
              }
            } else if (Array.isArray(currentArray) || currentArray[parentKey] !== undefined) {
              depthToGo += 1

              if (currentArray[parentKey] !== undefined) {
                currentArray = currentArray[parentKey]
                currentObjToUpdate = currentObjToUpdate[parentKey]

                if (Array.isArray(currentObjToUpdate)) {
                  currentObjToUpdate = currentObjToUpdate[0]
                  depthToGo += 1
                }
              }

              if (Array.isArray(currentArray)) {
                // We have to find the key object corresponding to the primary key of the level eg: [{ id: ['<<pk>>'], subObj: {} }] -> find id for subObj key
                let pk = null

                for (let p = 0; p < complexPrimaryKeys.length; p++) {
                  const item = complexPrimaryKeys[p]

                  if (item.keyPath.length !== depthToGo) {
                    continue
                  }

                  if (parentKey === 'root') {
                    pk = item
                    break
                  }

                  // Finish at 1 to avoid checking root parent
                  let matches = true

                  for (let tmpK = k; tmpK >= 1; tmpK--) {
                    if (item.keyPath.includes(idParents[tmpK]) === false) {
                      matches = false
                      break
                    }
                  }

                  if (matches) {
                    pk = item
                    break
                  }
                }

                if (pk === null) {
                  throw new Error('One primary key could not be found, check your model is well constructed and has `<<` `>>` around its primary keys')
                }

                const itemKey = pk.objKey

                const index = this._findIndexByKey(indexes, currentArray, itemKey, currentObjToUpdate[itemKey])

                if (index !== -1) {
                  nextIndex = index
                }
              }
            }
          }
        }
      }

    }

    return current
  },

  // Merge two object to remove null values, it write the new result in obj1
  /**
   * Merge obj2 into obj1 to fill its null values, in place
   * @param {Object} obj1 Object to complete
   * @param {Object} obj2 Object to read from
   */
  deepMergeObject: function (obj1, obj2) {
    const keys = Object.keys(obj1)

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]

      if (obj1[key] === null && obj2[key] !== null) {
        obj1[key] = obj2[key]
      } else if (obj1[key] !== null && obj1[key] !== undefined && typeof obj1[key] === 'object' && Array.isArray(obj1[key]) === false && obj2[key] !== undefined) {
        this.deepMergeObject(obj1[key], obj2[key])
      }
    }
  },

  /**
   * Build the object holding the primary keys that are new on this row
   * @param {Object} dataLine Current SQL row
   * @param {Array} missingIds Keys that are new
   * @param {Object} parsedModel Parsed model
   */
  buildMissingItemWithIds (dataLine, missingIds, parsedModel) {
    if (missingIds.length === 0) {
      return {}
    }

    let obj = {}

    for (let i = 0; i < missingIds.length; i++) {
      if (dataLine[missingIds[i]] !== null) {
        this.setDeepProperty(obj, parsedModel[missingIds[i]].path, dataLine[missingIds[i]], null, true)
      }
    }

    return obj
  },

  /**
   * List the primary keys of this row that are not in the result yet
   * @param {Object} dataLine Current SQL row
   * @param {Array} complexPrimaryKeys Primary keys of the model
   * @param {Object} parsedModel Parsed model
   * @param {Object} current Result built so far
   * @param {WeakMap} indexes Optional index store shared with sqlToJson
   */
  getListOfNewId (dataLine, complexPrimaryKeys, parsedModel, current, indexes) {
    const ids = []

    if (indexes === undefined) {
      indexes = this._createIndexes()
    }

    for (let j = 0; j < complexPrimaryKeys.length; j++) {
      let tmpCurrent = current
      let depthToGo = 0

      // Hoisted: the same three lookups were repeated on every path element
      const sqlKey = complexPrimaryKeys[j].sqlKey
      const sqlKeyValue = dataLine[sqlKey]

      if (sqlKeyValue === undefined) {
        continue
      }

      const keyPath = parsedModel[sqlKey].path

      for (let k = 0; k < keyPath.length; k++) {
        if (keyPath[k - 1] === 0) {
          continue
        }

        if (keyPath[k] === 0 && Array.isArray(tmpCurrent)) {
          depthToGo += 1

          let pathPk = null

          for (let p = 0; p < complexPrimaryKeys.length; p++) {
            const item = complexPrimaryKeys[p]

            if (item.keyPath.length !== depthToGo) {
              continue
            }

            if (k === 0) {
              pathPk = item
              break
            }

            let matches = true

            for (let tmpK = k - 1; tmpK >= 0; tmpK--) {
              if (item.keyPath.includes(keyPath[tmpK]) === false) {
                matches = false
                break
              }
            }

            if (matches) {
              pathPk = item
              break
            }
          }

          if (pathPk === null) {
            throw new Error('One primary key could not be found, check your model is well constructed and has `<<` `>>` around its primary keys')
          }

          const itemKey = pathPk.objKey
          const pathValue = dataLine[pathPk.sqlKey]
          const index = this._findIndexByKey(indexes, tmpCurrent, itemKey, pathValue)

          if (index === -1) {
            // Check to not push null id and check we are well on the last id of the row to not push useless ids
            if (pathValue !== null && sqlKeyValue !== null) {
              ids.push(sqlKey)
            }
            break
          } else {
            tmpCurrent = tmpCurrent[index][keyPath[k + 1]]
            depthToGo += 1
          }
        } else if (tmpCurrent[keyPath[k]] !== undefined) {
          tmpCurrent = tmpCurrent[keyPath[k]]
          depthToGo += 1
        } else {
          if (sqlKeyValue !== null) {
            ids.push(sqlKey)
          }
          break
        }
      }
    }

    return ids
  },

  /**
   * Write a value at the given path, creating the objects and arrays needed
   * @param {Object} obj Object to write into
   * @param {Array} path Path to the value
   * @param {Any} value Value to write
   * @param {String} startLevel Level to start from
   * @param {Boolean} isPK Is the value a primary key
   */
  setDeepProperty: function (obj, path, value, startLevel = null, isPK = false) {
    startLevel = (startLevel === 'root') ? null : startLevel
    var curr = obj;
    let startDepth = 0

    if (startLevel !== null) {
      const index = path.findIndex(item => item === startLevel)

      if (index !== -1) {
        startDepth = index + 1
      }

      let allExists = true

      for (let i = 0; i < startDepth; i++) {
        if (path[i] === 0) {
          continue
        }

        if (helper.isArray(curr) && curr[0] !== undefined && curr[0][path[i]] !== undefined) {
          curr = curr[0][path[i]]
        } else if (curr[path[i]] !== undefined) {
          curr = curr[path[i]]
        } else {
          allExists = false
        }

        if (path[i + 1] === 0 && curr[0] !== undefined) {
          curr = curr[0]
        }
      }

      if (allExists === false) {
        startDepth = 0
        curr = obj
      }
    }

    for (let depth = startDepth; depth < path.length - 1; depth++) {
      if (path[depth] === 0) {
        continue
      }

      if (Array.isArray(curr) || (Array.isArray(curr) === false && curr[path[depth]] === undefined)) {
        if (path[depth + 1] === 0) {
          if (helper.isArray(curr) && curr.length === 0) {
            if (isPK === true) {
              let toPush = {}

              toPush[path[depth]] = []
              curr.push(toPush)
              curr = curr[0][path[depth]]
            }
          } else if (helper.isArray(curr) && curr.length > 0) {
            if (curr[0][path[depth]] !== undefined) {
              curr = curr[0][path[depth]]
            } else {
              curr[0][path[depth]] = []
              curr = curr[0][path[depth]]
            }
          } else {
            curr[path[depth]] = []
            curr = curr[path[depth]]
          }
        } else if (Array.isArray(curr) === false) {
          curr[path[depth]] = {}
          curr = curr[path[depth]]
        } else {
          // The current depth is an object that we have to push in an array
          if (isPK === true) {
            let toPush = {}

            toPush[path[depth]] = {}
            curr.push(toPush)
            curr = curr[0][path[depth]]
          }
        }
      } else {
        curr = curr[path[depth]]

        if (path[depth + 1] === 0 && curr[0] !== undefined) {
          curr = curr[0]
        }
      }
    }

    if ((isPK === true && value !== null) || isPK === false) {
      if (helper.isArray(curr) && curr[0] === undefined && isPK === false) {
        // Only a primary key can create an object in an array
        return
      }

      if (helper.isArray(curr) && curr[0] === undefined) {
        let toPush = {}

        toPush[path[path.length - 1]] = value
        curr.push(toPush)
      } else if (helper.isArray(curr) && curr[0] !== undefined) {
        if (curr[0][path[path.length - 1]] == null) {
          curr[0][path[path.length - 1]] = value
        }
      } else {
        if (curr[path[path.length - 1]] == null) {
          curr[path[path.length - 1]] = value;
        }
      }
    }
  },

  /**
   * Walk the model and describe where every SQL column goes
   * @param {Array|Object} model Model to parse
   * @param {Object} info Accumulated column information
   * @param {Array} currentPath Path being walked
   */
  parseModel: function (model, info = Object.create(null), currentPath = [], primaryKeys = [], parents = ['root'], complexPrimaryKeys = [], previousColumnInfo = null) {
    let skeleton = null
    let columnInfo = this._getColumnInfo(model, false)

    if (columnInfo === 'TYPE_ARRAY') {
      skeleton = []
      let objectArray = (helper.isObject(model[0])) ? model[0] : model[1]
      const savePath = currentPath.slice()
      const saveParents = parents.slice()

      currentPath.push(0)

      const result = this.parseModel(objectArray, info, currentPath, primaryKeys, parents, complexPrimaryKeys, columnInfo)

      skeleton.push(result.skeleton)
      currentPath = savePath
      parents = saveParents
    } else if (columnInfo === 'TYPE_OBJECT') {
      skeleton = {}

      if (helper.isObject(model) === false) {
        model = model[1]
      }

      const modelKeys = Object.keys(model)

      for (var k = 0; k < modelKeys.length; k++) {
        let objKey = modelKeys[k]
        let columnInfo = this._getColumnInfo(model[objKey], false)
        let typeKey = this._getColumnInfo(model[objKey], true)

        if (columnInfo !== 'TYPE_ARRAY' && columnInfo !== 'TYPE_OBJECT') {

          if (typeKey === 'TYPE_PRIMARY_KEY' && previousColumnInfo === 'TYPE_ARRAY') {
            primaryKeys.push(columnInfo)
            complexPrimaryKeys.push({
              keyPath: currentPath.slice(),
              sqlKey: columnInfo,
              objKey
            })
          }

          info[columnInfo] = {
            isPrimaryKey: (typeKey === 'TYPE_PRIMARY_KEY' && previousColumnInfo === 'TYPE_ARRAY') ? true : false,
            parents: parents.slice(),
            path: currentPath.concat([objKey])
          }
          skeleton[objKey] = null
        } else if (columnInfo !== null) {
          const savePath = currentPath.slice()
          const saveParents = parents.slice()

          currentPath.push(objKey)
          parents.push(objKey)

          const result = this.parseModel(model[objKey], info, currentPath, primaryKeys, parents, complexPrimaryKeys, columnInfo)

          skeleton[objKey] = result.skeleton
          currentPath = savePath
          parents = saveParents
        }
      }
    }

    return { primaryKeys, complexPrimaryKeys, info, skeleton, parents }
  },

  /**
   * Return model primary keys
   * @param {Array} model Schema model
   */
  getModelPrimaryKeys: function (model) {
    let finalList = []
    let columnType = this._getColumnInfo(model, false)

    if (columnType === 'TYPE_OBJECT') {
      // Check how object was written
      if (helper.isObject(model)) {
        // Was written like {}, set columnName to null to parse all key
        columnType = null
      } else {
        finalList = finalList.concat(this.getModelPrimaryKeys(model[1]))
        return finalList
      }
    } else if (columnType === 'TYPE_ARRAY') {
      // Check how object was written [{}] => [0] / ['array', {}] => [1]
      let modelToUse = (helper.isObject(model[0])) ? model[0] : model[1]
      finalList = finalList.concat(this.getModelPrimaryKeys(modelToUse))
      return finalList
    }

    if (columnType === null) {
      // console.log('COLUMN TYPE', model)
      const modelKeys = Object.keys(model)

      for (var k = 0; k < modelKeys.length; k++) {
        let objKey = modelKeys[k]

        let nextColumnType = this._getColumnInfo(model[objKey], true)

        if (nextColumnType === 'TYPE_OBJECT' || nextColumnType === 'TYPE_ARRAY') {
          finalList = finalList.concat(this.getModelPrimaryKeys(model[objKey]))
        } else if (nextColumnType === 'TYPE_PRIMARY_KEY') {
          finalList.push(model[objKey][0].split('<').join('').split('>').join(''))
        }
      }
    }
    return finalList
  },

  /**
   * Return the name of the column
   * @param {Array} value Variable to parse
   */
  _getColumnInfo: function (value, wantType) {
    if ((value.length >= 2 && value[0] === 'object') || helper.isObject(value)) {
      return 'TYPE_OBJECT'
    } else if ((value.length >= 2 && value[0] === 'array') || (helper.isArray(value) && helper.isObject(value[0]))) {
      return 'TYPE_ARRAY'
    } else if (value[0] === undefined) {
      return null
    } else {
      if (wantType) {
        if (value[0].trim().startsWith('<<') && value[0].trim().endsWith('>>')) {
          return 'TYPE_PRIMARY_KEY'
        } else {
          return 'TYPE_KEY'
        }
      } else {
        return value[0].split('<').join('').split('>').join('')
      }
    }
  }
}

module.exports = converter
