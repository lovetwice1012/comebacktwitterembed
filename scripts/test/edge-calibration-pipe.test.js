'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createECDH } = require('node:crypto');
const { createChromePipe } = require('../../src/automation/chrome-cdp-pipe');
const origin = 'http://127.0.0.1:12345';
function fixture() {
    const chrome = new EventEmitter(), output = new PassThrough(), methods = [];
    chrome.exitCode = null;
    const input = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.subarray(0, -1).toString()); methods.push(request.method); let result;
        if (request.method === 'Browser.grantPermissions') { assert.deepEqual(request.params, { origin, permissions: ['notifications'] }); result = {}; }
        else if (request.method === 'Target.createTarget') result = { targetId: 'calibration-target' };
        else if (request.method === 'Target.attachToTarget') result = { sessionId: 'session' };
        else if (request.method === 'Page.enable' || request.method === 'Page.navigate' || request.method === 'Target.detachFromTarget') result = {};
        else if (request.method === 'Runtime.evaluate') result = { result: { value: request.params.expression === 'location.origin' ? origin : true } };
        else return done(new Error('unexpected command'));
        done(); queueMicrotask(() => output.write(Buffer.from(JSON.stringify({ id: request.id, result }) + '\0')));
    } });
    chrome.stdio = [null, null, null, input, output]; return { chrome, methods };
}
test('calibration opens only a loopback page and returns no subscription material', async () => {
    const { chrome, methods } = fixture(), key = createECDH('prime256v1'); key.generateKeys();
    const pipe = createChromePipe(chrome, { origin, browserMode: 'edge', calibration: true });
    assert.equal(await pipe.prepareCalibration(key.getPublicKey().toString('base64url')), true);
    assert.deepEqual(methods, ['Browser.grantPermissions', 'Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Page.navigate', 'Runtime.evaluate', 'Runtime.evaluate', 'Target.detachFromTarget']);
});
test('calibration is unavailable to normal or non-loopback browser flows', async () => {
    const { chrome, methods } = fixture();
    const normal = createChromePipe(chrome); assert.equal(normal.prepareCalibration, undefined);
    assert.throws(() => createChromePipe(chrome, { calibration: true, browserMode: 'edge' }), { code: 'X_CHROME_PIPE_INVALID' });
    assert.throws(() => createChromePipe(chrome, { calibration: true, browserMode: 'chrome', origin }), { code: 'X_CHROME_PIPE_INVALID' });
    const pipe = createChromePipe(chrome, { calibration: true, browserMode: 'edge', origin });
    await assert.rejects(pipe.prepareCalibration(Buffer.alloc(65).toString('base64url')), { code: 'X_CHROME_PIPE_INVALID' }); assert.equal(methods.length, 0);
});
