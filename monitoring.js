const VALUES = {};
VALUES.mem = () => {
    return process.memoryUsage();
};
VALUES.cpu = () => {
    return process.cpuUsage();
};
let calls = {};
let avgs = {};
VALUES.calls = () => {
    Object.keys(avgs).forEach(key => {
        const all = avgs[key];
        const avgKey = `${key}_time`;
        if (!all?.sum || !all.nb || calls[avgKey]) { return; }

        let val = all.value/all.nb;
        calls[avgKey] = Math.floor(10*val)/10;
    });
    return calls;
};

const getData = (type) => {
    const value = {
        pid: process.pid,
        type: type,
        time: +new Date()
    };
    Object.keys(VALUES).forEach(key => {
        value[key] = VALUES[key]();
    });

    // reset values
    avgs = {};
    calls = {};

    return value;
};

const increment = (key, value) => {
    if (typeof(value) !== "number") { value = 1; }
    // Prevent negative value
    calls[key] = (calls[key] || 0) + Math.max(value, 0);
};
const setValue = (key, value) => {
    if (typeof(value) !== "number") { return; }
    calls[key] = value;
};

const setAverage = (key, value) => {
    const obj = avgs[key] ||= {
        sum: 0,
        nb: 0
    };
    obj.sum += value;
    obj.nb++;
};
const average = (key) => {
    increment(key);
    let t = +new Date();
    return {
        value: (val) => {
            setAverage(key, val);
        },
        time: () => {
            let duration = +new Date() - t; // milliseconds
            setAverage(key, duration);
        }
    };
};

// Only called from main thread:

let monitoringData = {};
const applyValues = (data) => {
    monitoringData[data.pid] = data;
};
const clearValues = (pid) => {
    delete monitoringData[pid];
};
const resetValues = () => {
    monitoringData = {};
};

let lastTime;
const getFreq = (value, time, noRound) => {
    if (!lastTime) { return 0; }

    // last.time exists, we can get a frequency
    // use the provided time (cpu usage) or now (number of calls)
    let diffTime = (time - lastTime)/1000;
    let val = value/diffTime || 0;
    let freq = noRound ? val : Math.floor(10*val)/10 || 0;

    return freq;
};
const processAll = (time) => {
    const data = monitoringData;
    let map = {
        other: {},
        calls: {} // value per second
    };
    let calls = {}; // total calls number
    const stats = {};

    Object.keys(data).forEach(pid => {
        let val = data[pid];
        let type = val.type;

        // Extract raw memory data
        let res = map[pid] = {
            type: val.type,
            mem: {},
            cpu: {}
        };
        let mem = res.mem;
        mem.rss = val.mem?.rss || 0;
        mem.heapTotal = val.mem?.heapTotal || 0;
        mem.heapUsed = val.mem?.heapUsed || 0;
        mem.external = val.mem?.external || 0;
        mem.arrayBuffers = val.mem?.arrayBuffers || 0;

        // Extract CPU data + percent use
        let cpu = res.cpu;
        cpu.user = (val.cpu?.user || 0) / 1000000;
        cpu.system = (val.cpu?.system || 0) / 1000000;
        cpu.total = cpu.user+cpu.system;
        cpu.percent = getFreq(cpu.total, time, true);

        // Main thread: get server data
        if (val.stats) {
            // Sum results from different front nodes
            Object.keys(val.stats).forEach(key => {
                stats[key] ||= 0;
                stats[key] += val.stats[key];
            });
        }

        // Number of incremented calls: SUM from all nodes
        if (val.calls) {
            Object.keys(val.calls).forEach(key => {
                let k = `${type}_${key}`;
                calls[k] ||= 0;
                calls[k] += val.calls[key];
            });
        }
    });

    map.other = stats;
    //map.other.reg = val.registered || 0;
    //map.other.channels = val.channels || 0;

    // Value per second for each "RPC" type
    Object.keys(calls).forEach(key => {
        map.calls[key] = getFreq(calls[key], time, false);
    });

    // Update lastTime
    lastTime = time;

    return map;
};

module.exports = {
    interval: 5000,
    increment, setValue, average,
    getData,
    applyValues,
    clearValues,
    resetValues,
    processAll
};
