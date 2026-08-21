const neostandard = require('neostandard')

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'docs/**',
      'coverage/**',
      // Fixture applications: they are data for the test suite, not source
      'test/datasets/**'
    ]
  },
  ...neostandard({
    noStyle: true // keep the linter focused on real problems, not formatting
  }),
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly'
      }
    },
    rules: {
      // The SQL template engine evaluates template expressions on purpose
      'no-eval': 'off',
      // The codebase consistently uses `let` and long-form properties. Enforcing
      // these would rewrite every file for no behavioural gain, so the linter is
      // kept on the rules that catch real problems.
      'prefer-const': 'off',
      'object-shorthand': 'off',
      'no-var': 'off',
      'no-unneeded-ternary': 'off',
      // `set headers` is part of the TestClient public API and has no getter
      'accessor-pairs': 'off'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    }
  }
]
