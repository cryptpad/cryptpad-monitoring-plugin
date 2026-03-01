const Monitoring = require('./monitoring');
const Api = require('./api');
const nThen = require('nthen');

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

const tos = {};
const makeTxid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const getMonitoringData = (Env, cb) => {
    // Add main process data to monitoring
    if (Env.OFFLINE_MODE) {
        return void cb({});
    }
    let monitoring = Monitoring.getData('main');
    let Server = Env.Server;
    let stats = Server.getSessionStats();
    monitoring.stats = stats;
    monitoring.channels = Server.getActiveChannelCount();
    monitoring.registered = Object.keys(Env.netfluxUsers).length;
    // Send updated values
    Monitoring.applyValues(monitoring);

    // Get workers data
    // Clear object
    Object.keys(tos).forEach(k => { delete tos[k]; });
    const TIMEOUT = 1000;
    nThen(waitFor => {
        let txid = makeTxid();
        tos._txid = txid;
        let dbWorkers = Env.broadcastWorkerCommand({
            command: 'GET_MONITORING',
            txid: txid
        });
        let httpWorkers = Env.broadcast('GET_MONITORING', {txid});
        let addTo = worker => {
            let pid = worker.process?.pid || worker.pid;
            let w = waitFor();
            let to = setTimeout(w, TIMEOUT);
            let done = () => {
                w();
                clearTimeout(to);
            };
            tos[pid] = { done };
        };
        dbWorkers.forEach(addTo);
        httpWorkers.forEach(addTo);
    }).nThen(() => {
        let map = Monitoring.processAll();
        cb(map);
    });
};

MONITORING.initialize = (Env, type) => {
    if (type === "db-worker") {
        /*
        setInterval(() => {
            Env.sendMessage({
                type: 'monitoring',
                plugin: true,
                data: Monitoring.getData('db-worker')
            });
        }, Config.interval);
        */
        return;
    }
    if (type === "http-worker") {
        /*
        setInterval(() => {
            Env.sendMessage({
                command: 'MONITORING',
                data: Monitoring.getData('http-worker')
            }, () => {
                // Done
            });
        }, Config.interval);
        */
        return;
    }
    if (type !== "main") { return; }
};

MONITORING.addMainCommands = (Env) => {
    const commands = {};
    // Received from http workers
    commands.MONITORING = (msg, cb) => {
        let data = msg.data;
        Object.keys(tos).forEach(pid => {
            // Check if this message is a response to our command
            if (+data.pid !== +pid || data.txid !== tos._txid) {
                return;
            }
            // apply values and call waitfor for this worker
            Monitoring.applyValues(data.value);
            tos[pid].done();
        });
        cb();
    };
    commands.GET_MONITORING_DATA = (msg, cb) => {
        getMonitoringData(Env, map => {
            cb(void 0, map);
        });
    };
    return commands;
};
MONITORING.addWorkerResponses = (/*Env*/) => {
    const res = {};
    res.monitoring = data => {
        Object.keys(tos).forEach(pid => {
            // Check if this message is a response to our command
            if (+data.pid !== +pid || data.txid !== tos._txid) {
                return;
            }
            // apply values and call waitfor for this worker
            Monitoring.applyValues(data.value);
            tos[pid].done();
        });
    };
    return res;
};

// DB-WORKER
MONITORING.addWorkerCommands = (Env) => {
    const events = {};
    events.GET_MONITORING = (data) => {
        Env.sendMessage({
            type: 'monitoring',
            plugin: true,
            data: {
                txid: data.txid,
                pid: process.pid,
                value: Monitoring.getData('db-worker')
            }
        });
    };
    return events;
};

// HTTP-WORKER
MONITORING.addHttpEvents = (Env) => {
    const events = {};
    events.GET_MONITORING = (data) => {
        Env.sendMessage({
            command: 'MONITORING',
            data: {
                txid: data.txid,
                pid: process.pid,
                value: Monitoring.getData('http-worker')
            }
        }, () => {
            // Done
        });

    };
    return events;
};
MONITORING.addHttpEndpoints = (Env, app) => {
    const send500 = (res) => {
        res.status(500);
        res.send();
    };
    app.get('/metrics', (req, res) => {
        Env.sendMessage({
            command: 'GET_MONITORING_DATA',
        }, (err, value) => {
            if (err || !value) {
                return void send500(res);
            }
            api.onMetricsEndpoint(res, value);
        });
    });
};

// ALL
MONITORING.increment = Monitoring.increment;
MONITORING.getData = Monitoring.getData;

module.exports = {
  name: "MONITORING",
  modules: Prometheus ? MONITORING : {}
};
