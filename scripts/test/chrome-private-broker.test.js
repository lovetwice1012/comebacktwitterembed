'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const expected = { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'public', auth: 'auth' } };
function fakeChrome({ evaluateDelay = 0 } = {}) {
    const chrome = new EventEmitter(); chrome.exitCode = null; chrome.pid = 12345;
    const output = new PassThrough();
    const input = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.subarray(0, -1).toString()); let result;
        if (request.method === 'Browser.getVersion') result = { product: 'Chrome/156.0.1.1' };
        else if (request.method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', url: 'https://x.com/home', targetId: 'target' }] };
        else if (request.method === 'Target.attachToTarget') result = { sessionId: 'session' };
        else if (request.method === 'Runtime.evaluate') result = { result: { type: 'object', value: expected } };
        else if (request.method === 'Target.detachFromTarget') result = {};
        else if (request.method === 'Browser.close') result = {};
        else return done(new Error('unexpected command'));
        done(); const respond = () => {
            output.write(Buffer.from(JSON.stringify({ id: request.id, result }) + '\0'));
            if (request.method === 'Browser.close') { chrome.exitCode = 0; chrome.emit('exit', 0); }
        };
        if (request.method === 'Runtime.evaluate' && evaluateDelay) setTimeout(respond, evaluateDelay); else queueMicrotask(respond);
    } });
    chrome.stdio = [null, null, null, input, output]; chrome.kill = () => { chrome.exitCode = 1; chrome.emit('exit', 1); };
    return chrome;
}
async function unauthenticated(port, body) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }); let data = '';
        socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
        socket.on('connect', () => socket.write(body)); socket.on('data', chunk => { data += chunk.toString(); });
        socket.on('close', () => resolve(data)); socket.on('error', reject);
    });
}
test('broker exposes no DevTools TCP interface and requires its private capability', async () => {
    let args;
    const broker = await startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: (_exe, argv) => { args = argv; return fakeChrome(); } });
    try {
        assert(args.includes('--remote-debugging-pipe'));
        assert.equal(args.filter(arg => arg === '--gcm-mcs-endpoint=https://127.0.0.1:1').length, 1);
        assert(!args.some(arg => arg.startsWith('--remote-debugging-port')));
        assert.equal(await unauthenticated(broker.port, 'GET /json/list HTTP/1.1\r\n\r\n'), '');
        assert.equal(await unauthenticated(broker.port, JSON.stringify({ command: 'capture', token: '0'.repeat(64) }) + '\n'), '');
        assert.deepEqual(await captureFromBroker({ port: broker.port, token: broker.token }), expected);
    } finally { await broker.stop(); }
});
test('a disconnected capture client does not close the browser and can retry', async () => {
    const chrome = fakeChrome({ evaluateDelay: 80 });
    const broker = await startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: () => chrome });
    try {
        await new Promise((resolve, reject) => {
            const socket = net.connect({ host: '127.0.0.1', port: broker.port });
            socket.on('error', reject);
            socket.on('connect', () => {
                socket.write(JSON.stringify({ command: 'capture', token: broker.token }) + '\n');
                setTimeout(() => { socket.destroy(); resolve(); }, 10);
            });
        });
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(chrome.exitCode, null);
        assert.deepEqual(await captureFromBroker({ port: broker.port, token: broker.token }), expected);
    } finally { await broker.stop(); }
});
