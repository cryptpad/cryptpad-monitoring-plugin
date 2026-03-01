# CryptPad monitoring plugin

CryptPad plugin that can be used to extract monitoring data from the server. The data is extracted for [Prometheus](https://prometheus.io/) and the plugin is using the NodeJS [prom-client library](https://www.npmjs.com/package/prom-client).

This plugins expose the monitoring data over the `/metrics` public endpoint.

Run `node websocket-monitor.js <configname>` to load `ws-config-<configname>.js`.
Run `node websocket-monitor.js` to load the default `ws-config.js`.
Add `--debug` to print detailed `Drive content` counts.
Add `--alert` to print `WARNING: drive connection threshold exceeded ...` after 3 consecutive slow `DRIVE` checks.
With `--alert`, Prometheus also exposes `ws_drive_alerts_last_hour`.
Add `--report-on-alert` with `--alert` to send `SIGQUIT` to `/home/cryptpad/cryptpad/server.js`.
Add `--mail-on-alert` with `--alert` to send an email to `alertMailTo`.
Drive checks are disabled by default.
Add `--withdrive` to run `DRIVE` checks (requires `driveInterval` in config).
