'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendSyntheticBaseline } = require('../native-test/chrome-mac-suppression-baseline.cjs');

test('baseline retries a 410 using the same send and stops on first acceptance', async () => {
    let calls = 0, now = 0; const events = [], marker = 'synthetic-marker';
    const result = await sendSyntheticBaseline({ send: async () => { calls++; assert.equal(marker, 'synthetic-marker');
        if (calls < 3) throw { statusCode: 410, body: 'unregistered private' }; },
    sleep: async ms => { now += ms; }, elapsedMs: () => now, report: event => events.push(event) });
    assert.deepEqual(result, { initialFailed: true }); assert.equal(calls, 3);
    assert.deepEqual(events.map(event => event.result), ['410_UNREGISTERED', '410_UNREGISTERED', 'accepted']);
    assert(!JSON.stringify(events).includes('private'));
});

test('baseline sends once when accepted and never retries non-410 errors', async () => {
    let calls = 0; const noSleep = async () => assert.fail('unexpected retry');
    assert.deepEqual(await sendSyntheticBaseline({ send: async () => { calls++; }, sleep: noSleep, elapsedMs: () => 0, report: () => {} }),
        { initialFailed: false }); assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(sendSyntheticBaseline({ send: async () => { calls++; throw { statusCode: 503, body: 'private' }; },
        sleep: noSleep, elapsedMs: () => 0, report: () => {} }), { message: 'FIXTURE_BASELINE_SEND_FAILED' });
    assert.equal(calls, 1);
});

test('baseline repeated 410 stops at the bounded retry limit', async () => {
    let calls = 0;
    await assert.rejects(sendSyntheticBaseline({ send: async () => { calls++; throw { statusCode: 410 }; },
        sleep: async () => {}, elapsedMs: () => 0, report: () => {} }), { message: 'FIXTURE_BASELINE_RETRY_FAILED' });
    assert.equal(calls, 6);
});
