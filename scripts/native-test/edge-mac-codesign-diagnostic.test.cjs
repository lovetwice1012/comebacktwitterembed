'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { classifyCodesign, instrumentCodesign, metadataChanged } = require('./edge-mac-codesign-diagnostic.cjs');

test('hosted Edge signature diagnostics classify failures without exposing tool output', () => {
    const timeout = 120000;
    assert.equal(classifyCodesign(null, '', 1, timeout), 'valid');
    assert.equal(classifyCodesign({ killed: true, signal: 'SIGTERM' }, 'private', 120000, timeout), 'timeout');
    assert.equal(classifyCodesign({ killed: true, signal: 'SIGTERM' }, 'private', 10, timeout), 'signal');
    assert.equal(classifyCodesign({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', 10, timeout), 'output_limit');
    assert.equal(classifyCodesign({ code: 'ENOENT' }, 'private', 10, timeout), 'unavailable');
    assert.equal(classifyCodesign({ code: 1 }, 'resource fork private', 10, timeout), 'resource_metadata');
    assert.equal(classifyCodesign({ code: 1 }, 'signature invalid private', 10, timeout), 'signature_rejected');
    assert.equal(classifyCodesign({ code: 1 }, 'private', 10, timeout), 'nonzero_exit');
    assert.equal(metadataChanged(null, 'fixture'), 'unknown');
    assert.equal(metadataChanged('first', 'first'), 'false'); assert.equal(metadataChanged('first', 'second'), 'true');
});

test('instrumentation forwards the real invocation and preserves its result', async () => {
    const expectedError = Object.assign(new Error('private-detail'), { code: 1 }), records = [];
    const calls = [], output = [];
    let now = 1000;
    const instrumented = instrumentCodesign((...args) => { calls.push(args.slice(0, 3));
        queueMicrotask(() => { now += 70; args[3](expectedError, 'private-stdout', 'signature invalid private'); }); return 'child';
    }, record => records.push(record), () => now);
    const args = ['--verify', '--deep', '--strict', '-R', 'expected requirement', '/Applications/Microsoft Edge.app'];
    const options = { timeout: 120000, maxBuffer: 16384, windowsHide: true };
    await new Promise(resolve => {
        const child = instrumented.run('/usr/bin/codesign', args, options, (error, stdout, stderr) => {
            output.push(error, stdout, stderr); resolve();
        });
        assert.equal(child, 'child');
    });
    assert.equal(instrumented.attempts(), 1); assert.equal(calls[0][0], '/usr/bin/codesign');
    assert.equal(calls[0][1], args); assert.equal(calls[0][2], options);
    assert.deepEqual(output, [expectedError, 'private-stdout', 'signature invalid private']);
    assert.deepEqual(records, [{ attempt: 1, elapsedMs: 70, classification: 'signature_rejected' }]);
    assert(!JSON.stringify(records).includes('private'));
});

test('promisified verifier preserves success and rejection even when diagnostics throw', async () => {
    let failure;
    const run = instrumentCodesign((_executable, _args, _options, callback) => queueMicrotask(() => callback(failure, 'ok', '')),
        () => { throw new Error('diagnostic failure'); }).run;
    const verify = promisify(run), options = { timeout: 120000 };
    assert.equal(await verify('/usr/bin/codesign', ['--verify'], options), 'ok');
    failure = Object.assign(new Error('private'), { code: 1 });
    await assert.rejects(verify('/usr/bin/codesign', ['--verify'], options), error => error === failure);
});
