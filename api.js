let Prometheus;
try { Prometheus = require('prom-client'); } catch (e) {}

const Config = require('./config');


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
    const callsFreq = {};

    Api.initInterval = () => {
        setInterval(() => {
            Object.keys(callsFreq).forEach(key => {
                let last = callsFreq[key] = callsFreq[key] || {};
                last.value = last.value || 0;
                if (!last.time) {
                    last.time = +new Date();
                    last.oldValue = last.value;
                    return;
                }

                // last.time exists, we can get a frequency
                let now = +new Date();
                let diffTime = (now - last.time)/1000;
                let diffValue = last.value - (last.oldValue || 0);
                let freq = Math.floor(10*diffValue/diffTime)/10 || 0;

                last.time = now;
                last.oldValue = last.value;

                // Update metrics
                let m = callsMetrics[key];
                if (!m) {
                    m = callsMetrics[key] = new Prometheus.Gauge({
                        name: key,
                        help: key
                    });
                }
                m.set(freq);
            });
        }, Config.interval);
    };

    Api.onEvent = data => {
        /*
        {
            main: {
                rss: 1234
                ...
            },
            pid1: {
                rss: 234
                ...
            }
        }
        */
        let calls = {};
        Object.keys(data).forEach(pid => {
            let val = data[pid];
            let type = val.type;
            rssMetric.set({pid, type}, val.mem?.rss || 0);
            heapTotalMetric.set({pid, type}, val.mem?.heapTotal || 0);
            heapUsedMetric.set({pid, type}, val.mem?.heapUsed || 0);
            externalMetric.set({pid, type}, val.mem?.external || 0);
            arrayBufferMetric.set({pid, type}, val.mem?.arrayBuffers || 0);
            let userSeconds = (val.cpu?.user || 0) / 1000000;
            let systemSeconds = (val.cpu?.system || 0) / 1000000;
            cpuUserMetric.set({pid, type}, userSeconds);
            cpuSystemMetric.set({pid, type}, systemSeconds);
            let sum = userSeconds + systemSeconds;
            let percent = sum / (Config.interval/1000);
            cpuTotalMetric.set({pid, type}, sum);
            cpuPercentMetric.set({pid, type}, percent);

            if (type === 'main') {
                wsMetric.set(val.ws || 0);
                regMetric.set(val.registered || 0);
                chanMetric.set(val.channels || 0);
            }

            if (val.calls) {
                Object.keys(val.calls).forEach(key => {
                    let k = key;
                    if (type === 'main') {
                        k = `main_${key}`;
                    } else {
                        k = `worker_${key}`;
                    }
                    calls[k] = calls[k] || 0;
                    calls[k] += val.calls[key];
                });
            }
        });

        Object.keys(calls).forEach(key => {
            let f = callsFreq[key] = callsFreq[key] || {};
            f.value = calls[key];
        });
    };

    Api.onMetricsEndpoint = (req, res) => {
        Prometheus.register.metrics().then((data) => {
            res.set('Content-Type', Prometheus.register.contentType);
            res.send(data);
        });
    };
    return Api;
};

module.exports = { create };
