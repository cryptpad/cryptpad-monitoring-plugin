module.exports = {
    logStdout: false,
    pingInterval: 5000,
    httpAddress: 'localhost',
    httpPort: 4000,
    websocketURL: 'http://localhost:3000',

    // Drive connect monitor
    driveMonitorEnabled: true,
    driveUsername: 'admin',
    drivePassword: 'xwikirox',
    driveInterval: 30000,
    driveTimeout: 60000,
    driveAlertThresholdMs: 15000,
    alertMailTo: ''
};
