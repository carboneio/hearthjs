const mustache = require('../lib/mustache')
const assert = require('assert')
const path = require('path')
const fsMock = require('file-mock')

describe('Mustache', () => {
  describe('Parser', () => {
    it('should tokenize a variable', () => {
      let expected = [['text', 'Coucou '], ['var', 'myVar'], ['text', ' !']]
      let result = mustache.parse('Coucou {{   myVar}} !')
      assert.deepStrictEqual(result, expected)
    })

    describe('HardParse token', () => {
      it('should tokenize a variable with extra', () => {
        let expected = [['text', 'Coucou '], ['var', 'myVar', 'hard'], ['text', ' !']]
        let result = mustache.parse('Coucou {{   myVar:hard}} !')
        assert.deepStrictEqual(result, expected)
      })

      it('should trim extra token', () => {
        let expected = [['text', 'Coucou '], ['var', 'myVar', 'hard'], ['text', ' !']]
        let result = mustache.parse('Coucou {{   myVar:hard   }} !')
        assert.deepStrictEqual(result, expected)
      })

      it('should interpret hardPaste token like text', () => {
        let expected = [['text', 'Coucou '], ['text', ':'], ['text', ' ca va?'], ['var', 'myVar']]
        let result = mustache.parse('Coucou : ca va?{{   myVar}}')
        assert.deepStrictEqual(result, expected)
      })

      it('should interpret multiple hardPaste token like text or var', () => {
        let expected = [['text', 'Coucou '], ['text', ':'], ['text', ':'], ['text', ' ca'], ['text', ':'], ['text', ' va?'], ['var', 'myVar', 'hard'], ['var', 'myVar2', 'oulaHard']]
        let result = mustache.parse('Coucou :: ca: va?{{   myVar:hard}}{{   myVar2:oulaHard}}')
        assert.deepStrictEqual(result, expected)
      })

      it('should add multiple extra to a var', () => {
        let expected = [['text', 'Coucou '], ['var', 'myVar', 'hard', 'oulaHard', 'nope'], ['text', ':'], ['text', 'nope']]
        let result = mustache.parse('Coucou {{   myVar:hard:oulaHard:nope}}:nope')
        assert.deepStrictEqual(result, expected)
      })
    })

    it('should tokenize an include', () => {
      let expected = [['text', 'coucou '], ['include', 'getCard', []], ['text', ' nope']]
      let result = mustache.parse('coucou {-> getCard <-} nope')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize an include with params', () => {
      let expected = [['text', 'coucou '], ['include', 'getCard', ['data.body.where']], ['text', ' nope']]
      let result = mustache.parse('coucou {-> getCard(data.body.where) <-} nope')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize an include with multiple params', () => {
      let expected = [['text', 'coucou '], ['include', 'getCard', ['data.body.where', 'data.test', 'data.here']], ['text', ' nope']]
      let result = mustache.parse('coucou {-> getCard(data.body.where, data.test    ,   data.here) <-} nope')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize a condition', () => {
      let expected = [['text', 'Coucou '], ['cond', 'data.id', [['text', ' my condition ']]]]
      let result = mustache.parse('Coucou {# data.id #} my condition {{#}}')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize a loop', () => {
      let expected = [['text', 'Coucou '], ['cond', 'data.id', [['text', ' my condition ']]]]
      let result = mustache.parse('Coucou {# data.id #} my condition {{#}}')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize constant PRINT', () => {
      let expected = [['text', 'Coucou '], ['const', 'print']]
      let result = mustache.parse('Coucou {$ PRINT $}')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize constant ORDER BY', () => {
      let expected = [['text', 'Coucou '], ['const', 'orderby']]
      let result = mustache.parse('Coucou {$    ORDER BY   $}')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize a loop in a loop', () => {
      let expected = [['text', 'Coucou '], ['loop', 'data.id', [['loop', 'data.id2', [['text', 'Hello']]]]]]
      let result = mustache.parse('Coucou {% data.id %}{% data.id2 %}Hello{{%}}{{%}}')
      assert.deepStrictEqual(result, expected)
    })

    it('should tokenize a cond in a cond', () => {
      let expected = [['text', 'Coucou '], ['cond', 'data.id', [['cond', 'data.id2', [['text', 'Hello']]]]]]
      let result = mustache.parse('Coucou {# data.id #}{# data.id2 #}Hello{{#}}{{#}}')
      assert.deepStrictEqual(result, expected)
    })

    it('should return tokens with loop, condition and variable', () => {
      let expected = [
        ['text', 'INSERT INTO '],
        ['var', 'data.tableName'],
        ['text', ' ('],
        ['loop', 'data.columns', [
          ['var', 'data.columns[i]'],
          ['cond', 'data.columns[i+1]!==undefined', [
            ['text', ',']
          ]]
        ]],
        ['text', ' WHERE '],
        ['cond', 'data.id', [
          ['text', 'id='],
          ['var', 'data.id']
        ]]
      ]
      let result = mustache.parse('INSERT INTO {{ data.tableName }} ({% data.columns %}{{data.columns[i]}}{#data.columns[i+1]!==undefined#},{{#}}{{%}} WHERE {# data.id #}id={{data.id}}{{#}}')
      assert.deepStrictEqual(result, expected)
    })

    it('should return tokens for two conditions', () => {
      let expected = [['cond', 'data.age >= 18', [
        ['text', 'Je suis majeur, '],
        ['var', 'data.age'],
        ['text', ' ans']]],
      ['cond', 'data.age < 18', [
        ['text', 'Je suis mineur, '],
        ['var', 'data.age'],
        ['text', ' ans']]]
      ]
      let result = mustache.parse('{# data.age >= 18 #}Je suis majeur, {{ data.age }} ans{{#}}{# data.age < 18 #}Je suis mineur, {{ data.age }} ans{{#}}')
      assert.deepStrictEqual(result, expected)
    })

    describe('Errors', () => {
      it('should throw an error when no extra are passed to a variable', () => {
        const func = () => mustache.parse('Coucou {{ myVar: }}')
        assert.throws(func, Error)
      })

      it('should throw an error when bad closing tag', () => {
        const func = () => mustache.parse('Coucou {{ myVar %}')
        assert.throws(func, SyntaxError)
      })

      it('should throw an error when bad closing tag 2', () => {
        const func = () => mustache.parse('Coucou {% myVar }}')
        assert.throws(func, SyntaxError)
      })

      it('should throw an error when bad closing tag 3', () => {
        const func = () => mustache.parse('Coucou {% myVar #}')
        assert.throws(func, SyntaxError)
      })

      it('should throw an error when bad closing tag 4', () => {
        const func = () => mustache.parse('Coucou {% myVar $}')
        assert.throws(func, SyntaxError)
      })

      it('should throw an error when bad closing tag 5', () => {
        const func = () => mustache.parse('Coucou {-> myVar $}')
        assert.throws(func, SyntaxError)
      })

      it('should throw an error when bad closing tag 6', () => {
        const func = () => mustache.parse('Coucou {{ myVar <-}')
        assert.throws(func, SyntaxError)
      })

      it('should throw an error when all variable are not closed', () => {
        const func = () => mustache.parse('Coucou {{ myVar')
        assert.throws(func, Error)
      })

      it('should throw an error when all constants are not closed', () => {
        const func = () => mustache.parse('Coucou {$ PRINT $} {$ orderby')
        assert.throws(func, Error)
      })

      it('should throw an error if all conditions are not closed', () => {
        const func = () => mustache.parse('Coucou {# first #} coucou {# second #} lala {{#}}')
        assert.throws(func, Error)
      })

      it('should throw an error if all loops are not closed', () => {
        const func = () => mustache.parse('Coucou {% first %} coucou {% second %} lala {{%}}')
        assert.throws(func, Error)
      })

      it('should throw an error if all includes are not closed', () => {
        const func = () => mustache.parse('Coucou {-> first <-} coucou {-> nope')
        assert.throws(func, Error)
      })

      describe('Can\'t open a variable if something else if open', () => {
        it('should throw an error when a variable is not closed and a new variable is being opening', () => {
          const func = () => mustache.parse('Coucou {{ myVar {{')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a condition is not closed and a new variable is being opening', () => {
          const func = () => mustache.parse('Coucou {# myVar {{')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a loop is not closed and a new variable is being opening', () => {
          const func = () => mustache.parse('Coucou {% myVar {{')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a constant is not closed and a new variable is being opening', () => {
          const func = () => mustache.parse('Coucou {$ PRINT {{')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when an include is not closed and a new variable is being opening', () => {
          const func = () => mustache.parse('Coucou {-> PRINT {{')
          assert.throws(func, SyntaxError)
        })
      })

      describe('Can\'t open a condition if something else if open', () => {
        it('should throw an error when a variable is not closed and a new condition is being opening', () => {
          const func = () => mustache.parse('Coucou {{ myVar {#')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a condition is not closed and a new condition is being opening', () => {
          const func = () => mustache.parse('Coucou {# myVar {#')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a loop is not closed and a new condition is being opening', () => {
          const func = () => mustache.parse('Coucou {% myVar {#')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a constant is not closed and a new condition is being opening', () => {
          const func = () => mustache.parse('Coucou {$ ORDER BY {#')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when an include is not closed and a new condition is being opening', () => {
          const func = () => mustache.parse('Coucou {-> ORDER BY {#')
          assert.throws(func, SyntaxError)
        })
      })

      describe('Can\'t open a loop if something else if open', () => {
        it('should throw an error when a variable is not closed and a new loop is being opening', () => {
          const func = () => mustache.parse('Coucou {{ myVar {%')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a condition is not closed and a new loop is being opening', () => {
          const func = () => mustache.parse('Coucou {# myVar {%')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a loop is not closed and a new loop is being opening', () => {
          const func = () => mustache.parse('Coucou {% myVar {%')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a constant is not closed and a new loop is being opening', () => {
          const func = () => mustache.parse('Coucou {$ PRINT {%')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when an include is not closed and a new loop is being opening', () => {
          const func = () => mustache.parse('Coucou {-> PRINT {%')
          assert.throws(func, SyntaxError)
        })
      })

      describe('Can\'t open a constant if something else if open', () => {
        it('should throw an error when a variable is not closed and a new constant is being opening', () => {
          const func = () => mustache.parse('Coucou {{ myVar {$')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a condition is not closed and a new constant is being opening', () => {
          const func = () => mustache.parse('Coucou {# myVar {$')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a loop is not closed and a new constant is being opening', () => {
          const func = () => mustache.parse('Coucou {% myVar {$')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a constant is not closed and a new constant is being opening', () => {
          const func = () => mustache.parse('Coucou {$ PRINT {$')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when an include is not closed and a new constant is being opening', () => {
          const func = () => mustache.parse('Coucou {-> PRINT {$')
          assert.throws(func, SyntaxError)
        })
      })

      describe('Can\'t open an include if something else if open', () => {
        it('should throw an error when a variable is not closed and an include is being opening', () => {
          const func = () => mustache.parse('Coucou {{ myVar {->')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a condition is not closed and an include is being opening', () => {
          const func = () => mustache.parse('Coucou {# myVar {->')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a loop is not closed and an include is being opening', () => {
          const func = () => mustache.parse('Coucou {% myVar {->')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a constant is not closed and an include is being opening', () => {
          const func = () => mustache.parse('Coucou {$ PRINT {->')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when an include is not closed and an include is being opening', () => {
          const func = () => mustache.parse('Coucou {-> PRINT {->')
          assert.throws(func, SyntaxError)
        })
      })

      describe('Check a tag has been open when a closing tag is encountered', () => {
        it('should throw an error when a var closing tag is encountered and not opening', () => {
          const func = () => mustache.parse('Coucou }}')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a loop closing tag is encountered and not opening', () => {
          const func = () => mustache.parse('Coucou %}')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a cond closing tag is encountered and not opening', () => {
          const func = () => mustache.parse('Coucou #}')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when a constant closing tag is encountered and not opening', () => {
          const func = () => mustache.parse('Coucou $}')
          assert.throws(func, SyntaxError)
        })

        it('should throw an error when an include closing tag is encountered and not opening', () => {
          const func = () => mustache.parse('Coucou <-}')
          assert.throws(func, SyntaxError)
        })
      })
    })
  })

  describe('Create indexes', () => {
    it('should return an empty string', () => {
      let string = mustache._createIndexes([])
      assert.strictEqual(string, '')
    })

    it('should return i', () => {
      let string = mustache._createIndexes([2])
      assert.strictEqual(string, 'let i = 2; ')
    })

    it('should return i and j', () => {
      let string = mustache._createIndexes([2, 1])
      assert.strictEqual(string, 'let i = 2; let j = 1; ')
    })

    it('should return i, j and k', () => {
      let string = mustache._createIndexes([0, 1, 2])
      assert.strictEqual(string, 'let i = 0; let j = 1; let k = 2; ')
    })
  })

  describe('Split params', () => {
    it('should return an array of params', () => {
      let expected = { name: 'getCard', params: ['req.body.where', 'req.body', 'req.test'] }
      let result = mustache._splitFunctionParams('getCard(req.body.where, req.body, req.test)')
      assert.deepStrictEqual(result, expected)
    })

    it('should return an array of params with spaces', () => {
      let expected = { name: 'getCard', params: ['req.body.where', 'req.body', 'req.test'] }
      let result = mustache._splitFunctionParams('    getCard     (        req.body.where       ,   req.body      ,req.test   )')
      assert.deepStrictEqual(result, expected)
    })

    it('should return an empty array if no params are passed', () => {
      let expected = { name: 'getCard', params: [] }
      let result = mustache._splitFunctionParams('getCard()')
      assert.deepStrictEqual(result, expected)
    })

    it('should return an empty array if no parenthesis exists', () => {
      let expected = { name: 'getCard', params: [] }
      let result = mustache._splitFunctionParams('getCard')
      assert.deepStrictEqual(result, expected)
    })

    it('should return an array of params with spaces', () => {
      const func = () => mustache._splitFunctionParams('getCard(req.body, )')
      assert.throws(func, SyntaxError)
    })

    it('should throw an error if value has a bad syntax', () => {
      const func = () => mustache._splitFunctionParams('getCard)req.body, (')
      assert.throws(func, SyntaxError)
    })
  })

  describe('Render', () => {
    it('should render simple variables', (done) => {
      let data = {
        firstname: 'John',
        lastname: 'Doe'
      }
      mustache.render('Coucou {{ data.firstname }} {{ data.lastname }}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)
        let expected = {
          string: 'Coucou $1 $2',
          data: ['John', 'Doe']
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    it('should render constant', (done) => {
      let data = {
        firstname: 'John',
        lastname: 'Doe'
      }
      mustache.render('{$ PRINT $}Coucou {{ data.firstname }} {{ data.lastname }}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)

        let expected = {
          print: true,
          string: 'Coucou $1 $2',
          data: ['John', 'Doe']
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    it('should not crash if same constant is render multiple times', (done) => {
      let data = {
        firstname: 'John'
      }
      mustache.render('{$ PRINT $}Coucou {{ data.firstname }}{$PRINT$}{$    PRINT   $}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)
        let expected = {
          print: true,
          string: 'Coucou $1',
          data: ['John']
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    it('should render a condition', (done) => {
      let data = {
        age: 18
      }
      mustache.render('{# data.age >= 18 #}Je suis {$PRINT$}majeur, {{ data.age }} ans{{#}}{# data.age < 18 #}Je suis mineur, {{ data.age }} ans{{#}}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)
        let expected = {
          print: true,
          string: 'Je suis majeur, $1 ans',
          data: [18]
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    describe('Render includes', () => {
      beforeEach(() => {
        fsMock.mock({
          'test/datasets': {
            'getCard.sql': 'Hello, Im {{ data.age }}',
            'loopInclude.sql': '{% data.names[i].values %} v: {{ data.names[i].values[j] }} {{%}}',
            'params.sql': 'Params: {{ data.parameters[0] }}, {{ data.parameters[1] }}, {{ data.parameters[2] }}',
            'include.sql': 'Second include: {-> params(data.parameters[0], 1, data.parameters[1]) <-} {{ data.parameters[0] }}'
          }
        })
      })

      afterEach(() => {
        fsMock.restore()
      })

      it('should render multiple includes', (done) => {
        let sqlFiles = {
          params: path.join(__dirname, 'datasets', 'params.sql'),
          include: path.join(__dirname, 'datasets', 'include.sql')
        }
        let data = {
          firstname: 'toto',
          lastname: 'dupont',
          age: 18
        }
        mustache.render('{{ data.age }} {-> include(data.firstname, data.lastname) <-}', data, {}, sqlFiles, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 Second include: Params: $2, $3, $4 $5',
            data: [18, 'toto', 1, 'dupont', 'toto']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render an include', (done) => {
        let sqlFiles = {
          getCard: path.join(__dirname, 'datasets', 'getCard.sql')
        }
        let data = {
          firstname: 'toto',
          lastname: 'dupont',
          age: 18
        }
        mustache.render('{{ data.firstname }} {{ data.lastname }} {-> getCard <-}', data, {}, sqlFiles, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 $2 Hello, Im $3',
            data: ['toto', 'dupont', 18]
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render an include with empty parenthesis', (done) => {
        let sqlFiles = {
          getCard: path.join(__dirname, 'datasets', 'getCard.sql')
        }
        let data = {
          firstname: 'toto',
          lastname: 'dupont',
          age: 18
        }
        mustache.render('{{ data.firstname }} {{ data.lastname }} {-> getCard() <-}', data, {}, sqlFiles, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 $2 Hello, Im $3',
            data: ['toto', 'dupont', 18]
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render an include with params', (done) => {
        let sqlFiles = {
          params: path.join(__dirname, 'datasets', 'params.sql')
        }
        let data = {
          firstname: 'toto',
          lastname: 'dupont',
          age: 18,
          size: 180,
          pseudo: 'Dobby'
        }
        mustache.render('{{ data.firstname }} {{ data.lastname }} {-> params(data.age, data.size, data.pseudo) <-}', data, {}, sqlFiles, (err, result) => {
          assert.strictEqual(err, null)
          delete result.varIndex
          delete result.loopIndexes
          let expected = {
            string: '$1 $2 Params: $3, $4, $5',
            data: ['toto', 'dupont', 18, 180, 'Dobby']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render multiple include', (done) => {
        let sqlFiles = {
          getCard: path.join(__dirname, 'datasets', 'getCard.sql')
        }
        let data = {
          firstname: 'toto',
          lastname: 'dupont',
          age: 18
        }
        mustache.render('{-> getCard <-} {-> getCard <-} {-> getCard <-}', data, {}, sqlFiles, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: 'Hello, Im $1 Hello, Im $2 Hello, Im $3',
            data: [18, 18, 18]
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render multiple include', (done) => {
        let sqlFiles = {
          getCard: path.join(__dirname, 'datasets', 'getCard.sql')
        }
        let data = {
          firstname: 'toto',
          lastname: 'dupont',
          age: 18
        }
        mustache.render('{{ data.firstname }} {-> getCard <-} {{ data.firstname }} {-> getCard <-} {{ data.firstname }}', data, {}, sqlFiles, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 Hello, Im $2 $3 Hello, Im $4 $5',
            data: ['toto', 18, 'toto', 18, 'toto']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render include with loops', (done) => {
        let sqlFiles = {
          loopInclude: path.join(__dirname, 'datasets', 'loopInclude.sql')
        }
        let data = {
          names: [{
            name: 'toto',
            values: [1, 2, 3]
          }, {
            name: 'tata',
            values: [4, 5, 6]
          }, {
            name: 'titi',
            values: [7, 8, 9]
          }]
        }
        mustache.render('{% data.names %} name: {{ data.names[i].name }} {-> loopInclude <-} {{%}}', data, {}, sqlFiles, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: ' name: $1  v: $2  v: $3  v: $4   name: $5  v: $6  v: $7  v: $8   name: $9  v: $10  v: $11  v: $12  ',
            data: ['toto', 1, 2, 3, 'tata', 4, 5, 6, 'titi', 7, 8, 9]
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })
    })

    it('should render a loop', (done) => {
      let data = {
        names: [
          'John',
          'Max',
          'Cre'
        ]
      }
      mustache.render('{% data.names %} * {{ data.names[i] }}{$PRINT$}{{%}}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)
        let expected = {
          print: true,
          string: ' * $1 * $2 * $3',
          data: ['John', 'Max', 'Cre']
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    it('should render a loop with condition', (done) => {
      let data = {
        names: [
          'John',
          'Max',
          'Cre'
        ]
      }
      mustache.render('{% data.names %}{{ data.names[i] }}{# data.names[i+1] !== undefined #}, {{#}}{{%}}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)
        let expected = {
          string: '$1, $2, $3',
          data: ['John', 'Max', 'Cre']
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    it('should render a loop in a loop', (done) => {
      let data = {
        persons: [{
          age: 18,
          names: ['Cre', 'Patrick']
        }, {
          age: 16,
          names: ['John', 'Leo']
        }]
      }
      mustache.render('{% data.persons %}{{ data.persons[i].age }} |{% data.persons[i].names %} {{ data.persons[i].names[j] }}{{%}}{{%}}', data, (err, result) => {
        delete result.varIndex
        delete result.loopIndexes
        assert.strictEqual(err, null)
        let expected = {
          string: '$1 | $2 $3$4 | $5 $6',
          data: [18, 'Cre', 'Patrick', 16, 'John', 'Leo']
        }
        assert.deepStrictEqual(result, expected)
        done()
      })
    })

    describe('Hard replace', () => {
      it('should replace data directly', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe'
        }
        mustache.render('{{ data.firstname:hard }} {{ data.lastname:hard }}', data, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: 'John Doe',
            data: []
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should replace data directly only with hard extra token', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe'
        }
        mustache.render('{{ data.firstname:hard }} {{ data.lastname }}', data, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: 'John $1',
            data: ['Doe']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      // SECURITY: `:hard` pastes its value straight into the SQL text, and the
      // template `data` is the live request object, so an arbitrary value would
      // be SQL injection. It is restricted to safe SQL identifiers / ORDER BY
      // terms; anything else is rejected before the SQL is built.
      it('should accept genuine identifiers and ORDER BY terms', () => {
        const _ok = [
          'id', 'my_table', 'MixedCase', '_leading', 'a1', 'schema.table',
          'schema.table.column', 'name ASC', 'name DESC', 'name desc',
          'created_at DESC NULLS LAST', 'a, b, c', 'first ASC, second DESC',
          '1', '1 DESC', 42, '  spaced  '
        ]

        for (const _value of _ok) {
          assert.strictEqual(mustache._isSafeHardValue(_value), true, `should accept ${JSON.stringify(_value)}`)
        }
      })

      it('should reject every injection shape', () => {
        const _bad = [
          'version()', 'now()', "name'; DROP TABLE users; --", '1; DROP TABLE users',
          '1 OR 1=1', '1=1', 'a UNION SELECT b', 'a/**/b', 'a--b', '"quoted"',
          "'literal'", 'a;b', 'a(b)', 'a[b]', 'a|b', 'a b', 'a\nb', 'name ASC; DELETE',
          '', '   ', ',', 'a,', ',a', 'a,,b', 'name ASCII', 'name FOO',
          true, false, null, undefined, {}, [], ['id'], 42.5, 'x'.repeat(257)
        ]

        for (const _value of _bad) {
          assert.strictEqual(mustache._isSafeHardValue(_value), false, `should reject ${JSON.stringify(_value)}`)
        }
      })

      it('should reject an injection payload passed through :hard at render time', (done) => {
        mustache.render('SELECT {{ data.p:hard }}', { p: 'version()' }, (err, result) => {
          assert.notStrictEqual(err, null, 'an injectable :hard value must be rejected')
          assert.strictEqual(/not a valid SQL identifier/.test(err.toString()), true, err && err.toString())
          assert.strictEqual(result, undefined, 'no SQL is produced for a rejected value')
          done()
        })
      })

      it('should still paste a legitimate multi-column ORDER BY', (done) => {
        mustache.render('SELECT * FROM t ORDER BY {{ data.sort:hard }}', { sort: 'created_at DESC, id ASC' }, (err, result) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(result.string, 'SELECT * FROM t ORDER BY created_at DESC, id ASC')
          assert.deepStrictEqual(result.data, [])
          done()
        })
      })

      it('should leave a plain {{ }} value bound, never validated as an identifier', (done) => {
        mustache.render('SELECT {{ data.p }}', { p: 'version()' }, (err, result) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(result.string, 'SELECT $1')
          assert.deepStrictEqual(result.data, ['version()'])
          done()
        })
      })
    })

    describe('Loop safety', () => {
      // SECURITY: the loop reads `<expr>` and builds an index array of its
      // length. The template `data` is the live request object, so a request
      // field {"items":{"length":1e9}} would drive the loop a billion times and
      // exhaust the heap (an uncatchable crash), and a non-array with a
      // `.length` would silently produce phantom rows. The source must be a real
      // array; a genuine array stays bounded by the upstream body-size limit.

      /**
       * Render a loop template over the given attacker payload
       * @param {*} items Value placed at data.items
       * @param {Function} cb (err, result)
       */
      function renderLoop (items, cb) {
        mustache.render('{% data.items %}x{{%}}', { items: items }, (err, result) => cb(err, result))
      }

      it('should reject a non-array object with a forged .length (type confusion)', (done) => {
        renderLoop({ length: 7 }, (err, result) => {
          assert.notStrictEqual(err, null, 'a non-array loop source must be rejected')
          assert.strictEqual(/must be an array/.test(err.toString()), true, err && err.toString())
          done()
        })
      })

      it('should reject a huge forged .length before allocating anything', (done) => {
        renderLoop({ length: 1e9 }, (err, result) => {
          assert.notStrictEqual(err, null, 'a forged billion-length must be rejected instantly')
          assert.strictEqual(result, undefined)
          done()
        })
      })

      it('should still loop over a real array', (done) => {
        renderLoop(new Array(500).fill(0), (err, result) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(result.string.length, 500)
          done()
        })
      })

      it('should loop zero times over an empty array', (done) => {
        renderLoop([], (err, result) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(result.string, '')
          done()
        })
      })

      it('should still report the original error for a missing loop source', (done) => {
        renderLoop(undefined, (err, result) => {
          assert.notStrictEqual(err, null)
          assert.strictEqual(/is undefined/.test(err.toString()), true, err && err.toString())
          done()
        })
      })
    })

    describe('Eval boundary', () => {
      // A template is a trust boundary, by design: expressions are resolved with
      // eval() in the module closure, so a template that an attacker could
      // author would be RCE. On shipped paths templates are developer-authored
      // and only request DATA (never the template text) is attacker-controlled,
      // and that data flows in as bound $N parameters. These tests pin both
      // halves so a regression is visible.

      it('should resolve template expressions with host scope (templates are code)', (done) => {
        // If the engine is ever hardened to resolve paths without eval, flip
        // this to assert the globals are NOT reachable.
        mustache.render('{{ process.pid }}|{{ typeof require }}', {}, (err, result) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(result.data[0], process.pid, 'process reachable from template eval')
          assert.strictEqual(result.data[1], 'function', 'require reachable from template eval')
          done()
        })
      })

      it('should bind request-supplied values as parameters, never execute them', (done) => {
        // The attacker controls the DATA, not the template: a value that looks
        // like code becomes a $N placeholder, pushed verbatim into the param
        // array — Postgres never parses it as SQL.
        mustache.render('SELECT {{ data.evil }}', { evil: "'); DROP TABLE users; --" }, (err, result) => {
          assert.strictEqual(err, null, err && err.toString())
          assert.strictEqual(result.string, 'SELECT $1', 'the value is parameterized, not concatenated')
          assert.strictEqual(result.data[0], "'); DROP TABLE users; --", 'and passed verbatim as a bound param')
          done()
        })
      })
    })

    describe('Print', () => {
      it('should return print = true', (done) => {
        mustache.render('Coucou {$ PRINT $}', {}, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          assert.deepStrictEqual(result, {
            print: true,
            string: 'Coucou ',
            data: []
          })
          done()
        })
      })

      it('should return print = true', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe',
          where: true,
          id: 2
        }
        mustache.render('{$ PRINT $}SELECT{{ data.firstname}}::text as "firstname",{{ data.lastname}}::text as "lastname"{# data.where #}WHERE 1 = {{ data.id }}{{#}}', data, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          assert.deepStrictEqual(result, {
            string: 'SELECT$1::text as "firstname",$2::text as "lastname"WHERE 1 = $3',
            print: true,
            data: ['John', 'Doe', 2]
          })
          done()
        })
      })

      it('should return print = true', (done) => {
        let data = {
          lines: ['one', 'two', 'three']
        }
        mustache.render('{$ PRINT $}{% data.lines %}{{data.lines[i]}}{{%}}', data, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          assert.deepStrictEqual(result, {
            string: '$1$2$3',
            print: true,
            data: ['one', 'two', 'three']
          })
          done()
        })
      })
    })

    describe('Order by', () => {
      it('should render order by with model PK', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe'
        }
        let model = ['array', {
          id: ['<<idAccount>>'],
          users: ['array', {
            id: ['<<idUser>>']
          }]
        }]
        mustache.render('{{ data.firstname }} {{ data.lastname }}{$  ORDER BY $}', data, model, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 $2ORDER BY "idAccount", "idUser"',
            data: ['John', 'Doe']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should ignore order by if model is undefined', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe'
        }
        mustache.render('{{ data.firstname }} {{ data.lastname }}{$  ORDER BY $}', data, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 $2',
            data: ['John', 'Doe']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should ignore order by if there is no PK', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe'
        }
        let model = ['object', {
          firstname: ['<firstname>'],
          lastname: ['<lastname>']
        }]
        mustache.render('{{ data.firstname }} {{ data.lastname }}{$  ORDER BY $}', data, model, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: '$1 $2',
            data: ['John', 'Doe']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })

      it('should render order by at the right place', (done) => {
        let data = {
          firstname: 'John',
          lastname: 'Doe'
        }
        let model = ['array', {
          id: ['<<idAccount>>'],
          users: ['array', {
            id: ['<<idUser>>']
          }]
        }]
        mustache.render('lala{{ data.firstname }} {$  ORDER BY  $} {{ data.lastname }}lala', data, model, (err, result) => {
          delete result.varIndex
          delete result.loopIndexes
          assert.strictEqual(err, null)
          let expected = {
            string: 'lala$1 ORDER BY "idAccount", "idUser" $2lala',
            data: ['John', 'Doe']
          }
          assert.deepStrictEqual(result, expected)
          done()
        })
      })
    })

    describe('Errors', () => {
      it('should throw an error when extra is unknown', (done) => {
        let data = {
          name: 'John'
        }
        mustache.render('Coucou {{ name:oups }}', data, (err) => {
          assert.notStrictEqual(err, null)
          done()
        })
      })

      it('should throw an error when eval of a variable does not work', (done) => {
        let data = {
          name: 'John'
        }
        mustache.render('Coucou {{ name }}', data, (err) => {
          assert.notStrictEqual(err, null)
          done()
        })
      })

      it('should throw an error when eval of a bad array does not work', (done) => {
        let data = {
          names: 4
        }
        mustache.render('Coucou {% data.names %}{{%}}', data, (err) => {
          assert.notStrictEqual(err, null)
          done()
        })
      })

      it('should throw an error when eval of a bad conditions does not work', (done) => {
        let data = {
          names: 4
        }
        mustache.render('Coucou {# koko < kiki #}{{#}}', data, (err) => {
          assert.notStrictEqual(err, null)
          done()
        })
      })
    })
  })
})
