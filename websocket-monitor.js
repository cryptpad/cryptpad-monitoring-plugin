const WebSocket = require('ws').WebSocket;
const Http = require('node:http');
const Path = require('node:path');
const Module = require('node:module');
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
let config = {};
try {
    config = require('./ws-config');
} catch (e) {}

const configuredUrl = config?.websocketURL || 'ws://localhost:3000/cryptpad_websocket';
const httpPort = config?.httpPort || 4000;
const httpAddress = config?.httpAddress || '::';
const pingInterval = config?.pingInterval || 5000;

const driveMonitorEnabled = config?.driveMonitorEnabled !== false;
const driveUsername = config?.driveUsername || 'perftest';
const drivePassword = config?.drivePassword || 'preftest2026';
const driveInterval = config?.driveInterval || 5000;
const driveTimeout = config?.driveTimeout || 60000;
const cryptpadSourcePath = config?.cryptpadSourcePath || Path.resolve(__dirname, '../cryptpad');

const log = config?.logStdout ? console.log : () => {};


// Prepare Prometheus
const pingMetric = new Prometheus.Gauge({
    name: `ws_ping`,
    help: 'Time in milliseconds before receiving a response to our PING'
});
const rpcMetric = new Prometheus.Gauge({
    name: `ws_rpc`,
    help: 'Time in milliseconds before receiving a response to our RPC command'
});
const driveConnectMetric = new Prometheus.Gauge({
    name: `ws_drive_connect`,
    help: 'Time in milliseconds to fully reconnect and load the configured user drive'
});
const driveConnectOkMetric = new Prometheus.Gauge({
    name: `ws_drive_connect_ok`,
    help: '1 if the latest drive reconnect+load check succeeded, 0 otherwise'
});

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
        ChainPad: require('chainpad'),
        Netflux: require('netflux-websocket')
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

let driveDeps;
try {
    driveDeps = loadDriveDeps();
} catch (e) {
    console.error('Drive monitor disabled: missing CryptPad dependencies', e.message);
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

const runPingCheck = (network) => {
    const lag = network.getLag();
    if (typeof lag !== 'number') {
        throw new Error('No lag available yet');
    }
    pingMetric.set(lag);
    log('Last PING', lag);
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
    log('Last RPC response time', time);
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

const getSharedFolderDocsCount = async (mainRt, network, connectedRts) => {
    const drive = mainRt?.proxy?.drive || {};
    const sharedFolders = drive.sharedFolders || {};
    const entries = Object.entries(sharedFolders);
    let loadedSharedFolders = 0;
    let totalDocumentsInSharedFolders = 0;

    for (const [id, meta] of entries) {
        const href = meta?.href || meta?.roHref;
        if (!href) { continue; }
        try {
            const parsed = driveDeps.Hash.parsePadUrl(resolveDriveUrl(href));
            if (!parsed?.hash || !parsed?.type) { continue; }
            const sharedSecret = driveDeps.Hash.getSecrets(parsed.type, parsed.hash);
            const sharedRt = createDriveRtFromSecret(sharedSecret, network);
            connectedRts.push(sharedRt);
            await waitForDriveReady(sharedRt);

            const sharedDrive = sharedRt?.proxy || {};
            const sharedFilesData = sharedDrive.filesData || {};
            const docs = Object.keys(sharedFilesData).length;
            totalDocumentsInSharedFolders += docs;
            loadedSharedFolders++;
            log('Shared folder loaded', { id, docs });
        } catch (e) {
            log('Shared folder load failed', { id, error: e?.message || e });
        }
    }

    return {
        loadedSharedFolders,
        totalDocumentsInSharedFolders
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

        const shared = await getSharedFolderDocsCount(rt, network, connectedRts);

        const time = (+new Date()) - start;
        driveConnectMetric.set(time);
        driveConnectOkMetric.set(1);
        log('Drive reconnect+load', time);
        const counts = {
            ...getDriveCounts(rt),
            ...shared
        };
        log('Drive content', counts);
    } catch (e) {
        driveConnectOkMetric.set(0);
        console.error('Drive monitor error:', e.message || e);
    } finally {
        connectedRts.forEach(cleanupDriveRt);
    }
};

const startCombinedMonitor = () => {
    if (!driveDeps) { return; }
    const cycleInterval = Math.min(pingInterval, driveInterval);
    const tick = async () => {
        let network;
        let chan;
        try {
            network = await driveDeps.Netflux.connect('', () => new WebSocket(activeUrl));
            runPingCheck(network);

            chan = await network.join(channel);
            const historyKeeper = await waitForHistoryKeeper(chan, pingInterval);
            await runRpcCheck(network, historyKeeper);

            await runDriveCheck(network);
        } catch (e) {
            const message = String(e?.message || e || '');
            if (activeUrl === primaryUrl && fallbackUrl !== primaryUrl && /EPROTO|wrong version number/i.test(message)) {
                activeUrl = fallbackUrl;
                console.log('WebSocket TLS mismatch detected, retrying with', activeUrl);
            } else {
                console.error('Combined monitor error:', message);
            }
        } finally {
            try { chan?.leave?.('Monitoring'); } catch (e) {}
            cleanupNetwork(network);
        }
        setTimeout(tick, cycleInterval);
    };
    setTimeout(tick, 1000);
};
startCombinedMonitor();
