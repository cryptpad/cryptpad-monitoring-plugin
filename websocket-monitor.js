const WebSocket = require('ws').WebSocket;
const Http = require('node:http');
const Express = require('express');
const app = Express();

// Load Prometheus
let Prometheus;
try { Prometheus = require('prom-client'); } catch (e) {}

// Load config
let config = {};
try {
    config = require('./ws-config');
} catch (e) {}

const url = config?.websocketURL || 'ws://localhost:3000/cryptpad_websocket';
const httpPort = config?.httpPort || 4000;
const httpAddress = config?.httpAddress || '::';
const pingInterval = config?.pingInterval || 10000;

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
let historyKeeper;
const channel = '00000000000000000000000000000000';

const sendPing = ws => {
    responses[++seq] = {
        data: +new Date(),
        cb: (time) => {
            let ping = +new Date() - time;
            pingMetric.set(ping);
            log('Last PING', ping);
            if (ws.readyState !== 1) { return; }

            // Check again after configured interval
            if (ping > pingInterval) { return void sendPing(ws); }
            setTimeout(() => {
                sendPing(ws);
            }, (pingInterval - ping));
        }
    };
    ws.send(JSON.stringify([seq, 'PING']));
};

const sendRPC = ws => {
    responsesRpc[++seqRpc] = {
        data: +new Date(),
        cb: (time) => {
            let ping = +new Date() - time;
            rpcMetric.set(ping);
            log('Last RPC response time', ping);
            if (ws.readyState !== 1) { return; }

            // Check again after configured interval
            if (ping > pingInterval) { return void sendRPC(ws); }
            setTimeout(() => {
                sendRPC(ws);
            }, (pingInterval - ping));
        }
    };
    const msg = JSON.stringify([seqRpc, ['GET_FILE_SIZE',channel]]);
    ws.send(JSON.stringify([++seq, 'MSG', historyKeeper, msg]));
};
const handleRPC = (msg, ws) => {
    const data = msg[4];
    let parsed;
    try {
        parsed = JSON.parse(data);
    } catch (e) { return; }

    const txid = parsed[0];
    if (!responsesRpc[txid]) {
        return console.log('Invalid RPC msg', msg);
    }

    let r = responsesRpc[txid];
    delete responsesRpc[txid];
    if (!r.cb || !r.data) { return; }
    r.cb(r.data);
};

const getHK = ws => {
    ws.send(JSON.stringify([seq, 'JOIN', channel]));
};
const handleJoin = (msg, ws) => {
    if (msg?.[1]?.length !== 16) { return; }
    historyKeeper = msg[1];
    setTimeout(() => {
        sendRPC(ws);
        ws.send(JSON.stringify([++seq, 'LEAVE', channel, 'Monitoring']));
    });
};


const startWs = () => {
    let ws = new WebSocket(url);
    ws.onclose = evt => {
        console.log('WebSocket disconnected, reason:', evt.code);
        setTimeout(startWs, 5000);
    };
    ws.onopen = evt => {
        console.log(`WebSocket connected to ${url}`);
        setTimeout(() => {
            sendPing(ws);
            getHK(ws);
        }, 1000);
    };
    ws.onmessage = evt => {
        let msg = void 0;
        try { msg = JSON.parse(evt.data); }
        catch (e) {
            console.log(e.stack);return;
        }

        const txid = msg[0];

        // Handle JOIN
        if (msg[0] === 0 && msg[2] === 'JOIN') {
            return handleJoin(msg, ws);
        }
        if (msg[0] === 0 && msg[1] === historyKeeper) {
            return handleRPC(msg, ws);
        }

        if (!responses[txid]) { return; }

        let r = responses[txid];
        delete responses[txid];
        if (!r.cb || !r.data) { return; }
        r.cb(r.data);
    };
    ws.onerror = evt => {
        console.log('ERROR', evt.message);
    };
};
startWs();
