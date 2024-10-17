const VALUES = {};
VALUES.mem = () => {
    return process.memoryUsage();
};
let oldCpu;
VALUES.cpu = () => {
    if (!oldCpu) {
        oldCpu = process.cpuUsage();
        return {user:0,system:0};
    }
    let val = process.cpuUsage(oldCpu);
    oldCpu = process.cpuUsage();
    return val;
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
    calls[key] = (calls[key] || 0) + value;
};

// Only called from main thread:
const monitoringData = {};
const applyValues = (data) => {
    monitoringData[data.pid] = data;
};
const clearValues = (pid) => {
    delete monitoringData[pid];
};
const getValues = () => monitoringData;

module.exports = {
    interval: 5000,
    increment,
    getData,
    applyValues,
    clearValues,
    getValues
};
