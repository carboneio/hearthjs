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

`APP_LOG_STDOUT` is **deprecated**. When `APP_LOG_OUTPUT` is not set, `true`
still means `both` and anything else means `file`, so existing deployments keep
the output they have. When both are set, `APP_LOG_OUTPUT` wins and the startup
warns that `APP_LOG_STDOUT` is ignored.
