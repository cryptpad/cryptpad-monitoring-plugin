const Monitoring = require('./monitoring');
const Config = require('./config');
const Api = require('./api');
const Util = require('../../common-util');

let Prometheus;
try {
    Prometheus = require('prom-client');
} catch (e) {
    console.warn("The cryptpad-monitoring-plugin has been installed but its dependencies are missing. Please go to ./lib/plugins/{monitoring-plugin-directory} and run \"npm ci\"");
}

const api = Api.create();
const MONITORING = {};

MONITORING.onWorkerClosed = (type, pid) => {
    Monitoring.clearValues(pid);
};

let monitoringCache = {};
const getMonitoringData = Util.notAgainForAnother((Env, cb) => {
    // Add main process data to monitoring
    let monitoring = Monitoring.getData('main');
    let Server = Env.Server;
    let stats = Server.getSessionStats();
    monitoring.stats = stats;
    monitoring.channels = Server.getActiveChannelCount();
    monitoring.registered = Object.keys(Env.netfluxUsers).length;
    // Send updated values
    Monitoring.applyValues(monitoring);

    let map = Monitoring.processAll();
    cb(map);
}, Config.interval);

MONITORING.initialize = (Env, type) => {
    if (type === "db-worker") {
        setInterval(() => {
            Env.sendMessage({
                type: 'monitoring',
                plugin: true,
                data: Monitoring.getData('db-worker')
            });
        }, Config.interval);
        return;
    }
    if (type === "http-worker") {
        setInterval(() => {
            Env.sendMessage({
                command: 'MONITORING',
                data: Monitoring.getData('http-worker')
            }, () => {
                // Done
            });
        }, Config.interval);
        return;
    }
    if (type !== "main") { return; }
    // type === main
    setInterval(() => {
        // Update cached values every minute if not called earlier
        getMonitoringData(Env, map => {
            monitoringCache = map;
        });
    }, 60000);
};

MONITORING.addMainCommands = (Env) => {
    const commands = {};
    commands.MONITORING = (msg, cb) => {
        Monitoring.applyValues(msg.data);
        cb();
    };
    commands.GET_MONITORING_DATA = (msg, cb) => {
        let to = getMonitoringData(Env, map => {
            monitoringCache = map;
            cb(void 0, map);
        });
        if (to) { // function called to recently, use cache
            cb(void 0, monitoringCache);
        }
    };
    return commands;
};
MONITORING.addWorkerResponses = (/*Env*/) => {
    const res = {};
    res.monitoring = data => {
        Monitoring.applyValues(data);
    };
    return res;
};

MONITORING.addHttpEvents = (/*Env*/) => {
    const events = {};
    events.MONITORING = api.onEvent;
    return events;
};

MONITORING.addHttpEndpoints = (Env, app) => {
    app.get('/metricscache', (req, res) => {
        api.onMetricsCacheEndpoint(res);
    });
    app.get('/metrics', (req, res) => {
        Env.sendMessage({
            command: 'GET_MONITORING_DATA',
        }, (err, value) => {
            if (err || !value) {
                res.status(500);
                return void send500(res);
            }
            api.onMetricsEndpoint(res, value);
        });

    });
};

MONITORING.increment = Monitoring.increment;
MONITORING.getData = Monitoring.getData;

module.exports = {
  name: "MONITORING",
  modules: Prometheus ? MONITORING : {}
};

