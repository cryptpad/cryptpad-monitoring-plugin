let Prometheus;
try { Prometheus = require('prom-client'); } catch (e) {}

//const Config = require('./config');


const create = () => {
    if (!Prometheus) { return {}; }
    const Api = {};
    const rssMetric = new Prometheus.Gauge({
        name: `memory_rss`,
        help: 'The amount of space occupied in the main memory device for the process.',
        labelNames: ['pid', 'type']
    });
    const heapTotalMetric = new Prometheus.Gauge({
        name: `memory_heap_total`,
        help: "Total heap memory.",
        labelNames: ['pid', 'type']
    });
    const heapUsedMetric = new Prometheus.Gauge({
        name: `memory_heap_used`,
        help: 'Used heap memory.',
        labelNames: ['pid', 'type']
    });
    const externalMetric = new Prometheus.Gauge({
        name: `memory_external`,
        help: 'Memory usage of C++ objects bound to JavaScript objects managed by V8.',
        labelNames: ['pid', 'type']
    });
    const arrayBufferMetric = new Prometheus.Gauge({
        name: `memory_array_buffers`,
        help: 'Memory allocated for ArrayBuffers and SharedArrayBuffers.',
        labelNames: ['pid', 'type']
    });
    const cpuUserMetric = new Prometheus.Gauge({
        name: `process_cpu_user_seconds_total`,
        help: 'Total user CPU time spent in seconds during the configured interval.',
        labelNames: ['pid', 'type']
    });
    const cpuSystemMetric = new Prometheus.Gauge({
        name: `process_cpu_system_seconds_total`,
        help: 'Total system CPU time spent in seconds during the configured interval.',
        labelNames: ['pid', 'type']
    });
    const cpuTotalMetric = new Prometheus.Gauge({
        name: `process_cpu_seconds_total`,
        help: 'Total user and system CPU time spent in seconds during the configured interval',
        labelNames: ['pid', 'type']
    });
    const cpuPercentMetric = new Prometheus.Gauge({
        name: `process_cpu_percent`,
        help: 'Total user and system CPU time spent divided by the interval duration',
        labelNames: ['pid', 'type']
    });
    const wsMetric = new Prometheus.Gauge({
        name: `active_websockets`,
        help: 'Number of active websocket connections',
    });
    const regMetric = new Prometheus.Gauge({
        name: `active_registered_users`,
        help: 'Number of registered users online',
    });
    const chanMetric = new Prometheus.Gauge({
        name: `active_channels`,
        help: 'Number of active pads',
    });
    const callsMetrics = {};


    const updateProm = (map) => {
        Object.keys(map).forEach(pid => {
            if (pid === 'calls') { return; }
            let val = map[pid];
            let type = val.type;
            rssMetric.set({pid, type}, val.mem?.rss || 0);
            heapTotalMetric.set({pid, type}, val.mem?.heapTotal || 0);
            heapUsedMetric.set({pid, type}, val.mem?.heapUsed || 0);
            externalMetric.set({pid, type}, val.mem?.external || 0);
            arrayBufferMetric.set({pid, type}, val.mem?.arrayBuffers || 0);

            cpuUserMetric.set({pid, type}, val.cpu?.user || 0);
            cpuSystemMetric.set({pid, type}, val.cpu?.system || 0);
            cpuTotalMetric.set({pid, type}, val.cpu?.total || 0);
            cpuPercentMetric.set({pid, type}, val.cpu?.percent || 0);

            if (type === 'main') {
                wsMetric.set(val.other?.ws || 0);
                regMetric.set(val.other?.reg || 0);
                chanMetric.set(val.other?.channels || 0);
            }
        });
        Object.keys(map.calls || {}).forEach(key => {
            let m = callsMetrics[key];
            if (!m) {
                m = callsMetrics[key] = new Prometheus.Gauge({
                    name: key,
                    help: key
                });
            }
            m.set(map.calls[key]);
        });
    };

    Api.onMetricsEndpoint = (res, value) => {
        updateProm(value);
        Prometheus.register.metrics().then((data) => {
            res.set('Content-Type', Prometheus.register.contentType);
            res.send(data);
        });
    };
    return Api;
};

module.exports = { create };
