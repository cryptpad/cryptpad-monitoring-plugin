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
        help: 'Total user CPU time spent in seconds since last measure.',
        labelNames: ['pid', 'type']
    });
    const cpuSystemMetric = new Prometheus.Gauge({
        name: `process_cpu_system_seconds_total`,
        help: 'Total system CPU time spent in seconds since last measure.',
        labelNames: ['pid', 'type']
    });
    const cpuTotalMetric = new Prometheus.Gauge({
        name: `process_cpu_seconds_total`,
        help: 'Total user and system CPU time spent in seconds since last measure',
        labelNames: ['pid', 'type']
    });
    const cpuPercentMetric = new Prometheus.Gauge({
        name: `process_cpu_percent`,
        help: 'Avarage CPU usage (user+system) since last measure',
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

    const pidMetrics = Object.values(Prometheus.register._metrics);
    const callsMetrics = {};

    const clearMetric = (pids, m) => {
        const h = m.hashMap;
        Object.keys(h).forEach(key => {
            let v = h[key];
            let pid = v?.labels?.pid;
            if (!pid) { return; }
            if (!pids.includes(+pid)) {
                delete h[key];
            }
        });
    };
    const updateProm = (map) => {
        // Clear old workers data
        const pids = Object.keys(map).map(Number).filter(Boolean);
        pidMetrics.forEach(m => {
            try { clearMetric(pids, m); } catch (e) {}
        });
        // Update metrics
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
