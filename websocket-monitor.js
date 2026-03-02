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
const debugMode = cliArgs.includes('--debug');
const alertMode = cliArgs.includes('--alert');
const reportOnAlertMode = alertMode && cliArgs.includes('--report-on-alert');
const mailOnAlertMode = alertMode && cliArgs.includes('--mail-on-alert');
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
const alertMailTo = config?.alertMailTo;
const alertMailFrom = config?.alertMailFrom || `websocket-monitor@${Os.hostname()}`;
const localCryptpadSourcePath = Path.resolve(__dirname, 'cryptpad');
const cryptpadSourcePath = Fs.existsSync(localCryptpadSourcePath) ?
    localCryptpadSourcePath :
    Path.resolve(__dirname, '../cryptpad');

const log = config?.logStdout ? console.log : () => {};
const debugLog = (...args) => {
    if (!debugMode) { return; }
    log(...args);
};
const iso = (t) => new Date(t).toISOString();
const slowDriveLimit = 3;
let slowDriveStreak = 0;
let slowDriveEvents = [];
let reportTriggered = false;
let mailTriggered = false;


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
const driveAlertsLastHourMetric = new Prometheus.Gauge({
    name: `ws_drive_alerts_last_hour`,
    help: 'Number of DRIVE threshold alerts emitted in the last hour'
});

const ALERT_WINDOW_MS = 60 * 60 * 1000;
let driveAlertTimestamps = [];
const updateDriveAlertsLastHourMetric = (now = Date.now()) => {
    driveAlertTimestamps = driveAlertTimestamps.filter((ts) => now - ts <= ALERT_WINDOW_MS);
    driveAlertsLastHourMetric.set(alertMode ? driveAlertTimestamps.length : 0);
};
updateDriveAlertsLastHourMetric();

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
        driveConnectMetric.set(time);
        driveConnectOkMetric.set(1);
        log(`DRIVE ${iso(start)} ${time}ms`);
        if (alertMode) {
            if (time > driveAlertThresholdMs) {
                slowDriveStreak++;
                slowDriveEvents.push(`${iso(start)} ${time}ms`);
                if (slowDriveEvents.length > slowDriveLimit) {
                    slowDriveEvents = slowDriveEvents.slice(-slowDriveLimit);
                }
                if (slowDriveStreak === slowDriveLimit) {
                    driveAlertTimestamps.push(Date.now());
                    updateDriveAlertsLastHourMetric();
                    console.error(`WARNING: drive connection threshold exceeded ${slowDriveEvents.join(' | ')}`);
                    reportOnSlowDrives();
                    mailOnSlowDrives();
                }
            } else {
                slowDriveStreak = 0;
                slowDriveEvents = [];
            }
        }
        if (debugMode) {
            const counts = {
                ...getDriveCounts(rt),
                ...shared,
                ...teams
            };
            log('Drive content', counts);
        }
    } catch (e) {
        driveConnectOkMetric.set(0);
        if (alertMode) {
            slowDriveStreak = 0;
            slowDriveEvents = [];
        }
        console.error('Drive monitor error:', e.message || e);
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
        try {
            updateDriveAlertsLastHourMetric();
            const websocketStart = Date.now();
            network = await monitorDeps.Netflux.connect('', () => {
                socket = new WebSocket(activeUrl);
                return socket;
            });
            const websocketTime = Date.now() - websocketStart;
            websocketConnectMetric.set(websocketTime);
            log(`WEBSOCKET ${iso(websocketStart)} ${websocketTime}ms`);

            await runPingCheck(network, socket);

            chan = await network.join(channel);
            const historyKeeper = await waitForHistoryKeeper(chan, pingInterval);
            await runRpcCheck(network, historyKeeper);

            const now = Date.now();
            const shouldRunDrive = driveMonitorEnabled && driveDeps && (now - lastDriveCheckAt >= driveInterval);
            if (shouldRunDrive) {
                await runDriveCheck(network);
                lastDriveCheckAt = Date.now();
            }
        } catch (e) {
            const message = String(e?.message || e || '');
            if (activeUrl === primaryUrl && fallbackUrl !== primaryUrl && /EPROTO|wrong version number/i.test(message)) {
                activeUrl = fallbackUrl;
                console.log('WebSocket TLS mismatch detected, retrying with', activeUrl);
                logActiveEndpoints();
            } else {
                console.error('Combined monitor error:', message);
            }
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
