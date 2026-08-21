const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const mustache = require('../lib/mustache')

const rootPath = path.join(os.tmpdir(), 'hearthjs-renderfile-test')

/**
 * Write a template file and return its path
 * @param {String} name File name
 * @param {String} content File content
 */
function writeTemplate (name, content) {
  const filePath = path.join(rootPath, name)

  fs.writeFileSync(filePath, content)
  return filePath
}

describe('Mustache renderFile', () => {
  beforeEach(() => {
    fs.rmSync(rootPath, { recursive: true, force: true })
    fs.mkdirSync(rootPath, { recursive: true })
    mustache._clearFileCache()
  })

  after(() => {
    fs.rmSync(rootPath, { recursive: true, force: true })
    mustache._clearFileCache()
  })

  it('should render a template file', (done) => {
    const filePath = writeTemplate('simple.sql', 'SELECT {{ data.id }}')

    mustache.renderFile(filePath, { id: 12 }, null, {}, (err, result) => {
      assert.strictEqual(err, null)
      assert.strictEqual(result.string, 'SELECT $1')
      assert.deepStrictEqual(result.data, [12])
      done()
    })
  })

  it('should return an error if the file does not exist', (done) => {
    mustache.renderFile(path.join(rootPath, 'nope.sql'), {}, null, {}, (err) => {
      assert.notStrictEqual(err, null)
      assert.strictEqual(err.code, 'ENOENT')
      done()
    })
  })

  it('should return a syntax error for an invalid template', (done) => {
    const filePath = writeTemplate('bad.sql', 'SELECT {{ data.id ')

    mustache.renderFile(filePath, { id: 1 }, null, {}, (err) => {
      assert.notStrictEqual(err, null)
      assert.strictEqual(err instanceof SyntaxError, true)
      done()
    })
  })

  it('should cache the parsed tokens between two calls', (done) => {
    const filePath = writeTemplate('cached.sql', 'SELECT {{ data.id }}')

    mustache.renderFile(filePath, { id: 1 }, null, {}, (err) => {
      assert.strictEqual(err, null)
      assert.strictEqual(mustache._fileCache.has(filePath), true)

      const cachedTokens = mustache._fileCache.get(filePath).tokens

      mustache.renderFile(filePath, { id: 2 }, null, {}, (err, result) => {
        assert.strictEqual(err, null)
        // Same token list object: the file has not been re-parsed
        assert.strictEqual(mustache._fileCache.get(filePath).tokens, cachedTokens)
        assert.deepStrictEqual(result.data, [2])
        done()
      })
    })
  })

  it('should not consume the cached tokens, so the same file renders identically twice', (done) => {
    const filePath = writeTemplate('twice.sql', 'SELECT {{ data.a }}, {{ data.b }}, {{ data.c }}')

    mustache.renderFile(filePath, { a: 1, b: 2, c: 3 }, null, {}, (err, first) => {
      assert.strictEqual(err, null)

      mustache.renderFile(filePath, { a: 4, b: 5, c: 6 }, null, {}, (err, second) => {
        assert.strictEqual(err, null)
        assert.strictEqual(second.string, first.string)
        assert.deepStrictEqual(first.data, [1, 2, 3])
        assert.deepStrictEqual(second.data, [4, 5, 6])
        done()
      })
    })
  })

  it('should re-parse the file when it changed on disk', (done) => {
    const filePath = writeTemplate('reload.sql', 'SELECT {{ data.id }}')

    mustache.renderFile(filePath, { id: 1 }, null, {}, (err, first) => {
      assert.strictEqual(err, null)
      assert.strictEqual(first.string, 'SELECT $1')

      fs.writeFileSync(filePath, 'SELECT {{ data.id }} AS "id", {{ data.name }} AS "name"')
      // mtime resolution is coarse on some filesystems: rather than sleeping
      // until the clock moves, stamp a distinctly different time ourselves
      const _older = new Date(Date.now() - 60000)

      fs.utimesSync(filePath, _older, _older)

      mustache.renderFile(filePath, { id: 1, name: 'toto' }, null, {}, (err, second) => {
        assert.strictEqual(err, null)
        assert.strictEqual(second.string, 'SELECT $1 AS "id", $2 AS "name"')
        assert.deepStrictEqual(second.data, [1, 'toto'])
        done()
      })
    })
  })

  it('should render an include through the cache', (done) => {
    const includePath = writeTemplate('included.sql', 'WHERE "id" = {{ data.id }}')
    const mainPath = writeTemplate('main.sql', 'SELECT * FROM "user" {-> included <-}')
    const sqlFiles = { included: includePath, main: mainPath }

    mustache.renderFile(mainPath, { id: 7 }, null, sqlFiles, (err, result) => {
      assert.strictEqual(err, null)
      assert.strictEqual(result.string, 'SELECT * FROM "user" WHERE "id" = $1')
      assert.deepStrictEqual(result.data, [7])
      assert.strictEqual(mustache._fileCache.has(includePath), true)
      done()
    })
  })

  it('should report a missing include file as a read error', (done) => {
    const mainPath = writeTemplate('missing.sql', 'SELECT * {-> gone <-}')
    const sqlFiles = { gone: path.join(rootPath, 'gone.sql'), missing: mainPath }

    mustache.renderFile(mainPath, {}, null, sqlFiles, (err) => {
      assert.notStrictEqual(err, null)
      assert.strictEqual(err.message.includes('Error while reading file'), true)
      done()
    })
  })
})

describe('Mustache condition inside a loop', () => {
  // The renderer consumes the token list it is given, so a condition nested in
  // a loop must be re-copied or it disappears after the first iteration.
  it('should render a condition on every iteration of a loop', (done) => {
    const template = '{% data.items %}[{# data.items[i].keep #}{{ data.items[i].value }}{{#}}]{{%}}'
    const data = {
      items: [
        { keep: true, value: 'a' },
        { keep: true, value: 'b' },
        { keep: true, value: 'c' }
      ]
    }

    mustache.render(template, data, null, {}, (err, result) => {
      assert.strictEqual(err, null)
      assert.strictEqual(result.string, '[$1][$2][$3]')
      assert.deepStrictEqual(result.data, ['a', 'b', 'c'])
      done()
    })
  })

  it('should skip the condition only on the iterations where it is false', (done) => {
    const template = '{% data.items %}[{# data.items[i].keep #}{{ data.items[i].value }}{{#}}]{{%}}'
    const data = {
      items: [
        { keep: true, value: 'a' },
        { keep: false, value: 'b' },
        { keep: true, value: 'c' }
      ]
    }

    mustache.render(template, data, null, {}, (err, result) => {
      assert.strictEqual(err, null)
      assert.strictEqual(result.string, '[$1][][$2]')
      assert.deepStrictEqual(result.data, ['a', 'c'])
      done()
    })
  })

  it('should render nested loops on every iteration', (done) => {
    const template = '{% data.rows %}({% data.rows[i].cols %}{{ data.rows[i].cols[j] }}{{%}}){{%}}'
    const data = {
      rows: [
        { cols: ['a', 'b'] },
        { cols: ['c', 'd'] }
      ]
    }

    mustache.render(template, data, null, {}, (err, result) => {
      assert.strictEqual(err, null)
      assert.strictEqual(result.string, '($1$2)($3$4)')
      assert.deepStrictEqual(result.data, ['a', 'b', 'c', 'd'])
      done()
    })
  })
})
