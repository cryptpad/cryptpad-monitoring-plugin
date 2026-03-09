module.exports = {
    logStdout: true,
    pingInterval: 5000,
    httpAddress: 'localhost',
    httpPort: 4000,
    websocketURL: 'http://localhost:3000',
    alertMailTo: 'ludovic@xwiki.com',
    driveMonitorEnabled: true,
    driveUsername: 'perftest',
    drivePassword: '<unknown>',
    driveInterval: 30000,
    driveTimeout: 60000,
    driveAlertThresholdMs: 1500,
    metricsAlertThresholdMs: 10000,
    driveAlertWindowMs: 60000,
    alertExtraCommand: './extracommand.sh',
    alertMailTo: ''
};
