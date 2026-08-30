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

**Every route** — in the environment or the project config file:

| key | default | meaning |
|-----|---------|---------|
| `APP_RATE_LIMIT` | `false` | master switch |
| `APP_RATE_LIMIT_MAX` | `100` | burst per key |
| `APP_RATE_LIMIT_WINDOW` | `60` | seconds to refill `MAX` tokens |
| `APP_RATE_LIMIT_SKIP` | | comma-separated path prefixes never limited, e.g. `/health,/api/webhooks` — matched on the decoded path, on segment boundaries (`/api/webhooks` skips `/api/webhooks/stripe`, not `/api/webhooksX`) |
| `APP_RATE_LIMIT_MAX_KEYS` | `100000` | cap on tracked keys (~125 B each); above it, new keys are limited collectively through 256 shared buckets |
| `APP_RATE_LIMIT_HEADERS` | `false` | emit `RateLimit-*` headers on every response |

Only `true` turns the switch on: any other value (`1`, `yes`, `on`) warns and
stays off. An invalid number warns and uses the default — never a truncated
parse.

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
`maxKeys`. Roll out safely with `dryRun: true`: would-be rejections are logged
(`warn`, aggregated), nothing is blocked. Limits are per process: with N
instances behind a proxy, size them for ~N× the intended rate. Full design:
`rate-limit-specification.md`.

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
