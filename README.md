# CryptPad monitoring plugin

CryptPad plugin that can be used to extract monitoring data from the server. The data is extracted for [Prometheus](https://prometheus.io/) and the plugin is using the NodeJS [prom-client library](https://www.npmjs.com/package/prom-client).

This plugins expose the monitoring data over the `/metrics` public endpoint.

Run `node websocket-monitor.js <configname>` to load `ws-config-<configname>.js`.
Run `node websocket-monitor.js` to load the default `ws-config.js`.
Add `--debug` to print detailed `Drive content` counts.
Add `--alert` to print `WARNING: drive connection threshold exceeded ...` after 3 consecutive slow `DRIVE` checks.
Prometheus exposes `ws_drive_over_threshold_last_hour` (percent of `DRIVE` checks over threshold in the last 15 minutes, from 0 to 100).
With `--alert`, a critical outage alert is emitted when `WS`/`PING`/`RPC`/`DRIVE` metrics are all unreachable for more than 3 minutes and `DRIVE` is slow or failing 5 checks in a row.
Add `--extra-command-on-alert` and set `alertExtraCommand` in config to launch an extra command when this critical outage alert is triggered (once per outage incident).
Add `--report-on-alert` with `--alert` to send `SIGQUIT` to `/home/cryptpad/cryptpad/server.js`.
Add `--mail-on-alert` with `--alert` to send an email to `alertMailTo` for both slow-drive alerts and critical outage alerts.
Drive checks are disabled by default.
Add `--withdrive` to run `DRIVE` checks (requires `driveInterval` in config).
