const Monitoring = require('./monitoring');
const Config = require('./config');
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

let monitoringCache = {};

/*  takes a function (f) and a time (t) in ms. returns a function wrapper
    which prevents the internal function from being called more than once
    every t ms. if the function is prevented, returns time til next valid
    execution, else null.
*/
const notAgainForAnother = (f, t) => {
    if (typeof(f) !== 'function' || typeof(t) !== 'number') {
        throw new Error("invalid inputs");
    }
    let last = null;
    return function () {
        const now = +new Date();
        if (last && now <= last + t) { return t - (now - last); }
        last = now;
        const args = Array.prototype.slice.call(arguments);
        f.apply(null, args);
        return null;
    };
};


const getMonitoringData = notAgainForAnother((Env, cb) => {
    if (Env.myId !== 'storage:0') { return; }
    if (Env.OFFLINE_MODE) { return void cb({}); }

    // 1. Get storage:0 data
    // 2. Get other nodes data (fronts, cores, other storages)

    Monitoring.resetValues();

    // Our data
    const time = +new Date();
    let monitoring = Monitoring.getData('storage');
    Monitoring.applyValues(monitoring);

    nThen(waitFor => {
        // Broadcast query to all front nodes
        Env.modules?.Core?.storageToFront(Env, 'GET_MONITORING', {
        }, waitFor((errors, data) => {
            (data || []).forEach(obj => {
                Monitoring.applyValues(obj);
            });
        }));

        // Broadcast to cores
        Env.interface.broadcast('core', 'GET_MONITORING', {
        }, waitFor((errors, data) => {
            (data || []).forEach(obj => {
                Monitoring.applyValues(obj);
            });
        }));

        Env.modules?.Core?.storageToStorage(Env, 'all', 'GET_MONITORING', {
        }, waitFor((errors, data) => {
            (data || []).forEach(obj => {
                Monitoring.applyValues(obj);
            });
        }));
    }).nThen(() => {
        let map = Monitoring.processAll(time);
        cb(map);
    });
}, Config.interval);

MONITORING.addFrontCommands = (Env, commands) => {
    commands.GET_MONITORING = (args, cb) => {

        const data = Monitoring.getData('front');

        const users = Object.values(Env.users);
        const total = users.length;

        data.stats = { total };

        cb(void 0, data);
    };
};
MONITORING.addCoreCommands = (Env, commands) => {
    commands.GET_MONITORING = (args, cb) => {
        const data = Monitoring.getData('core');

        const regUsers = Object.values(Env.userCache).map(obj => {
            return Object.values(obj.authKeys || {})[0];
        }).filter(Boolean);
        const reg = new Set(regUsers).size;

        data.stats = { reg };

        cb(void 0, data);
    };
};
MONITORING.addStorageCommands = (Env, commands) => {
    commands.GET_MONITORING = (args, cb) => {
        const data = Monitoring.getData('storage');

        const channels = Object.keys(Env.channel_cache).length;

        data.stats = { channels };

        cb(void 0, data);
    };
};

MONITORING.initStorage = (Env/*, waitFor*/) => {
    if (Env.myId !== "storage:0") { return; }
    setInterval(() => {
        // Update cached values every minute if not called earlier
        getMonitoringData(Env, map => {
            monitoringCache = map;
        });
    }, 60000);

    Env.clusters.on('MONITORING_GET_DATA', (args, cb) => {
        if (args?.cache) {
            return void cb(void 0, monitoringCache);
        }
        let to = getMonitoringData(Env, map => {
            monitoringCache = map;
            return void cb(void 0, monitoringCache);
        });
        if (to) { // function called too recently, use cache
            return void cb(void 0, monitoringCache);
        }
    });
};

let endpointAdded = false;
const addStorageEndpoint = (Env, app) => {
    if (endpointAdded) { return; }
    endpointAdded = true;

    const getDataFromParent = (cache, res) => {
        if (!Env.sendCommand) { return res.status(404).end(); }
        Env.sendCommand('MONITORING_GET_DATA', {
            cache
        }, (err, data) => {
            api.onMetricsEndpoint(res, data);
        });
    };

    app.use('/metrics', (req, res) => {
        getDataFromParent(false, res);
    });
    app.use('/metricscache', (req, res) => {
        getDataFromParent(true, res);
    });
};

MONITORING.httpEndpoints = [{
    type: 'proxy',
    target: 'storage',
    url: '/metrics',
    f: addStorageEndpoint,
    getIdFromReq: () => {
        return 0; // always storage:0
    }
}, {
    type: 'proxy',
    target: 'storage',
    url: '/metricscache',
    f: addStorageEndpoint,
    getIdFromReq: () => {
        return 0; // always storage:0
    }
}];


// ALL
MONITORING.increment = Monitoring.increment;
MONITORING.getData = Monitoring.getData;
MONITORING.average = Monitoring.average;
MONITORING.setValue = Monitoring.setValue;

module.exports = {
  name: "MONITORING",
  modules: Prometheus ? MONITORING : {}
};

