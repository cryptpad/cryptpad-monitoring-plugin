# CryptPad monitoring plugin

CryptPad plugin that can be used to extract monitoring data from the server. The data is extracted for [Prometheus](https://prometheus.io/) and the plugin is using the NodeJS [prom-client library](https://www.npmjs.com/package/prom-client).

This plugins expose the monitoring data over the `/metrics` public endpoint.
