module.exports = {
    logStdout: true,
    pingInterval: 5000,
    httpAddress: 'localhost',
    httpPort: 4000,
    websocketURL: 'https://api.cryptpad.fr',

    driveMonitorEnabled: true,
    driveUsername: 'perftest',
    drivePassword: 'h8jvuTEgg69hEr9CWnHsYEfw',
    driveInterval: 30000,
    driveTimeout: 60000,
    driveAlertThresholdMs: 10000,
    metricsAlertThresholdMs: 10000,
    driveAlertWindowMs: 185000,
    alertExtraCommand: './extracommand.sh',
    alertMailTo: 'ludovic@xwiki.com'
};
