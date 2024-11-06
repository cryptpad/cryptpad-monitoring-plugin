const VALUES = {};
VALUES.mem = () => {
    return process.memoryUsage();
};
VALUES.cpu = () => {
    let c = process.cpuUsage();
    c.time = +new Date();
    return c;
};
const calls = {};
VALUES.calls = () => {
    return calls;
};

const getData = (type) => {
    const value = {
        pid: process.pid,
        type: type
    };
    Object.keys(VALUES).forEach(key => {
        value[key] = VALUES[key]();
    });
    return value;
};

const increment = (key, value) => {
    if (typeof(value) !== "number") { value = 1; }
    // Prevent negative value
    calls[key] = (calls[key] || 0) + Math.max(value, 0);
};

// Only called from main thread:

const monitoringData = {};
const applyValues = (data) => {
    monitoringData[data.pid] = data;
};
const clearValues = (pid) => {
    delete monitoringData[pid];
};

const callsFreq = {};
const cpuFreq = {};
const getFreq = (last, noRound, time) => {
    last.value = last.value || 0;
    if (!last.time) {
        last.time = time || +new Date();
        last.oldValue = last.value;
        return;
    }

    // last.time exists, we can get a frequency
    // use the provided time (cpu usage) or now (number of calls)
    let now = time || +new Date();
    let diffTime = (now - last.time)/1000;
    let diffValue = last.value - (last.oldValue || 0);
    let val = diffValue/diffTime || 0;
    let freq = noRound ? val : Math.floor(10*val)/10 || 0;

    last.time = now;
    last.oldValue = last.value;
    return freq;
};
const processAll = () => {
    const data = monitoringData;
    let map = {
        calls: {} // value per second
    };
    let calls = {}; // total calls number
    Object.keys(data).forEach(pid => {
        let val = data[pid];
        let type = val.type;
        cpuFreq[pid] = cpuFreq[pid] || {};

        // Extract raw memory data
        let res = map[pid] = {
            type: val.type,
            mem: {},
            cpu: {},
            other: {},
            calls: {}
        };
        let mem = res.mem;
        mem.rss = val.mem?.rss || 0;
        mem.heapTotal = val.mem?.heapTotal || 0;
        mem.heapUsed = val.mem?.heapUsed || 0;
        mem.external = val.mem?.external || 0;
        mem.arrayBuffers = val.mem?.arrayBuffers || 0;

        // Extract CPU data + percent use
        let cpu = res.cpu;
        let userSeconds = (val.cpu?.user || 0) / 1000000;
        let systemSeconds = (val.cpu?.system || 0) / 1000000;
        let sum = userSeconds + systemSeconds;

        cpu.user = userSeconds - (cpuFreq[pid].oldUser || 0);
        cpu.system = systemSeconds - (cpuFreq[pid].oldSystem || 0);
        cpu.total = cpu.user+cpu.system;
        cpuFreq[pid].oldUser = userSeconds;
        cpuFreq[pid].oldSystem = systemSeconds;
        cpuFreq[pid].value = sum;
        cpu.percent = getFreq(cpuFreq[pid], true, val.cpu?.time);

        // Main thread: get server data
        if (type === 'main') {
            let stats = val.stats;
            res.other.ws = stats.total || 0;
            res.other.reg = val.registered || 0;
            res.other.channels = val.channels || 0;

            ['sent', 'sentSize',
                'received', 'receivedSize'].forEach(k => {
                calls['msg_' + k] = calls['msg_' + k] || 0;
                calls['msg_' + k] += stats[k];
            });
        }

        // Number fo RPC calls
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

    // Value per second for each "RPC" type
    Object.keys(calls).forEach(key => {
        let f = callsFreq[key] = callsFreq[key] || {};
        f.value = calls[key];
        map.calls[key] = getFreq(f);
    });

    return map;
};

module.exports = {
    interval: 5000,
    increment,
    getData,
    applyValues,
    clearValues,
    processAll
};
