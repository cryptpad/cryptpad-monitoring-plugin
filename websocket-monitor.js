const WebSocket = require('ws').WebSocket;
const Http = require('node:http');
const Fs = require('node:fs');
const Path = require('node:path');
const Module = require('node:module');
const Os = require('node:os');
const ChildProcess = require('node:child_process');
const Express = require('express');
const app = Express();

const localNodeModules = Path.resolve(__dirname, 'node_modules');
if (!Module.globalPaths.includes(localNodeModules)) {
    Module.globalPaths.push(localNodeModules);
}
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    try {
        return resolveFilename.call(this, request, parent, isMain, options);
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND' && !Path.isAbsolute(request) && request[0] !== '.') {
            const fallbackRequest = Path.join(localNodeModules, request);
            return resolveFilename.call(this, fallbackRequest, parent, isMain, options);
        }
        throw err;
    }
};

// Load Prometheus
let Prometheus;
try { Prometheus = require('prom-client'); } catch (e) {}

// Load config
const cliArgs = process.argv.slice(2);

const showHelp = () => {
    console.log(`
CryptPad WebSocket Monitor

Usage: node websocket-monitor.js [options] [configname]

Options:
  --debug                    Print detailed debug output
  --alert                    Enable alert mode for slow/failing DRIVE checks
  --report-on-alert          Send SIGQUIT to main server on critical outage
  --mail-on-alert            Send email on alerts (requires alertMailTo in config)
  --extra-command-on-alert   Run extra command on critical outage (requires alertExtraCommand in config)
  --withdrive                Enable DRIVE connection monitoring
  --help                     Show this help message

Config:
  The configname argument loads ws-config-<configname>.js.
  Default config is ws-config.js.

Config options (in ws-config.js):
  - websocketURL           WebSocket URL (default: ws://localhost:3000/cryptpad_websocket)
  - httpPort               HTTP port for metrics (default: 4000)
  - pingInterval           Interval between checks in ms (default: 5000)
  - driveInterval          Interval for DRIVE checks in ms
  - driveTimeout           Timeout for DRIVE connection in ms
  - driveAlertThresholdMs  Threshold for slow DRIVE alert in ms
  - metricsAlertThresholdMs  Window for outage detection in ms (default: 180000 = 3 min)
  - driveAlertWindowMs     Window for drive unhealthy detection in ms (default: 60000 = 1 min)
  - alertExtraCommandGracePeriodMs  Grace period before re-running extra command (default: 300000 = 5 min)
  - alertMailTo            Email recipient for alerts
  - alertMailFrom          Email sender (default: websocket-monitor@<hostname>)
  - logStdout              Enable stdout logging (default: false)

Examples:
  node websocket-monitor.js                         # Run with default config
  node websocket-monitor.js localhost               # Run with ws-config-localhost.js
  node websocket-monitor.js --withdrive --alert      # Enable DRIVE monitoring with alerts
  node websocket-monitor.js --help                  # Show this help
`);
    process.exit(0);
};

if (cliArgs.includes('--help')) {
    showHelp();
}

const debugMode = cliArgs.includes('--debug');
const alertMode = cliArgs.includes('--alert');
const reportOnAlertMode = alertMode && cliArgs.includes('--report-on-alert');
const mailOnAlertMode = alertMode && cliArgs.includes('--mail-on-alert');
const extraCommandOnAlertMode = alertMode && cliArgs.includes('--extra-command-on-alert');
const withDriveMode = cliArgs.includes('--withdrive');
const configName = cliArgs.find((arg) => !arg.startsWith('--'));
const configFile = configName ? `ws-config-${configName}.js` : 'ws-config.js';
const configPath = Path.join(__dirname, configFile);

let config = {};
try {
    config = require(configPath);
} catch (e) {
    if (configName) {
        console.error(`Could not load config file: ${configFile}`);
        console.error('Expected path:', configPath);
        process.exit(1);
    }
}

const configuredUrl = config?.websocketURL || 'ws://localhost:3000/cryptpad_websocket';
const httpPort = config?.httpPort || 4000;
const httpAddress = config?.httpAddress || '::';
const pingInterval = (Number(config?.pingInterval) > 0) ? Number(config.pingInterval) : 5000;

const driveInterval = (Number(config?.driveInterval) > 0) ? Number(config.driveInterval) : undefined;
const driveIntervalConfigured = typeof driveInterval === 'number';
const driveMonitorEnabled = withDriveMode && driveIntervalConfigured && config?.driveMonitorEnabled !== false;
const driveUsername = config?.driveUsername || 'perftest';
const drivePassword = config?.drivePassword || 'preftest2026';
const driveTimeout = config?.driveTimeout || 60000;
const driveAlertThresholdMs = config?.driveAlertThresholdMs || 15000;
const metricsAlertThresholdMs = (Number(config?.metricsAlertThresholdMs) > 0) ? Number(config.metricsAlertThresholdMs) : 3 * 60 * 1000;
const driveAlertWindowMs = (Number(config?.driveAlertWindowMs) > 0) ? Number(config.driveAlertWindowMs) : 60 * 1000;
const alertExtraCommandGracePeriodMs = (Number(config?.alertExtraCommandGracePeriodMs) > 0) ? Number(config.alertExtraCommandGracePeriodMs) : 5 * 60 * 1000;
const alertExtraCommand = typeof config?.alertExtraCommand === 'string' ? config.alertExtraCommand.trim() : '';
const alertMailTo = config?.alertMailTo;
const alertMailFrom = config?.alertMailFrom || `websocket-monitor@${Os.hostname()}`;
const localCryptpadSourcePath = Path.resolve(__dirname, 'cryptpad');
const cryptpadSourcePath = Fs.existsSync(localCryptpadSourcePath) ?
    localCryptpadSourcePath :
    Path.resolve(__dirname, '../cryptpad');

const log = config?.logStdout ? console.log : () => {};
const debugLog = (...args) => {
    if (!debugMode) { return; }
    console.log(...args);
};
const monitorStartTime = Date.now();
const logError = (prefix, error) => {
    const message = error?.message || String(error || 'Unknown error');
    console.error(prefix, message);
    if (!debugMode) { return; }
    if (error?.stack) {
        console.error(error.stack);
        return;
    }
    if (error && typeof error === 'object') {
        console.error(error);
    }
};
const markMetricSuccess = (name, at = Date.now()) => {
    if (!Object.hasOwn(metricSuccessAt, name)) { return; }
    metricSuccessAt[name] = at;
};
const getMetricOutages = (now = Date.now()) => {
    const names = ['websocket', 'ping', 'rpc'];
    return names
        .map((name) => {
            const lastOk = metricSuccessAt[name] || 0;
            const downtimeMs = lastOk === 0 ? (now - monitorStartTime) : (now - lastOk);
            if (downtimeMs <= metricsAlertThresholdMs) { return; }
            return { name, downtimeMs, neverOk: lastOk === 0 };
        })
        .filter(Boolean);
};
const runExtraCommandOnOutage = (reason) => {
    if (!extraCommandOnAlertMode || !alertExtraCommand) { return; }
    const now = Date.now();
    if (extraCommandTriggered && (now - extraCommandLastTriggeredAt < alertExtraCommandGracePeriodMs)) { return; }
    try {
        ChildProcess.exec(alertExtraCommand, {
            env: {
                ...process.env,
                WS_MONITOR_ALERT_REASON: reason,
                WS_MONITOR_ALERT_HOST: Os.hostname(),
                WS_MONITOR_ALERT_API: getActiveApiOrigin()
            }
        }, (error) => {
            if (error) {
                logError('ALERT COMMAND failed:', error);
            }
        });
        extraCommandTriggered = true;
        extraCommandLastTriggeredAt = now;
        console.error(`ALERT COMMAND launched: ${alertExtraCommand}`);
    } catch (e) {
        logError('ALERT COMMAND failed to launch:', e);
    }
};
const mailOnOutageAlert = (details, reason) => {
    if (!mailOnAlertMode || outageMailTriggered) { return; }
    if (!alertMailTo) {
        console.error('MAIL failed: missing alertMailTo in config');
        return;
    }
    const subject = `[websocket-monitor] CRITICAL monitoring outage on ${Os.hostname()}`;
    const bodyLines = [
        `Host: ${Os.hostname()}`,
        `API: ${getActiveApiOrigin()}`,
        `Reason: ${reason}`,
        `Outages: ${details}`,
        `Drive unhealthy streak: ${slowDriveStreak}`,
        `Recent drive events: ${slowDriveEvents.join(' | ') || 'none'}`
    ];
    const mail = [
        `To: ${alertMailTo}`,
        `From: ${alertMailFrom}`,
        `Subject: ${subject}`,
        '',
        ...bodyLines,
        ''
    ].join('\n');

    try {
        const proc = ChildProcess.spawnSync('sendmail', ['-t'], {
            input: mail,
            encoding: 'utf8'
        });
        if (proc.error) {
            throw proc.error;
        }
        if (proc.status !== 0) {
            throw new Error((proc.stderr || proc.stdout || 'sendmail failed').trim());
        }
        outageMailTriggered = true;
        console.error(`MAIL sent to ${alertMailTo} (outage alert)`);
    } catch (e) {
        console.error('MAIL failed:', e.message || e);
    }
};
const maybeTriggerOutageAlert = (now = Date.now()) => {
    if (!alertMode) { return; }
    if (!driveMonitorEnabled || !driveDeps) { return; }
    const outages = getMetricOutages(now);
    const metricsUnavailableTooLong = outages.length > 0;

    const driveDowntimeMs = driveLastSuccessAt === 0 ? (now - monitorStartTime) : (now - driveLastSuccessAt);
    const driveUnhealthy = driveDowntimeMs > driveAlertWindowMs;

    const driveSlowtimeMs = driveFirstOverThresholdAt === 0 ? 0 : (now - driveFirstOverThresholdAt);
    const driveSlowTooLong = driveSlowtimeMs > driveAlertWindowMs;

    const shouldAlert = metricsUnavailableTooLong || driveUnhealthy || driveSlowTooLong;

    if (!shouldAlert) {
        if (!driveUnhealthy && !driveSlowTooLong) {
            extraCommandTriggered = false;
            outageMailTriggered = false;
        }
        return;
    }

    let reasonParts = [];
    if (metricsUnavailableTooLong) {
        const details = outages.map((outage) => `${outage.name}=${Math.floor(outage.downtimeMs / 1000)}s`).join(', ');
        reasonParts.push(`metrics-unreachable: ${details}`);
    }
    if (driveUnhealthy) {
        reasonParts.push(`drive-unreachable: ${Math.floor(driveDowntimeMs / 1000)}s (threshold: ${driveAlertWindowMs}ms)`);
    }
    if (driveSlowTooLong) {
        reasonParts.push(`drive-slow: ${Math.floor(driveSlowtimeMs / 1000)}s over threshold ${driveAlertThresholdMs}ms (threshold: ${driveAlertWindowMs}ms)`);
    }
    const reason = reasonParts.join('; ');
    console.error(`ALERT: monitoring outage detected (${reason})`);
    runExtraCommandOnOutage(reason);
    mailOnOutageAlert(reason, reason);
};
const iso = (t) => new Date(t).toISOString();
const slowDriveLimit = 3;
let slowDriveStreak = 0;
let slowDriveEvents = [];
let reportTriggered = false;
let mailTriggered = false;
let extraCommandTriggered = false;
let extraCommandLastTriggeredAt = 0;
let outageMailTriggered = false;
let driveLastSuccessAt = 0;
let driveFirstOverThresholdAt = 0;
const metricSuccessAt = {
    websocket: 0,
    ping: 0,
    rpc: 0
};


// Prepare Prometheus
const pingMetric = new Prometheus.Gauge({
    name: `ws_ping`,
    help: 'Time in milliseconds before receiving a response to our PING'
});
const rpcMetric = new Prometheus.Gauge({
    name: `ws_rpc`,
    help: 'Time in milliseconds before receiving a response to our RPC command'
});
const websocketConnectMetric = new Prometheus.Gauge({
    name: `ws_websocket`,
    help: 'Time in milliseconds to establish the websocket connection'
});
const driveConnectMetric = new Prometheus.Gauge({
    name: `ws_drive_connect`,
    help: 'Time in milliseconds to fully reconnect and load the configured user drive'
});
const driveConnectOkMetric = new Prometheus.Gauge({
    name: `ws_drive_connect_ok`,
    help: '1 if the latest drive reconnect+load check succeeded, 0 otherwise'
});
const driveOverThresholdLast15MinMetric = new Prometheus.Gauge({
    name: `ws_drive_over_threshold_last_hour`,
    help: 'Percent of DRIVE checks over threshold in the last 15 minutes (0-100)'
});

pingMetric.set(NaN);
rpcMetric.set(NaN);
websocketConnectMetric.set(NaN);
driveConnectMetric.set(NaN);
driveConnectOkMetric.set(0);

const ALERT_WINDOW_MS = 15 * 60 * 1000;
let driveCheckTimestamps = [];
let driveOverThresholdTimestamps = [];
const updateDriveOverThresholdLast15MinMetric = (now = Date.now()) => {
    driveCheckTimestamps = driveCheckTimestamps.filter((ts) => now - ts <= ALERT_WINDOW_MS);
    driveOverThresholdTimestamps = driveOverThresholdTimestamps.filter((ts) => now - ts <= ALERT_WINDOW_MS);
    const total = driveCheckTimestamps.length;
    const over = driveOverThresholdTimestamps.length;
    const percent = total > 0 ? Number(((over * 100) / total).toFixed(2)) : 0;
    driveOverThresholdLast15MinMetric.set(percent);
};
updateDriveOverThresholdLast15MinMetric();

app.get('/wsmetrics', (req, res) => {
    Prometheus.register.metrics().then((data) => {
        res.set('Content-Type', Prometheus.register.contentType);
        res.send(data);
    });
});

// Start HTTP server
const server = Http.createServer(app);
server.listen(httpPort, httpAddress, () => {
    console.log(`Metrics available at http://${httpAddress}:${httpPort}/wsmetrics`);
});

// Get metrics
let seq = 0;
let seqRpc = 0;
let responses = {};
let responsesRpc = {};
const channel = '00000000000000000000000000000000';

const normalizeWebsocketUrl = (inputUrl) => {
    const u = new URL(inputUrl);
    if (u.protocol === 'ws:' || u.protocol === 'wss:') {
        if (!u.pathname || u.pathname === '/') {
            u.pathname = '/cryptpad_websocket';
        }
        return u.toString();
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') {
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        if (!u.pathname || u.pathname === '/') {
            u.pathname = '/cryptpad_websocket';
        }
        return u.toString();
    }
    throw new Error('Unsupported websocketURL protocol: ' + u.protocol);
};

const downgradeWebsocketUrl = (wsUrl) => {
    const u = new URL(wsUrl);
    if (u.protocol === 'wss:') {
        u.protocol = 'ws:';
    }
    return u.toString();
};

const primaryUrl = normalizeWebsocketUrl(configuredUrl);
const fallbackUrl = downgradeWebsocketUrl(primaryUrl);
const shouldPreferWsFirst = (() => {
    try {
        const configured = new URL(configuredUrl);
        if (configured.protocol === 'http:' || configured.protocol === 'ws:') { return true; }
        if (configured.protocol === 'https:' || configured.protocol === 'wss:') {
            return /^(localhost|127\.0\.0\.1|::1)$/i.test(configured.hostname);
        }
    } catch (e) {}
    return false;
})();
let activeUrl = shouldPreferWsFirst ? fallbackUrl : primaryUrl;

const normalizeHttpOriginFromWs = (wsUrl) => {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    return u.origin;
};

const getActiveApiOrigin = () => normalizeHttpOriginFromWs(activeUrl);
const logActiveEndpoints = () => {
    console.log('Active websocket endpoint:', activeUrl);
    console.log('Active server API:', getActiveApiOrigin());
};

const getMainServerPid = () => {
    const out = ChildProcess.execSync(
        'ps -eaf | grep node | grep /home/cryptpad/cryptpad/server.js | grep -v grep',
        { encoding: 'utf8' }
    ).trim();
    if (!out) { return; }
    const firstLine = out.split('\n')[0].trim();
    const parts = firstLine.split(/\s+/);
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) { return; }
    return pid;
};

const reportOnSlowDrives = () => {
    if (!reportOnAlertMode || reportTriggered || slowDriveStreak < slowDriveLimit) { return; }
    try {
        const pid = getMainServerPid();
        if (!pid) {
            throw new Error('Could not find main server PID');
        }
        process.kill(pid, 'SIGQUIT');
        reportTriggered = true;
        console.error(`REPORT SIGQUIT sent to main node process pid=${pid}`);
    } catch (e) {
        console.error('REPORT failed to send SIGQUIT:', e.message || e);
    }
};

const mailOnSlowDrives = () => {
    if (!mailOnAlertMode || mailTriggered || slowDriveStreak < slowDriveLimit) { return; }
    if (!alertMailTo) {
        console.error('MAIL failed: missing alertMailTo in config');
        return;
    }
    const subject = `[websocket-monitor] DRIVE threshold exceeded on ${Os.hostname()}`;
    const bodyLines = [
        `Host: ${Os.hostname()}`,
        `API: ${getActiveApiOrigin()}`,
        `Threshold: ${driveAlertThresholdMs}ms`,
        `Consecutive limit: ${slowDriveLimit}`,
        `Events: ${slowDriveEvents.join(' | ')}`
    ];
    const mail = [
        `To: ${alertMailTo}`,
        `From: ${alertMailFrom}`,
        `Subject: ${subject}`,
        '',
        ...bodyLines,
        ''
    ].join('\n');

    try {
        const proc = ChildProcess.spawnSync('sendmail', ['-t'], {
            input: mail,
            encoding: 'utf8'
        });
        if (proc.error) {
            throw proc.error;
        }
        if (proc.status !== 0) {
            throw new Error((proc.stderr || proc.stdout || 'sendmail failed').trim());
        }
        mailTriggered = true;
        console.error(`MAIL sent to ${alertMailTo}`);
    } catch (e) {
        console.error('MAIL failed:', e.message || e);
    }
};

const loadDriveDeps = () => {
    const fromCryptPad = (p) => require(Path.join(cryptpadSourcePath, p));
    const deps = {
        Cred: fromCryptPad('src/common/common-credential.js'),
        Block: fromCryptPad('src/common/outer/login-block.js'),
        Hash: fromCryptPad('src/common/common-hash.js'),
        Util: fromCryptPad('src/common/common-util.js'),
        Constants: fromCryptPad('src/common/common-constants.js'),
        Listmap: require('chainpad-listmap'),
        CpCrypto: require('chainpad-crypto'),
        ChainPad: require('chainpad')
    };

    const apiOrigin = normalizeHttpOriginFromWs(activeUrl);
    deps.Block.setCustomize({
        ApiConfig: {
            fileHost: apiOrigin,
            httpUnsafeOrigin: apiOrigin
        }
    });

    return deps;
};

let monitorDeps;
try {
    monitorDeps = {
        Netflux: require('netflux-websocket')
    };
} catch (e) {
    console.error('Websocket monitor disabled: missing dependency netflux-websocket', e.message);
    process.exit(1);
}

let driveDeps;
if (driveMonitorEnabled) {
    try {
        driveDeps = loadDriveDeps();
    } catch (e) {
        console.error('Drive monitor disabled: missing CryptPad dependencies', e.message);
    }
} else if (!withDriveMode) {
    console.log('Drive checks disabled by default (pass --withdrive to enable)');
} else if (!driveIntervalConfigured) {
    console.log('Drive checks disabled: missing driveInterval in config');
} else if (config?.driveMonitorEnabled === false) {
    console.log('Drive checks disabled by config (driveMonitorEnabled: false)');
} else {
    console.log('Drive checks disabled');
}

const deriveBytes = (username, password, bytes) => new Promise((resolve) => {
    driveDeps.Cred.deriveFromPassphrase(username, password, bytes, resolve);
});

const getDriveSecrets = async () => {
    const apiOrigin = normalizeHttpOriginFromWs(activeUrl);
    driveDeps.Block.setCustomize({
        ApiConfig: {
            fileHost: apiOrigin,
            httpUnsafeOrigin: apiOrigin
        }
    });

    const bytes = await deriveBytes(driveUsername.toLowerCase(), drivePassword, 192);
    const consume = driveDeps.Cred.dispenser(bytes);

    const encryptionSeed = consume(18);
    const channelSeed = consume(16);
    consume(32);
    consume(32);
    const blockSeed = consume(64);

    const blockKeys = driveDeps.Block.genkeys(new Uint8Array(blockSeed));
    const blockUrl = driveDeps.Block.getBlockUrl(blockKeys);
    const resp = await fetch(blockUrl);

    let userHash;
    if (resp.ok) {
        const ciphertext = new Uint8Array(await resp.arrayBuffer());
        const blockInfo = driveDeps.Block.decrypt(ciphertext, blockKeys);
        userHash = blockInfo && (blockInfo[driveDeps.Constants.userHashKey] || blockInfo.User_hash);
        if (!userHash) { throw new Error('Missing user hash in login block'); }
    } else if (resp.status === 404) {
        const keys = driveDeps.CpCrypto.createEditCryptor(null, encryptionSeed);
        const channelHex = driveDeps.Util.uint8ArrayToHex(channelSeed);
        const channel64 = driveDeps.Util.hexToBase64(channelHex);
        userHash = '/1/edit/' + [channel64, keys.editKeyStr.replace(/\//g, '-')].join('/') + '/';
    } else {
        throw new Error('Cannot load login block (' + resp.status + ')');
    }

    return driveDeps.Hash.getSecrets('drive', userHash);
};

const waitForDriveReady = (rt) => new Promise((resolve, reject) => {
    const to = setTimeout(() => {
        reject(new Error('Drive ready timeout'));
    }, driveTimeout);
    rt.proxy
        .on('ready', () => {
            clearTimeout(to);
            resolve();
        })
        .on('error', (info) => {
            clearTimeout(to);
            reject(new Error(info?.type || info?.message || 'Drive error'));
        })
        .on('disconnect', () => {
            clearTimeout(to);
            reject(new Error('Drive disconnected before ready'));
        });
});

const cleanupDriveRt = (rt) => {
    if (!rt) { return; }
    try { rt.realtime?.abort?.(); } catch (e) {}
    try { rt.realtime?.stop?.(); } catch (e) {}
};

const cleanupNetwork = (network) => {
    if (!network) { return; }
    try { network.disconnect?.(); } catch (e) {}
};

const getHistoryKeeper = (chan) => {
    const members = chan?.members || [];
    return members.find((id) => id && id.length === 16 && id !== chan.myID);
};

const waitForHistoryKeeper = (chan, timeoutMs) => new Promise((resolve, reject) => {
    const existing = getHistoryKeeper(chan);
    if (existing) { return resolve(existing); }
    const to = setTimeout(() => {
        chan.off('join', onJoin);
        reject(new Error('No historyKeeper in channel'));
    }, timeoutMs);
    const onJoin = (id) => {
        if (!id || id.length !== 16 || id === chan.myID) { return; }
        clearTimeout(to);
        chan.off('join', onJoin);
        resolve(id);
    };
    chan.on('join', onJoin);
});

const runPingCheck = async (network, socket) => {
    const start = Date.now();
    if (socket && typeof socket.ping === 'function' && typeof socket.once === 'function') {
        await new Promise((resolve, reject) => {
            const to = setTimeout(() => {
                socket.off('pong', onPong);
                reject(new Error('WebSocket ping timeout'));
            }, pingInterval);
            const onPong = () => {
                clearTimeout(to);
                resolve();
            };
            socket.once('pong', onPong);
            try {
                socket.ping();
            } catch (e) {
                clearTimeout(to);
                socket.off('pong', onPong);
                reject(e);
            }
        });

        const lag = Date.now() - start;
        pingMetric.set(lag);
        log(`PING ${iso(start)} ${lag}ms`);
        return;
    }

    const lag = network.getLag();
    if (typeof lag !== 'number') {
        throw new Error('No lag available yet');
    }
    const requestAt = Math.max(0, start - Math.max(0, lag));
    pingMetric.set(lag);
    log(`PING ${iso(requestAt)} ${lag}ms`);
};

const runRpcCheck = async (network, historyKeeper) => {
    const txid = ++seqRpc;
    const payload = JSON.stringify([txid, ['GET_FILE_SIZE', channel]]);
    const start = +new Date();
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => {
            network.off('message', onMessage);
            reject(new Error('RPC timeout'));
        }, pingInterval);
        const onMessage = (content, sender) => {
            if (sender !== historyKeeper) { return; }
            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch (e) {
                return;
            }
            if (parsed[0] !== txid) { return; }
            clearTimeout(to);
            network.off('message', onMessage);
            resolve();
        };
        network.on('message', onMessage);
        network.sendto(historyKeeper, payload).catch((e) => {
            clearTimeout(to);
            network.off('message', onMessage);
            reject(e);
        });
    });

    const time = (+new Date()) - start;
    rpcMetric.set(time);
    log(`RPC ${iso(start)} ${time}ms`);
};

const getDriveCounts = (rt) => {
    const drive = rt?.proxy?.drive || rt?.proxy;
    const root = drive?.root || {};
    const filesData = drive?.filesData || {};
    const sharedFolders = drive?.sharedFolders || {};

    let rootFolders = 0;
    let rootDocuments = 0;
    let rootSharedFolders = 0;

    Object.keys(root).forEach((name) => {
        const value = root[name];
        if (value && typeof value === 'object') {
            rootFolders++;
            return;
        }
        const id = String(value);
        if (Object.prototype.hasOwnProperty.call(sharedFolders, id)) {
            rootSharedFolders++;
            return;
        }
        rootDocuments++;
    });

    return {
        rootFolders,
        rootDocuments,
        rootSharedFolders,
        totalFilesData: Object.keys(filesData).length,
        totalSharedFolders: Object.keys(sharedFolders).length
    };
};

const getDriveProxy = (rt) => rt?.proxy?.drive || rt?.proxy || {};

const makeHrefDecryptor = (secondaryKey) => {
    if (!secondaryKey) { return; }
    try {
        const cryptor = driveDeps.CpCrypto.createEncryptor(secondaryKey);
        return (value) => {
            if (!value || typeof value !== 'string') { return; }
            try {
                return cryptor.decrypt(value);
            } catch (e) {
                return;
            }
        };
    } catch (e) {
        return;
    }
};

const resolveSharedFolderHref = (meta, decryptHref) => {
    const candidate = meta?.href || meta?.roHref;
    if (!candidate) { return; }
    if (candidate.indexOf('#') !== -1) { return candidate; }
    const decrypted = decryptHref?.(candidate);
    if (decrypted && decrypted.indexOf('#') !== -1) {
        return decrypted;
    }
};

const getSharedFolderEntries = (drive) => {
    const sharedFolders = drive?.sharedFolders || {};
    const sharedFoldersTemp = drive?.sharedFoldersTemp || {};
    const entries = Object.entries(sharedFolders).map(([id, meta]) => ({ id, meta }));
    Object.entries(sharedFoldersTemp).forEach(([id, meta]) => {
        entries.push({ id, meta });
    });
    return entries;
};

const resolveDriveUrl = (href) => {
    const origin = normalizeHttpOriginFromWs(activeUrl);
    return new URL(href, origin).toString();
};

const createDriveRtFromSecret = (secret, network) => {
    const config = {
        network: network,
        channel: secret.channel,
        data: {},
        validateKey: secret.keys?.validateKey,
        crypto: driveDeps.CpCrypto.createEncryptor(secret.keys),
        logLevel: 1,
        classic: true,
        ChainPad: driveDeps.ChainPad
    };
    return driveDeps.Listmap.create(config);
};

const getSharedFolderDocsCount = async (rt, network, connectedRts, loadedChannels, secondaryKey) => {
    const drive = getDriveProxy(rt);
    const entries = getSharedFolderEntries(drive);
    const decryptHref = makeHrefDecryptor(secondaryKey);
    let loadedSharedFolders = 0;
    let totalDocumentsInSharedFolders = 0;

    for (const { id, meta } of entries) {
        const href = resolveSharedFolderHref(meta, decryptHref);
        if (!href) { continue; }
        try {
            const parsed = driveDeps.Hash.parsePadUrl(resolveDriveUrl(href));
            if (!parsed?.hash || !parsed?.type) { continue; }
            const sharedSecret = driveDeps.Hash.getSecrets(parsed.type, parsed.hash);
            if (loadedChannels?.has(sharedSecret.channel)) { continue; }
            const sharedRt = createDriveRtFromSecret(sharedSecret, network);
            connectedRts.push(sharedRt);
            await waitForDriveReady(sharedRt);
            if (loadedChannels) { loadedChannels.add(sharedSecret.channel); }

            const sharedDrive = getDriveProxy(sharedRt);
            const sharedFilesData = sharedDrive.filesData || {};
            const docs = Object.keys(sharedFilesData).length;
            totalDocumentsInSharedFolders += docs;
            loadedSharedFolders++;
            debugLog('Shared folder loaded', { id, docs });
        } catch (e) {
            debugLog('Shared folder load failed', { id, error: e?.message || e });
        }
    }

    return {
        loadedSharedFolders,
        totalDocumentsInSharedFolders
    };
};

const getTeamEntries = (mainRt) => {
    const proxy = mainRt?.proxy || {};
    const teams = proxy.teams || proxy?.drive?.teams || {};
    if (!teams || typeof teams !== 'object') { return []; }
    return Object.entries(teams).map(([id, data]) => ({ id, data }));
};

const getTeamSecret = (teamData) => {
    const hash = teamData?.hash || teamData?.roHash;
    if (hash) {
        return driveDeps.Hash.getSecrets('team', hash, teamData?.password);
    }
    const href = teamData?.href || teamData?.roHref;
    if (!href) { return; }
    const parsed = driveDeps.Hash.parsePadUrl(resolveDriveUrl(href));
    if (!parsed?.hash || !parsed?.type) { return; }
    return driveDeps.Hash.getSecrets(parsed.type, parsed.hash, teamData?.password);
};

const loadTeamDrivesAndShared = async (mainRt, network, connectedRts, loadedChannels) => {
    const teams = getTeamEntries(mainRt);
    let loadedTeamDrives = 0;
    let totalDocumentsInTeamDrives = 0;
    let loadedTeamSharedFolders = 0;
    let totalDocumentsInTeamSharedFolders = 0;

    for (const team of teams) {
        try {
            const secret = getTeamSecret(team.data);
            if (!secret) { continue; }
            if (loadedChannels?.has(secret.channel)) { continue; }

            const teamRt = createDriveRtFromSecret(secret, network);
            connectedRts.push(teamRt);
            await waitForDriveReady(teamRt);
            if (loadedChannels) { loadedChannels.add(secret.channel); }

            const teamDrive = getDriveProxy(teamRt);
            const teamDocs = Object.keys(teamDrive.filesData || {}).length;
            loadedTeamDrives++;
            totalDocumentsInTeamDrives += teamDocs;
            debugLog('Team drive loaded', { id: team.id, docs: teamDocs });

            const teamShared = await getSharedFolderDocsCount(
                teamRt,
                network,
                connectedRts,
                loadedChannels,
                secret.keys?.secondaryKey
            );
            loadedTeamSharedFolders += teamShared.loadedSharedFolders;
            totalDocumentsInTeamSharedFolders += teamShared.totalDocumentsInSharedFolders;
        } catch (e) {
            debugLog('Team drive load failed', { id: team.id, error: e?.message || e });
        }
    }

    return {
        totalTeams: teams.length,
        loadedTeamDrives,
        totalDocumentsInTeamDrives,
        loadedTeamSharedFolders,
        totalDocumentsInTeamSharedFolders
    };
};

const runDriveCheck = async (network) => {
    if (!driveMonitorEnabled || !driveDeps) { return; }
    const start = +new Date();
    const connectedRts = [];
    let rt;
    try {
        const secret = await getDriveSecrets();
        rt = createDriveRtFromSecret(secret, network);
        connectedRts.push(rt);
        await waitForDriveReady(rt);
        const loadedChannels = new Set([secret.channel]);

        const shared = await getSharedFolderDocsCount(
            rt,
            network,
            connectedRts,
            loadedChannels,
            secret.keys?.secondaryKey
        );
        const teams = await loadTeamDrivesAndShared(rt, network, connectedRts, loadedChannels);

        const time = (+new Date()) - start;
        driveCheckTimestamps.push(Date.now());
        updateDriveOverThresholdLast15MinMetric();
        driveConnectMetric.set(time);
        driveConnectOkMetric.set(1);
        driveLastSuccessAt = Date.now();
        markMetricSuccess('drive');
        log(`DRIVE ${iso(start)} ${time}ms`);
        if (time > driveAlertThresholdMs) {
            if (driveFirstOverThresholdAt === 0) {
                driveFirstOverThresholdAt = Date.now();
            }
            driveOverThresholdTimestamps.push(Date.now());
            updateDriveOverThresholdLast15MinMetric();
            if (debugMode) {
                log('Drive over-threshold recorded', {
                    durationMs: time,
                    thresholdMs: driveAlertThresholdMs,
                    overThresholdChecksLast15Min: driveOverThresholdTimestamps.length,
                    driveChecksLast15Min: driveCheckTimestamps.length,
                    overThresholdPercentLast15Min: Number(((driveOverThresholdTimestamps.length * 100) / driveCheckTimestamps.length).toFixed(2))
                });
            }
            if (alertMode) {
                slowDriveStreak++;
                slowDriveEvents.push(`${iso(start)} ${time}ms`);
                if (slowDriveEvents.length > slowDriveLimit) {
                    slowDriveEvents = slowDriveEvents.slice(-slowDriveLimit);
                }
                if (slowDriveStreak === slowDriveLimit) {
                    console.error(`WARNING: drive connection threshold exceeded ${slowDriveEvents.join(' | ')}`);
                    reportOnSlowDrives();
                    mailOnSlowDrives();
                }
            }
        } else if (alertMode) {
            driveFirstOverThresholdAt = 0;
            slowDriveStreak = 0;
            slowDriveEvents = [];
        }
        if (debugMode) {
            const counts = {
                ...getDriveCounts(rt),
                ...shared,
                ...teams
            };
            log('Drive content', counts);
        }
        maybeTriggerOutageAlert();
    } catch (e) {
        const failedAt = Date.now();
        driveCheckTimestamps.push(failedAt);
        driveOverThresholdTimestamps.push(failedAt);
        updateDriveOverThresholdLast15MinMetric(failedAt);
        driveConnectMetric.set(NaN);
        driveConnectOkMetric.set(0);
        if (alertMode) {
            slowDriveStreak++;
            slowDriveEvents.push(`${iso(start)} ERROR`);
            if (slowDriveEvents.length > slowDriveLimit) {
                slowDriveEvents = slowDriveEvents.slice(-slowDriveLimit);
            }
            if (slowDriveStreak === slowDriveLimit) {
                console.error(`WARNING: drive connection threshold exceeded ${slowDriveEvents.join(' | ')}`);
                reportOnSlowDrives();
                mailOnSlowDrives();
            }
        }
        logError('Drive monitor error:', e);
        maybeTriggerOutageAlert();
    } finally {
        connectedRts.forEach(cleanupDriveRt);
    }
};

const startCombinedMonitor = () => {
    let lastDriveCheckAt = 0;
    const tick = async () => {
        let network;
        let chan;
        let socket;
        let websocketCheckOk = false;
        let pingCheckOk = false;
        let rpcCheckOk = false;
        try {
            updateDriveOverThresholdLast15MinMetric();
            const websocketStart = Date.now();
            const connectWithTimeout = (ms, promise) => {
                return new Promise((resolve, reject) => {
                    const to = setTimeout(() => reject(new Error('WebSocket connect timeout')), ms);
                    promise.then((val) => { clearTimeout(to); resolve(val); }, (err) => { clearTimeout(to); reject(err); });
                });
            };
            try {
                network = await connectWithTimeout(10000, monitorDeps.Netflux.connect('', () => {
                    socket = new WebSocket(activeUrl);
                    socket.on('error', (err) => {
                        logError('WebSocket connection error:', err);
                    });
                    return socket;
                }));
            } catch (connErr) {
                throw connErr;
            }
            const websocketTime = Date.now() - websocketStart;
            websocketConnectMetric.set(websocketTime);
            markMetricSuccess('websocket');
            websocketCheckOk = true;
            log(`WEBSOCKET ${iso(websocketStart)} ${websocketTime}ms`);

            await runPingCheck(network, socket);
            markMetricSuccess('ping');
            pingCheckOk = true;

            chan = await network.join(channel);
            const historyKeeper = await waitForHistoryKeeper(chan, pingInterval);
            await runRpcCheck(network, historyKeeper);
            markMetricSuccess('rpc');
            rpcCheckOk = true;

            const now = Date.now();
            const shouldRunDrive = driveMonitorEnabled && driveDeps && (now - lastDriveCheckAt >= driveInterval);
            if (shouldRunDrive) {
                await runDriveCheck(network);
                lastDriveCheckAt = Date.now();
            }
            maybeTriggerOutageAlert();
        } catch (e) {
            const message = String(e?.message || e || '');
            if (activeUrl === primaryUrl && fallbackUrl !== primaryUrl && /EPROTO|wrong version number/i.test(message)) {
                activeUrl = fallbackUrl;
                console.log('WebSocket TLS mismatch detected, retrying with', activeUrl);
                logActiveEndpoints();
            } else {
                logError('Combined monitor error:', e);
            }
            if (!websocketCheckOk) {
                websocketConnectMetric.set(NaN);
            }
            if (!pingCheckOk) {
                pingMetric.set(NaN);
            }
            if (!rpcCheckOk) {
                rpcMetric.set(NaN);
            }
            maybeTriggerOutageAlert();
        } finally {
            try { chan?.leave?.('Monitoring'); } catch (e) {}
            cleanupNetwork(network);
        }
        setTimeout(tick, pingInterval);
    };
    setTimeout(tick, 1000);
};
logActiveEndpoints();
startCombinedMonitor();
