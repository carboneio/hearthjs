# HearthJS

HearthJS is made to build NodeJS server faster. It gives many tools to increase your productivity and let you focus only on your real functionnality.

Here is a list of tools that HearthJS manage

- Translations
- Logger
- Migrations
- API declaration
- Cron
- ...

You can find the complete documentation here: [www.hearthjs.io](http://www.hearthjs.io)

## SQLite

PostgreSQL stays the default. SQLite runs on Node's built-in `node:sqlite`, with no extra dependency, and `pg` is not even loaded.

```json
{
  "APP_SERVER_PORT": 8080,
  "APP_DATABASE_CLIENT": "sqlite",
  "APP_DATABASE_SQLITE_FILENAME": "data/app.db"
}
```

| key | value |
|-----|-------|
| `APP_DATABASE_CLIENT` | `postgresql` (default) or `sqlite`. Anything else stops the server from starting. |
| `APP_DATABASE_SQLITE_FILENAME` | The database file, created if missing; its directory must exist. A relative path lives in the server directory, wherever the process starts. `:memory:` for a database that lives as long as the process. |
| `APP_DATABASE_TIMEOUT` | The busy timeout: how long a query waits for a lock another process holds. 10s by default. |

Both keys can also come from the environment, which wins over the config file. The `APP_DATABASE_USERNAME`, `HOST`, `NAME`, `PASSWORD` and `PORT` keys are then optional and ignored.

`hearthjs.db.query` and `hearthjs.db.exec` work unchanged: the same `$1, $2` placeholders, always bound as parameters, the same `(err, res, rows)` callback or promise, the same models. An integer is bound as an INTEGER, a `Date` as an ISO string, an array, a plain object or an object with `toJSON()` as JSON, a boolean as `1`/`0`, a `Buffer` as a BLOB. Any other object (a `Map`, a `Set`, a `Float64Array`, a class instance...) is refused with an error naming the parameter, rather than stored as something else. An integer beyond 2^53 is bound exactly from a `BigInt`, but reading one back is an error: select it `CAST(... AS TEXT)`. The file uses WAL, foreign keys and SQLite's defensive mode, and `NOW()` returns the ISO date. hearthjs keeps its migrations in a `hearthjs_migration` table, since SQLite has no schemas, and `datasets.clean()` empties every other table, virtual tables included (listed through `pragma_table_list`, FTS5 shadow tables and `sqlite_*` left out).

What stays yours: the SQL in your own `.sql` files and migrations is sent as written, so it has to be SQLite SQL. `node:sqlite` is synchronous, so a query blocks the event loop while it runs: keep them short and indexed. And one connection serves every request, so a `BEGIN` you send is shared by every request that runs before its `COMMIT`.

A query holding several statements runs as a script, without parameters, all or nothing like Postgres: hearthjs wraps it in a `SAVEPOINT`, so it nests in a transaction you opened. A script must not hold its own `BEGIN`/`COMMIT`: `BEGIN` fails cleanly, so a migration file with `BEGIN`/`COMMIT` fails on SQLite. A query ending with an unterminated `/*` comment is one statement.

Known limits, SQLite only:

- `rowCount` after DDL or `BEGIN` reports the previous write's count.
- An integer beyond 2^53 read back makes the query fail.
- A missing `$N` parameter binds `NULL`, where Postgres refuses the query.
- `APP_DATABASE_TIMEOUT` is a busy (lock-wait) timeout, not a statement timeout: `node:sqlite` has none.

### Next to PostgreSQL

`hearthjs.db.create()` returns another database with the same API and its own `.sql` files. It is how an application on PostgreSQL reads a SQLite file, a backup for instance:

```js
const backup = hearthjs.db.create()

backup.init({ client: 'sqlite', filename: '/backups/.metadata.db.0.backup', readOnly: true }, async (err) => {
  if (err) {
    return done(err) // a missing file is an error, it is never created
  }

  try {
    const { rows } = await backup.query('SELECT "id", "name" FROM "templates"')

    for (const row of rows) {
      await hearthjs.db.query('INSERT INTO "templates" ("id", "name") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"', [row.id, row.name])
    }
  } finally {
    backup.close(done)
  }
})
```

`readOnly` opens the file as an immutable snapshot: no lock, no `-wal` or `-shm` beside it, no byte written. It is meant for a file no process writes any more: a file with a non-empty `-wal` beside it is refused at `init` ("a -wal file is beside it"), since immutable mode would silently miss its commits. Copy a closed database, or use `backup()`. `backup.registerSQLFile(path)` then `backup.exec(name, data)` work as on the main database. For a table too large to hold in memory, iterate on the raw `DatabaseSync` handle, one row at a time: `for (const row of backup.sqlite.db.prepare('SELECT * FROM "templates_patches"').iterate()) {}`. Closing it leaves the main pool alone.

A read-only database runs reads only: `SELECT`, joins, CTEs, functions, and the schema pragmas (`table_info`, `table_xinfo`, `table_list`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`). Everything else is denied by an allow-list, including `ATTACH`, `BEGIN` and `VACUUM INTO`, which would otherwise write a copy of the database to another file. Full-text search (FTS5) works; R-tree does not.

A view stored in the file never runs: any query touching one fails with "not authorized". A hostile backup could hang the event loop with an endless recursive view, and `node:sqlite` has no per-query timeout. Read the backup's tables instead; the CTEs of your own query still work. One value (`SQLITE_LIMIT_LENGTH`) is capped at 4 times the size of the file, 16 MiB at least, so a generated column cannot allocate gigabytes: it fails with "string or blob too big".

#### A backup downloaded in memory

A small backup does not need a file: pass its bytes as `buffer`, in place of `filename`. It is loaded in a private in-memory database, and with `readOnly` the same rules apply (allow-list, no view, value cap at 4 times the buffer size). A backup of a WAL database, such as one made by better-sqlite3's `db.backup()`, keeps the WAL flag in its header, which SQLite refuses in memory: hearthjs flips the two header bytes while `deserialize()` copies the buffer, then restores them. The buffer is not copied first, and ends unchanged. Bytes that are not a SQLite database, or a truncated download, fail at `init`, not at the first query.

```js
const bytes = await downloadFromS3('.metadata.db.0.backup') // a Buffer
const backup = hearthjs.db.create()

await backup.init({ client: 'sqlite', buffer: bytes, readOnly: true })

try {
  const { rows } = await backup.query('SELECT "id", "name" FROM "templates"')
  // one round trip for every row
  await hearthjs.db.query('INSERT INTO "templates" ("id", "name") SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"', [rows.map(r => r.id), rows.map(r => r.name)])
} finally {
  await backup.close()
}
```

`init`, `query`, `exec` and `close` all return a promise when no callback is given. A callback that is not a function is refused before anything runs. `close()` clears only this database's parsed SQL files.

## Rate limiting

Off by default. In-memory token bucket, per process, no external store: `max` is
the allowed burst, refilled over `window` seconds (sustained rate = `max/window`
per second). A rejected request gets `429`, `Retry-After` and
`Cache-Control: no-store` headers and the standard
`{ success: false, data: {}, message }` body — before cookie parsing,
body parsing, addons and middleware ever run.

There are two independent switches — the **global** per-IP net, and the
**per-route** limits (the `rateLimit` schema keys). Set these in the environment
or the project config file:

| key | default | meaning |
|-----|---------|---------|
| `APP_RATE_LIMIT_GLOBAL` | `false` | turn on the **global** per-IP net |
| `APP_RATE_LIMIT_GLOBAL_MAX` | `100` | global net: burst per key |
| `APP_RATE_LIMIT_GLOBAL_WINDOW` | `60` | global net: seconds to refill `MAX` tokens |
| `APP_RATE_LIMIT_GLOBAL_SKIP` | | global net: comma-separated path prefixes never limited, e.g. `/health,/api/webhooks` — matched on the decoded path, on segment boundaries (`/api/webhooks` skips `/api/webhooks/stripe`, not `/api/webhooksX`) |
| `APP_RATE_LIMIT_GLOBAL_MAX_KEYS` | `100000` | global net: cap on tracked keys (~125 B each); above it, new keys are limited collectively through 256 shared buckets |
| `APP_RATE_LIMIT_GLOBAL_HEADERS` | `false` | global net: emit `RateLimit-*` headers on every response |
| `APP_RATE_LIMIT_ROUTE` | `true` | are the **per-route** limits active? Set `false` (e.g. in the test config) to turn every `rateLimit:` schema limit off. Warns at startup |

The two are independent: the per-route limits (below) run whether or not the
global net is on, and `APP_RATE_LIMIT_ROUTE=false` turns them off without
touching the global net. Only `true` turns a switch on: any other value (`1`,
`yes`, `on`) warns and stays off. An invalid number warns and uses the default —
never a truncated parse.

The key is `req.ip`: the socket address, or the **rightmost** `X-Forwarded-For`
hop (the one your proxy appended) when `APP_TRUST_PROXY` is true. Change it, or
skip requests, with `hearthjs.rateLimit.configure({ key, skip, onLimit })` in
`beforeInit`. Key functions are synchronous and return a string: one that
returns nothing (an `async` function's Promise included) falls back to the
client address and logs a warning.

**One route** — the `rateLimit` schema key:

```js
schemas: {
  login: {
    rateLimit: { max: 10, window: 300 },   // 10 burst, then 2/min per IP
    function: loginHandler
  }
}
```

**Several routes sharing one budget** — declare a profile in `beforeInit`,
reference it by name:

```js
hearthjs.rateLimit.define('email-send', {
  max: 10,
  window: 1800,
  key: (req) => req.token ? 'a' + req.token.idAccount : req.ip
})
```

```js
schemas: {
  sendInvitation: { rateLimit: 'email-send', ... },
  resetPassword:  { rateLimit: 'email-send', ... }   // same bucket per key
}
```

`scope: 'route'` gives each route its own bucket instead. An unknown profile
name is reported at startup and the route is not served.

Options: `max`, `window`, `key`, `scope`, `dryRun`, `onLimit`, `message`,
`maxKeys`, `headers`. Roll out safely with `dryRun: true`: would-be rejections
are logged (`warn`, aggregated), nothing is blocked. Set `headers: true` to emit
the `RateLimit-*` headers on that route (off by default, like the global net's
`APP_RATE_LIMIT_GLOBAL_HEADERS`). Limits are per process: with N instances behind
a proxy, size them for ~N× the intended rate.

**Testing.** Define your limits normally — no `dryRun` seam in production code —
and set `APP_RATE_LIMIT_ROUTE=false` in the test config so per-route limits never
interfere with the rest of the suite. One dedicated test flips them on for a real
endpoint and asserts the `429`:

```js
// test config: "APP_RATE_LIMIT_ROUTE": false
describe('rate limit (login)', () => {
  before(() => hearthjs.rateLimit.enable())     // per-route limits on
  afterEach(() => hearthjs.rateLimit.reset())   // clear buckets between cases
  after(() => hearthjs.rateLimit.disable())     // back off for other tests

  it('returns 429 after N attempts from one IP', /* hit /api/login N+1 times */)
})
```

`enable()` / `disable()` flip the `APP_RATE_LIMIT_ROUTE` switch at runtime;
`reset()` clears every limiter's bucket state (keeping the profiles) so one
test's requests never spill into the next. Vary the key between cases by sending
a different `X-Forwarded-For` (with `APP_TRUST_PROXY=true`) when you need
distinct buckets.

## Roles and permissions

Off by default: a project that never calls `hearthjs.roles.configure` is served exactly as before. Declaring it turns on **deny by default** — every route the project calls authenticated must state the permission it demands, or the server refuses to start.

A route names a **permission**, never a role. The roles that satisfy it live in one table, so a new role costs one line there and no edit to any route.

Declare the table in `beforeInit`, next to the rate limit profiles:

```js
hearthjs.roles.configure({
  roles: {
    ADMIN   : ['members.read', 'members.write', 'apikeys.read'],
    USER    : ['members.read'],
    FINANCER: ['members.read', 'billing.read']
  },
  // what role this caller holds — synchronous, from the session, never the request body
  resolve : (req) => req.token?.role,
  // which routes owe a policy. Must return a boolean: anything else refuses to boot
  requires: (route) => route.schema.needAuthentication === true,
  // optional. A custom refusal REPLACES the built-in one entirely, its cache
  // headers included — a 403 that varies by role must never be cacheable
  refuse  : (req, res) => {
    res.set('cache-control', 'no-store')
    return res.redirect(hearthjs.getConfig('STUDIO_URL'))
  }
})
```

The default answers `403` with `{ success, data, message }` and `cache-control: no-store`, the same message on every route so a refusal never says which guard it hit. Declare `refuse` only to answer differently — and carry `no-store` yourself when you do.

`refuse` **owns the response**. It is never handed `next`, so the request stops there whatever it does, and it must end the response itself: one that returns without answering leaves the caller hanging until the client gives up. It is never an *allow* — that is the one thing the framework guarantees for you. A `refuse` that throws is caught, logged once, and falls back to the built-in `403`.

Then, in a schema:

```js
schemas: {
  getUsers   : { needAuthentication: true, permission: 'members.read' },
  addUser    : { needAuthentication: true, permission: 'members.write' },
  whoami     : { needAuthentication: true, permission: 'any' },   // every declared role
  login      : { function: loginHandler }                         // public, declares nothing
}
```

`resolve` must return the role **synchronously**. An `async` one returns a promise, never a role, so every caller is refused: the application boots, answers `403` to everyone, and says so once per route in the log. Look up the role before the guard — in a middleware or an addon — not inside `resolve`.

`'any'` has to be written: a route open to every signed-in caller is a decision, and an omission must never be able to look like one. It means every **declared** role, so a token naming a role the table no longer holds is refused there too.

There is no wildcard. A role that may do everything lists everything, which keeps the check an exact set membership that cannot drift into a prefix match — and makes the table the closed vocabulary, so a permission no role grants is a typo rather than a route that quietly refuses everyone.

A misspelt permission is **not** a boot failure, unlike a missing one: it logs an error at startup and drops the route, which then answers `404`. That is what a broken `rateLimit` profile already does, for the same reason — a route that cannot be protected must not be served.

The guard runs **after** the addons, so an addon's `401` reaches an anonymous caller before any `403` does, and **behind** the rate limiter. That ordering assumes authentication is an **addon**: a project that authenticates in a schema's `middleware` array gets the guard first, `resolve` sees no identity, and every caller is refused — wrong loudly rather than open quietly, but wrong.

What the boot check covers is the routes declared through `hearthjs.api`. A handler mounted on the app in `init` or `afterInit`, a static mount and socket.io are the project's own to guard.

`hearthjs.api.routes()` returns `[{ method, path, api, schemaName, schema }]` for every declared route — the same route → schema resolution the router used. It is what the boot check reads, and what a test asserting which routes are public or which permissions exist should read instead of walking the schemas by hand.

## Where the logs go

`APP_LOG_OUTPUT`, in the environment or in the project config file, decides the
destinations. It takes one of four values:

| value | logs go to |
|-------|------------|
| `file` (default) | the daily file in `server/logs`, nothing on stdout |
| `stdout` | stdout only, and no `logs` directory is ever created |
| `both` | the daily file and stdout |
| `none` | nowhere; a warning says so once at startup |

`stdout` is the one to use in a container: writing log files inside an image is
an anti pattern, and the filesystem may well be read only. `both` is the one for
a systemd service, so `journalctl` shows the application logs.

The request log line prints whole query strings by default. Set
`APP_LOG_REDACT_QUERY=true` to redact the value of sensitive query parameters
(`token`, `code`, `api_key`, `state`, …) so a secret passed in a URL never
reaches the log in the clear — recommended in production.

`APP_LOG_STDOUT` is **deprecated**. When `APP_LOG_OUTPUT` is not set, `true`
still means `both` and anything else means `file`, so existing deployments keep
the output they have. When both are set, `APP_LOG_OUTPUT` wins and the startup
warns that `APP_LOG_STDOUT` is ignored.
