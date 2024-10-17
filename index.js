const Monitoring = require('./monitoring');
const Config = require('./config');
const Api = require('./api');

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
        api.initInterval();
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
        // Add main process data to monitoring
        let monitoring = Monitoring.getData('main');
        let Server = Env.Server;
        let stats = Server.getSessionStats();
        monitoring.ws = stats.total;
        monitoring.channels = Server.getActiveChannelCount();
        monitoring.registered = Object.keys(Env.netfluxUsers).length;
        // Send updated values
        Monitoring.applyValues(monitoring);
        Env.broadcast('MONITORING', Monitoring.getValues());
    }, Config.interval);
};

MONITORING.addMainCommands = (/*Env*/) => {
    const commands = {};
    commands.MONITORING = (msg, cb) => {
        Monitoring.applyValues(msg.data);
        cb();
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
    app.get('/metrics', api.onMetricsEndpoint);
};

MONITORING.increment = Monitoring.increment;
MONITORING.getData = Monitoring.getData;

module.exports = {
  name: "MONITORING",
  modules: Prometheus ? MONITORING : {}
};

