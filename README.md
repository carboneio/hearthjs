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
