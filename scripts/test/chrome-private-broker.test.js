'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { startChromeBroker } = require('../../src/automation/chrome-private-broker');
const { captureFromBroker } = require('../../src/automation/chrome-broker-client');
const { createChromePipe } = require('../../src/automation/chrome-cdp-pipe');
const { createChromePipe: createEdgePipe } = require('../../src/automation/edge-cdp-pipe');
const { startChromeBroker: startEdgeBroker } = require('../../src/automation/edge-private-broker');
const { captureFromBroker: captureFromEdgeBroker } = require('../../src/automation/edge-broker-client');
const { randomBytes } = require('node:crypto');
const expected = { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'public', auth: 'auth' } };
function fakeChrome({ evaluateDelay = 0, targetInfos, subscriptions = {}, product = 'Chrome/156.0.1.1' } = {}) {
    const chrome = new EventEmitter(); chrome.exitCode = null; chrome.pid = 12345;
    const output = new PassThrough();
    const input = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.subarray(0, -1).toString()); let result;
        if (request.method === 'Browser.getVersion') result = { product };
        else if (request.method === 'Target.getTargets') result = { targetInfos: targetInfos || [{ type: 'page', url: 'https://x.com/home', targetId: 'target' }] };
        else if (request.method === 'Target.attachToTarget') result = { sessionId: request.params.targetId };
        else if (request.method === 'Runtime.evaluate') result = { result: { type: 'object', value: subscriptions[request.sessionId] || expected } };
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
test('broker rejects invalid pipe timeouts before launching a browser', async () => {
    let spawned = false;
    for (const pipeTimeoutMs of [0, 999, 60001, NaN, '30000']) {
        await assert.rejects(startChromeBroker({ chromePath: 'synthetic', profilePath: 'synthetic', pipeTimeoutMs,
            spawnChrome: () => { spawned = true; return fakeChrome(); } }), { code: 'X_CHROME_BROKER_INVALID' });
    }
    assert.equal(spawned, false);
});
test('broker can close its dedicated browser through the private pipe', async () => {
    const chrome = fakeChrome();
    const broker = await startChromeBroker({ chromePath: 'synthetic', profilePath: 'synthetic', spawnChrome: () => chrome });
    try { await broker.closeBrowser(); assert.equal(chrome.exitCode, 0); }
    finally { await broker.stop(); }
});
test('broker exposes no DevTools TCP interface and requires its private capability', async () => {
    let args;
    const broker = await startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: (_exe, argv) => { args = argv; return fakeChrome(); } });
    try {
        assert(args.includes('--remote-debugging-pipe'));
        assert.equal(args.filter(arg => arg === '--gcm-mcs-endpoint=https://127.0.0.1:1').length, 1);
        assert.equal(args.filter(arg => arg === '--host-resolver-rules=MAP mtalk.google.com ~NOTFOUND').length, 1);
        assert(!args.some(arg => arg.startsWith('--remote-debugging-port')));
        assert.equal(await unauthenticated(broker.port, 'GET /json/list HTTP/1.1\r\n\r\n'), '');
        assert.equal(await unauthenticated(broker.port, JSON.stringify({ command: 'capture', token: '0'.repeat(64) }) + '\n'), '');
        assert.deepEqual(await captureFromBroker({ port: broker.port, token: broker.token }), expected);
    } finally { await broker.stop(); }
});
test('unavailable listener address closes the listener and stops its own browser', async t => {
    const chrome = fakeChrome(), create = net.createServer; let server;
    t.mock.method(net, 'createServer', (...args) => {
        server = create(...args); server.address = () => null; return server;
    });
    await assert.rejects(startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: () => chrome }),
        { code: 'X_CHROME_BROKER_INVALID' });
    assert.equal(chrome.exitCode, 1);
    assert.equal(server.listening, false);
});
test('multiple tabs in the same browser profile must expose identical subscriptions', async () => {
    const targets = ['first', 'second'].map(targetId => ({ type: 'page', url: 'https://x.com/home', targetId, browserContextId: 'profile' }));
    const good = await startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: () => fakeChrome({ targetInfos: targets }) });
    try { assert.deepEqual(await captureFromBroker({ port: good.port, token: good.token }), expected); } finally { await good.stop(); }
    const different = { ...expected, keys: { ...expected.keys, auth: 'different' } };
    const bad = await startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: () => fakeChrome({ targetInfos: targets, subscriptions: { second: different } }) });
    try { await assert.rejects(captureFromBroker({ port: bad.port, token: bad.token }), { code: 'X_CHROME_CAPTURE_AMBIGUOUS' }); } finally { await bad.stop(); }
    const otherContext = [targets[0], { ...targets[1], browserContextId: 'other' }];
    const cross = await startChromeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', spawnChrome: () => fakeChrome({ targetInfos: otherContext }) });
    try { await assert.rejects(captureFromBroker({ port: cross.port, token: cross.token }), { code: 'X_CHROME_CAPTURE_AMBIGUOUS' }); } finally { await cross.stop(); }
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
test('optional Edge capture includes a canonical application server key and checks all tabs agree', async () => {
    const applicationServerKey = randomBytes(65).toString('base64url'), value = { ...expected, applicationServerKey };
    const chrome = fakeChrome({ subscriptions: { target: value } });
    const pipe = createEdgePipe(chrome, { includeApplicationServerKey: true });
    assert.deepEqual(await pipe.capture(), value); chrome.kill();
    const missing = createEdgePipe(fakeChrome(), { includeApplicationServerKey: true });
    await assert.rejects(missing.capture(), { code: 'X_CHROME_CAPTURE_INVALID' });
    const targets = ['first', 'second'].map(targetId => ({ type: 'page', url: 'https://x.com/home', targetId, browserContextId: 'profile' }));
    const different = { ...value, applicationServerKey: randomBytes(65).toString('base64url') };
    const ambiguous = createEdgePipe(fakeChrome({ targetInfos: targets, subscriptions: { first: value, second: different } }), { includeApplicationServerKey: true });
    await assert.rejects(ambiguous.capture(), { code: 'X_CHROME_CAPTURE_AMBIGUOUS' });
});
test('private broker transports optional Edge key only when explicitly enabled', async () => {
    const value = { ...expected, applicationServerKey: randomBytes(65).toString('base64url') }; let launchArgs;
    const broker = await startEdgeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', browserMode: 'edge', includeApplicationServerKey: true,
        spawnChrome: (_exe, args) => { launchArgs = args; return fakeChrome({ subscriptions: { target: value }, product: 'Edg/157.0.1.1' }); } });
    try { assert.deepEqual(await captureFromEdgeBroker({ port: broker.port, token: broker.token, includeApplicationServerKey: true }), value); }
    finally { await broker.stop(); }
    assert(launchArgs.includes('--remote-debugging-pipe'));
    assert(!launchArgs.some(arg => arg.startsWith('--gcm-mcs-endpoint=') || arg.startsWith('--host-resolver-rules=')));
    const suppressed = await startEdgeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', browserMode: 'edge', includeApplicationServerKey: true,
        suppressReceive: true, spawnChrome: (_exe, args) => { launchArgs = args; return fakeChrome({ subscriptions: { target: value }, product: 'Edg/157.0.1.1' }); } });
    try { assert.deepEqual(await captureFromEdgeBroker({ port: suppressed.port, token: suppressed.token, includeApplicationServerKey: true }), value); }
    finally { await suppressed.stop(); }
    assert(launchArgs.includes('--edge-wns-push-server-url=https://127.0.0.1:1'));
    await assert.rejects(startEdgeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', suppressReceive: true, spawnChrome: () => fakeChrome() }), { code: 'X_CHROME_BROKER_INVALID' });
    await assert.rejects(startEdgeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', browserMode: 'edge', spawnChrome: () => fakeChrome() }), { code: 'X_CHROME_BROKER_INVALID' });
    for (const pipeTimeoutMs of [0, 999, 60001, '30000']) {
        let spawned = false;
        await assert.rejects(startEdgeBroker({ chromePath: 'synthetic.exe', profilePath: 'synthetic-profile', browserMode: 'edge',
            includeApplicationServerKey: true, pipeTimeoutMs, spawnChrome: () => { spawned = true; return fakeChrome(); } }), { code: 'X_CHROME_BROKER_INVALID' });
        assert.equal(spawned, false);
    }
});
test('browser version handshake accepts only the selected browser family', async () => {
    assert.equal(await createEdgePipe(fakeChrome({ product: 'Edg/157.0.4341.42' }), { browserMode: 'edge' }).ready(), '157.0.4341.42');
    assert.equal(await createChromePipe(fakeChrome()).ready(), '156.0.1.1');
    await assert.rejects(createChromePipe(fakeChrome({ product: 'Edg/157.0.4341.42' })).ready(), { code: 'X_CHROME_PIPE_INVALID' });
    await assert.rejects(createEdgePipe(fakeChrome(), { browserMode: 'edge' }).ready(), { code: 'X_CHROME_PIPE_INVALID' });
});
