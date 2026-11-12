'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { withFixtureCdp } = require('../native-test/edge-mac-suppression-cdp.cjs');
test('fixture CDP correlates replies without taking unrelated pipe replies', async () => {
    const child = new EventEmitter(), output = new PassThrough(); let observed;
    const input = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.subarray(0, -1).toString()); observed = request.id; done();
        output.write(Buffer.from(JSON.stringify({ id: 1, result: { unrelated: true } }) + '\0'));
        output.write(Buffer.from(JSON.stringify({ id: request.id, result: { synthetic: true } }) + '\0'));
    } });
    child.stdio = [null, null, null, input, output];
    const value = await withFixtureCdp(child, call => call('Target.getTargets'));
    assert.equal(observed, 1000000001); assert.equal(value.synthetic, true); assert.equal(output.listenerCount('data'), 0);
});
test('fixture CDP turns browser termination into a fixed error', async () => {
    const child = new EventEmitter(), output = new PassThrough();
    const input = new Writable({ write(_chunk, _encoding, done) { done(); queueMicrotask(() => child.emit('exit')); } });
    child.stdio = [null, null, null, input, output];
    await assert.rejects(withFixtureCdp(child, call => call('Target.getTargets')), { message: 'FIXTURE_CDP_CLOSED' });
});
test('an abandoned fixture CDP call is observed when the scope closes', async () => {
    const child = new EventEmitter(), output = new PassThrough(), input = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.stdio = [null, null, null, input, output];
    let response;
    await assert.rejects(withFixtureCdp(child, async call => { response = call('Target.getTargets'); }), { message: 'FIXTURE_CDP_PENDING' });
    await assert.rejects(response, { message: 'FIXTURE_CDP_CLOSED' });
});
test('a call made after fixture scope closure is observed and rejected', async () => {
    const child = new EventEmitter(), output = new PassThrough(), input = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.stdio = [null, null, null, input, output]; let late;
    await withFixtureCdp(child, async call => { late = call; });
    await assert.rejects(late('Target.getTargets'), { message: 'FIXTURE_CDP_INVALID' });
});
test('a late reply from an earlier scope cannot satisfy a new request', async () => {
    const child = new EventEmitter(), output = new PassThrough(); let firstId, writes = 0;
    const input = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.subarray(0, -1).toString()); done();
        if (++writes === 1) firstId = request.id;
        else {
            output.write(Buffer.from(JSON.stringify({ id: firstId, result: { value: 'stale' } }) + '\0'));
            output.write(Buffer.from(JSON.stringify({ id: request.id, result: { value: 'current' } }) + '\0'));
        }
    } });
    child.stdio = [null, null, null, input, output];
    await withFixtureCdp(child, async call => { await assert.rejects(call('First'), { message: 'FIXTURE_CDP_TIMEOUT' }); }, { timeoutMs: 5 });
    const result = await withFixtureCdp(child, call => call('Second'));
    assert.equal(result.value, 'current');
});
