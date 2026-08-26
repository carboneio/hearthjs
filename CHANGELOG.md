# HearthJS

### v5.0.0

Requires **Node >= 26**. The suite runs on Node 26 in CI.

#### 🚨 Breaking changes

**1. `request` replaced by [`rock-req`](https://github.com/carboneio/rock-req)**

`hearthjs.httpClient` is unchanged. Only direct `require('request')` calls move:

```js
const rock = require('rock-req')
rock.get({ url }, (err, res, body) => { /* body is a Buffer */ })
rock.postJSON({ url }, payload, cb)
rock.delete({ url }, cb)
```

No multipart support: build the body and send it as a buffer (see `test/helpers/multipart.js`).

**2. `node-cron` 2.x -> 4.x** — only code reaching the task object changes:

```js
_cronList['myCron'].cron.status      // before: 'scheduled' | 'stoped' | undefined
_cronList['myCron'].cron.getStatus() // after:  'idle' | 'running' | 'stopped' | 'destroyed'
```

**3. express replaced by restana + `lib/expressCompat.js`** — application code is unchanged: `res.status/send/json/sendStatus/set/get/type/location/redirect/cookie/sendFile/locals` and `req.get/accepts*/is/path/protocol/secure/hostname/fresh/stale/query` are all provided, `ETag` and `304` included. `hearthjs.express` still returns `json()`, `urlencoded()`, `raw()`, `text()` and `static()`.

Two deliberate differences, both safer: `X-Forwarded-*` is ignored unless `APP_TRUST_PROXY` is true (a client could otherwise spoof `req.protocol`), and `res.redirect()` no longer emits a clickable `<a href>`.

**4. `socket.io` and `mocha` are now optional peer dependencies** — `npm install socket.io` if you set `startSocketServer: true`, `mocha` if you use `hearthjs test`. Together they were 8.7 MB shipped to every deployment.

**5. Translations removed** — `lib/translate.js`, the `t`/`tr` exports, the `translate` CLI, `server/lang`, `APP_SERVER_LANG` and the `getLang(req)` hook. `api.createResponse` returns `message` verbatim, which is what `tr()` already did without lang files.

**6. Clustering removed** — `APP_NB_CLUSTER`, `--cluster` and the whole worker/leader machinery. Run several instances behind your reverse proxy instead, which also gives independent restarts. `server.close(signal, cb)` still accepts a signal, now ignored.

**7. The extern API is removed** — `hearthjs.useApi(api, prefix)` and its `initDatabase` entry point. Use `hearthjs.api.define` in `server/api/**/api.*.js`.

**8. `moment` and the `assert` package are no longer installed** — neither was used. `require('assert')` still resolves to the Node built-in.

**9. `commander` 6.x -> 14.x** — CLI internals only, the commands are unchanged.

**10. One compact log line per request**, level following the status code:

```
08-21-2026 13:16:40 WARN  POST /api/webhooks/stripe 400 899ms
08-21-2026 13:16:42 ERROR POST /api/render 500 1.20s account=4821 template="invoice.odt"
```

Halves the log volume. `req.hearth_uid` and `req.hearth_start` are still set. Attach context with `req.hearth_log = {...}`, or once for every route with a `getLogContext(req)` export in `server/index.js`. `APP_LOG_REQUEST_START=true` restores the "started" line (with the id, to pair them).

**11. The startup banner reports what is actually running.** It used to print the query timeout, the mode, the database and the port. It now answers the questions an incident starts with:

```
hearthjs 5.0.0 · node v26.7.0 · pid 744637 · env PRODUCTION
  listening  0.0.0.0:80
  database   carbone_account_v2@127.0.0.1:5432 · statement timeout 10s
  loaded     14 apis · 132 routes · 3 crons · 2 addons
  timeouts   request 60s · shutdown 10s
  logs       /srv/app/server/logs/08-23-2026.log · output both
  ready      412ms
```

The version and pid tie a running process to a build, `loaded` catches an API or a cron that silently failed to register, and `ready in` catches a startup that is slowly getting worse. It also warns about the settings that only hurt once the server is already in trouble: logs not reaching journald in production, a disabled request timeout, and graceful shutdown turned off.

**12. One setting for the log destinations (`APP_LOG_OUTPUT`)** — in production hearthjs wrote nothing to stdout, so `journalctl` showed no application logs at all, and the file could not be turned off at all, which a read only container filesystem cannot accept.

| `APP_LOG_OUTPUT` | logs go to |
|------------------|------------|
| `file` (default) | the daily file in `server/logs`, nothing on stdout |
| `stdout` | stdout only, and no `logs` directory is created |
| `both` | the daily file and stdout |
| `none` | nowhere; one warning on stderr at startup says so |

Set it in the environment or in the project config file. Colours are dropped when stdout is not a terminal.

**13. Graceful shutdown** — `SIGTERM`/`SIGINT` used to drop in-flight requests and leak the PostgreSQL pool. hearthjs now stops the crons, stops accepting, marks draining answers `Connection: close`, closes idle keep-alive sockets, lets running requests finish, then closes the pool. `APP_SHUTDOWN_TIMEOUT` (default `10000` ms, `0` waits forever) caps it; a second signal exits immediately; `APP_GRACEFUL_SHUTDOWN=false` restores the old behaviour. `close()` is idempotent.

**14. Request timeout is 60 s** instead of node's 300 s default (`APP_REQUEST_TIMEOUT`, `0` restores it).

**15. Four unused exports removed.** None were called by hearthjs itself:

| removed | was |
|---------|-----|
| `api.matchRoute()` | the old route matcher, superseded by the restana router |
| `cron.getAction(name)` | returned a cron's function; read `_cronList[name].action` |
| `helper.assertTableOfObject()` | an order-insensitive array assertion for test suites |
| `helper.handlePromiseError()` | wrapped a promise into a `[err, data]` tuple |

#### 🔥 Performance

**SQL templates were quadratic in the number of rendered rows.** A template looping over a data array rebuilt its parameter accumulator with `concat` on every iteration, so building the `$1..$N` list cost O(n²). 100 000 items took
**9.0 s**, on its own more than a request timeout. Appending in place makes it linear: **533 ms**, 17x faster.

`converter.sqlToJson` was **quadratic** in the number of rows: finding the entity already built for a primary key rescanned the whole array for every row. It is now indexed, and linear. This is what made large exports time out.

| rows    | before    | after  | speed-up |
|---------|-----------|--------|----------|
| 32 000  | 4 604 ms  | 99 ms  | 47x      |
| 64 000  | 18 801 ms | 208 ms | 91x      |
| 128 000 | 76 050 ms | 390 ms | **195x** |

- SQL files are no longer re-read and re-tokenized on every query: the parsed template is cached against the file mtime. **~40% faster** rendering.
- `converter.parseModel` no longer deep-clones through `JSON.parse(JSON.stringify())`: **~59% faster**.
- `validation` no longer rebuilds its rule tables and recompiles its regexes per field: **~21% faster**.
- Addons are resolved once per route at registration; routes without addons no longer pay for the middleware at all.
- restana instead of express: **+6.0% throughput**, the compatibility layer costing 1.5 us per request.
- The logger no longer reads `process.env` and rebuilds the timestamp on every request. `_mustLogOnStdout()` goes from **839 ns to 1.7 ns** and the formatted date is reused within the same second.
- A production install goes from **48.5 MB / 380 packages to 9.0 MB / 78 packages**.

#### 🔒 Security

- **A declaration that leaves an endpoint missing is now logged at `error`.** A duplicate API name, a duplicate route, a route declared without a schema and a schema that cannot be found all warned quietly while the endpoint silently did not exist. They are startup only, so there is no risk of flooding the log. A second, unreachable duplicate route check was removed at the same time.
- **A refused request no longer leaks internals, and no longer looks like a fault.** Handlers refuse with `next('a message')` and report a fault with `next(new Error(...))`. Both were logged at `error` and both had their text returned verbatim, so deliberate 400s ("Wrong password", "Only an administrator can...") buried the real failures in the log, and an `Error` reaching a `before` or `after` handler sent its table names and file paths to the client. A string is now logged at `warn` and still passes through; an `Error` stays at `error` and, in production, answers `An error occured` unless marked `err.expose = true` — the same rule `_handleError` already applied, which these two paths bypassed by answering directly.

**0 known vulnerabilities**, down from **54** (6 critical, 30 high).

- **ReDoS in the `url` validator.** `http://` + 120 characters + `!` kept the event loop busy **196 seconds** — one unauthenticated request froze a server. Now parsed with `URL`: **0.02 ms**. Private ranges are still refused.
- **Code injection in `api._addRoute`.** The per-route middleware was built by concatenating names into a string passed to `new Function()`. It is a closure now.
- **Error messages leaked internals** — table names and absolute paths were returned verbatim. Production now answers `An error occured` and logs the detail. `next('a string')` and `err.expose = true` still pass through.
- **Names colliding with `Object.prototype`.** A column named `constructor` broke the row mapper and `db.exec('toString')` killed the process. The lookup objects have a null prototype now.
- **A header holding a newline** threw `ERR_INVALID_CHAR` from a callback. Dropped and logged instead. Nothing was injectable either way.
- **`SET statement_timeout` and `TRUNCATE` built as strings** — the timeout is forced to an integer, and `datasets.clean()` doubles quotes in table names.
- `APP_SECURITY_HEADERS=true` adds `nosniff`, `X-Frame-Options` and HSTS. Off by default, since an application's own headers must win.

Injection, denial of service, disclosure, traversal, pollution, smuggling and path confusion were each tried against the framework over three rounds. Verified as not vulnerable: SQL templating binds `{{ }}` as parameters, prototype pollution is stripped from both query string and body, `sendFile` refuses `../`, the other validators do not backtrack, cookies serialize byte for byte like express, `qs` caps the query string at 1000 parameters, slowloris does not delay a legitimate request, `Content-Length` + `Transfer-Encoding` is rejected with a `400`, and every path variant tried routes exactly as express does.

#### 💥 Crash vectors

- **A log file the process cannot write took the server down.** `fs.createWriteStream` had no `'error'` listener, and an `'error'` event with no listener throws where nothing catches it. A full disk, a read only filesystem or a log directory the process cannot write killed the process, at midnight when the new day's file is created. The logger now gives up on the file, reports once on stderr, and keeps serving.
- **A server error after startup called `run()` a second time.** The `EADDRINUSE` listener stayed attached once listening had succeeded, so any later `error` event re-entered the startup callback. It is swapped for one that logs, which also means the event still has a listener rather than throwing.

- **A typo in a schema name hung the server at startup, forever.** A route naming a schema that does not exist was counted in `_nbRouteDeclared` and then returned early, so it was never served and `_nbRouteServed` could never catch up. Startup polls that pair to decide the API is ready, so `run()` simply never called back, with a single `warn` to show for it. The schema is now looked up before the route is counted, and readiness is re-evaluated on every declaration failure.

Nineteen common Node failure modes were reproduced against the framework. Seven took the whole process down; all seven report instead. `test/crashSafety.js` keeps them from coming back.

- **Answering twice** threw `ERR_HTTP_HEADERS_SENT` where nothing caught it.
- **An unserializable body** (circular, `BigInt`) threw from `res.json()`, normally called inside a database callback. Answers `500` now.
- **`EADDRINUSE`** is reported through an event, so a restart before the old process released the port was a silent crash loop. It reaches the `run()` callback now.
- **A project file that does not parse** (cron, `api.*.js`, `index.js`) threw from a callback; it is a startup error naming the file now.
- **A migration without a stored down script** read `rows[0].down` on an empty result.
- **Logging before the server started** threw, and the day-rollover branch could recurse into itself.
- **Async `before`/`after` handlers and addon hooks** produced unhandled rejections, which **terminate the process on Node >= 15**. They answer an error now, and a handler rejecting after `next()` cannot answer twice.

#### 🐛 Fixes

- **An express middleware's status code is honoured.** hearthjs read the response status from `err.code`, which only its own handlers set. Middlewares following the express convention use `err.status` / `err.statusCode`, so `express.json({ limit })` rejecting an oversized body answered **400** where express answers **413**. Both are read now, `err.code` still winning where hearthjs sets it. A status node would refuse (below 100, above 999, or not an integer) is ignored rather than passed to `res.end()`, which raises `ERR_HTTP_INVALID_STATUS_CODE` from a place nothing catches. As in express, `err.status` and `err.statusCode` are only trusted inside the 400-599 range; hearthjs still answers **400** by default where express answers 500.

- **`hearthjs test -s` no longer watches the project.** The runner started the file watcher unconditionally, and its callback reloads the server in process: `server.close()` wipes the SQL registry, so a poll landing mid-suite failed whatever test was in flight with `Unknow SQL file`. `-s` runs the suite once and exits, so there is nothing to watch for. Reproduced deterministically by touching a watched `.sql` file mid-run: 2 tests failed before, 40 pass after.
- The watcher compares `stat.mtimeMs` rounded to the millisecond rather than building a `Date` on every poll of every watched file. Same granularity, no allocation.

- **Route params are decoded again.** express ran every captured param through `decodeURIComponent`; the new router does not, so `/client/https%3A%2F%2F...` reached the handler still encoded. Parity is restored, and it follows express exactly: only `req.params` is decoded, never `req.url`, `req.path` or the query string. Routing still matches the raw path, which is what keeps an encoded `%2F` inside a single `:param` segment instead of splitting it. A malformed escape (`%foobar`, `100%`) answers **400** rather than passing the raw value through, and decoding happens exactly once, so a double encoded `%252e%252e%252f` stays inert instead of becoming `../`. Costs 22 ns per request when no value holds an escape.

If you worked around this in application code, **remove the workaround**: decoding a value twice is exactly the bypass the single decode is there to prevent.

- `helper.genericQueue` threw `Maximum call stack size exceeded` when the handler called `next()` synchronously, crashing at about 4 400 items. 200 000 items now run in a few milliseconds. It also no longer empties the array it is given.
- A comparison rule reads a string by length but a number by value, and the operator alone cannot tell them apart — so `['<', 50]` rejected the 3-character string `'123'`. A `type` rule now decides: `['type', 'string', '<', 50]` always means length. Without one the previous guess is kept, so `['>=', 18]` on the string `'42'` still means the value. New types: `string`, `number`, `integer`, `boolean`.
- A condition nested inside a loop in a SQL template is rendered on every iteration. It was emptied after the first turn, and only worked because the token tree was deep-cloned each time.
- The logged request duration ignored the seconds part of `process.hrtime`, so a 2.5 s request was reported as `500ms`.
- `mustache._readAllIncludes` was dead code with an inverted "file not found" check.
- The `fs.F_OK` deprecation warning printed on every start is gone.

#### 📦 Dependencies

| package         | before   | after    |
|-----------------|----------|----------|
| commander       | 6.2.0    | 14.0.2   |
| cookie-parser   | 1.4.6    | 1.4.7    |
| debug           | 4.1.1    | 4.4.3    |
| diff            | 4.0.1    | 9.0.0    |
| nanoid          | 2.1.1    | 3.3.18   |
| node-cron       | 2.0.3    | 4.6.0    |
| pg              | 8.4.2    | 8.23.0   |
| express         | 4.18.1   | *replaced by `restana` 6.0.1 + `lib/expressCompat.js`* |
| request         | 2.88.2   | *replaced by `rock-req` 5.2.1* |
| socket.io       | 4.5.3    | *optional peer dependency* |
| mocha           | 6.0.2    | *optional peer dependency* |
| moment          | 2.24.0   | *removed (unused)* |

Dev: `eslint` 5 -> 9 (+ `neostandard`), `sinon` 7 -> 22, `nyc` 14 -> 18, `multer` 1.4.4 -> 2.2.0, `mockdate` 2 -> 3. The abandoned `suppose` package (2015, two high severity advisories) was replaced by `test/helpers/suppose.js`.

**Deliberately held back**, so `npm outdated` does not read as neglect. All are on patched versions and `npm audit` reports nothing.

| package | held at | why |
|---------|---------|-----|
| `body-parser`, `serve-static`, `send`, `cookie`, `type-is`, `mime-types` | express 4 line | These are the versions express 4 ships, which is the parity the compatibility layer promises. `cookie` 2 renames its whole API, and `send` 1 answers `charset=UTF-8` where express answers `utf-8`. Node 26 lifts the engine constraint that also held `cookie` back, so only the parity argument remains. |
| `eslint` | 9 | 10 is only supported by a `neostandard` prerelease. |
| `express` (dev) | 4 | It is the reference the differential tests compare against. |
| `commander` | 14 | Held back when Node 20 was supported. `>=26` removes that blocker, so 15 is now upgradable. |
| `nanoid` | 3 | 4 and later are ESM only. Node 26 can `require()` an ESM module, so 4 and later are now upgradable. |

#### ✅ Tests & tooling

- **554 tests** (was 431), green on Node 26. Full run **38s -> 12s**.
- New suites: `expressCompat` (25 differential tests running the same handler on express and on restana), `gracefulShutdown`, `crashSafety`, `security`, `asyncSafety`, `performance` (guards the complexity of `sqlToJson`), plus `watch` and `socket`, which had no tests at all.
- The suite waits on conditions and events instead of sleeping, and stops test servers through the child process handle rather than `process.kill(pid)` — a recycled pid is how a run managed to terminate `npm` itself.
- `eslint.config.js` added: the project had ESLint dependencies but no committed configuration, so linting never ran.
- `.github/workflows/ci.yml` added: the suite on Node 26 against PostgreSQL 16, plus lint and `npm audit`. Actions pinned by commit SHA.
- `.mocharc.yml` added, with a 30 s timeout. The project had no mocha configuration, so every suite that talks to PostgreSQL was bounded by mocha's **2 s default** — fine locally, but a loaded CI runner blew through it and the timed out test's callbacks then ran on tables its own `after` hook had already dropped. Individual tests still raise it where they need to.


### v4.0.0
- 🔥 Improve performance of `sqlToJson` function. On big queries, the function could be really slow. Performance has been imrpoved up to 80% on tested queries (parsing going from 1.34s to 248ms)
- Add a new constant that can be used in SQL file (`PRINT_READY` which print the SQL request already filled with data)

### v3.1.0 - CARBONE FORK
- Update packages `express`, `cookie-parser` and `socket.io`

### v3.0.0
- Can start a socket server to send event to client
### v2.9.1
- Remove semi colon
- Fix authorization issue (https://github.com/Dobby85/hearthjs/pull/7)
### v2.9.0
- Dot not parse upload directory when launching test. When the upload directory is big, it tooks too much time to launch tests.
- Fix SQL request parameters bugs when including a SQL request in another SQL file.
- Expose validation file in index.js
- Stringify SQL parameters when printing request.
- Add `CASCADE` to clean `TRUNCATE` request (https://github.com/Dobby85/hearthjs/pull/6)
- `request` and `debug` are moved to dependencies instead of dev dependencies (https://github.com/Dobby85/hearthjs/pull/8 & https://github.com/Dobby85/hearthjs/pull/9)
- Init command create all directories with .gitkeep files (https://github.com/Dobby85/hearthjs/pull/10)
### v2.8.3
- Add `(` et `)` in translation regex
### v2.8.2
- Fix translate command to also fin tr tag
- Ignore the following directories while finding translations ('/uploads', '/migration', '/sql', '/config', '/datasets', '/logs')
- Return a 400 code when an error is returned
### v2.8.1
- Can return a specific status code in addon
### v2.8.0
- Can send index in include parameters for templating
- Can set default value for array and object

### v2.7.0
- Upgrade commander and pg package to be comaptible with node 14.15

### v2.6.5
- Can update status code in before/after callback

### v2.6.4
- Add auth token in cookie and in Authorization header

### v2.6.3
- Remove https server for prod environment

### v2.6.2
- Can set a lang key for all translations used in schema

### v2.6.1
- Can update listening port for HTTPS

### v2.6.0
- Run a HTTPS server when using `prod` environment.

### v2.5.1
- Add assertTableOfObject in helper

### v2.5.0
- Remove JSON parse middleware from hearthjs, now you have to set it in your **init function**.

### v2.4.3
- Add object type in converter to avoid duplicating object

### v2.4.2
- Fix bug in mustache when a loop was too big and results in a `maximum call stacks size exceeded`

### v2.4.1
- Don't display migration diff if file is too big

### v2.4.0
- Correct bugs
- Can add force and yes option to migrate command
- Improve converter

### v2.3.0
- Update returned result of database `exec` and `query` promise function, return an array now
- Can pass parameter to SQL includes

### v2.2.1
- Add a helper to handle async/await error

### v2.2.0
- Correct bugs with log file deletion
- Can call `exec` and `query` function of the database with promise
- Can access the env (test, dev or prod) with `hearthjs.env`
- Correct bugs

### v2.1.0
- Add the possibility to include SQL file in another SQL file
- Add genericQueue in helpers
- Log errors which are generated by the query key (SQL filename) of a schema
- Send `req` instead of `req.body` to SQL files
- Correct the `put` request in testClient

### v2.0.1
- Can access express from hearthjs module

### v2.0.0
- Add dynamic command

### v1.3.0
- Update commander version from 3.0.1 to 4.0.1
- Execute addons before middleware
- Rework CLI
- Fix bug when converting the result of a SQL request to a JSON object with date type
- Fix migration name which gave a bad order
- Add the possibility to update the header in client test request
- Fix bug which throws an error when a test failed usint client test request

### v1.2.0
- Watch following files when launching `./hearthjs test` command.
  - `/api/**/test/test.*.js`
  - `/api/**/api.*.js`
  - `/api/**/sql/*.sql`
  - `/test/test.*.js`
- Correct errors in documentation
- Data validation: Correct date type validation. Accet any valid date.
- `./hearthjs test` crash on first failed test
- translations: Check value is not empty. If the value is empty, the key is returned.
- Add http client for tests. It is possible to create instance of login user to execute authenticated request.

### v1.1.0
- Add init function (beforeInit, init and after init)
- Correct translations regex. Now it match space, `.`, `,`, `/`, `\`, `|`, `?`, `!`, `:`, `+`, `-`, `*`, `=`
- Improve test documentation
- Add documentation on server
- Data validation: type date accepts date object

### v1.0.1
- Update main in package.json

### v1.0.0
- Add first version of hearthjs
- Add Logger
- Add API declaration
- Add Database management
- Add Cron
- Add Translations
- Add Data mapping
- Add Data validation
- Add Documentation
- Add Addons
- Add Extern API declaration
