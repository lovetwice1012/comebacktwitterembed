'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChromeCheckinRunner, MAX_TIMER } = require('../../src/automation/chrome-checkin-runner');
const lease = { subscriptionId: '00000000-0000-0000-0000-000000000001', revision: 1 };
const credentials = { deviceId: '1', securityToken: '2', browserVersion: '131.0.0.0' };
function fixture(state = { checkedAtMs: null, intervalSeconds: 172800 }) {
    let clock = 1000000, pending, saved, error, sends = 0, authorized = 0;
    const store = {
        chromeCheckinState: async (_lease, { authorize }) => { await authorize(); return state; },
        assertLease: async (_lease, { authorize }) => { await authorize(); },
        recordChromeCheckin: async (_lease, result, { authorize }) => { await authorize(); saved = { checkedAtMs: clock, ...result }; return saved; },
    };
    const runner = createChromeCheckinRunner({ lease, credentials, store, authorize: async () => { authorized++; },
        onFailure: value => { error = value; }, now: () => clock,
        send: async () => { sends++; return { intervalSeconds: 50000 }; },
        setTimer: (cb, delay) => { pending = { cb, delay }; return pending; }, clearTimer: () => { pending = null; },
    });
    const fire = async () => { const current = pending; assert.ok(current); pending = null; clock += current.delay; current.cb();
        await new Promise(resolve => setImmediate(resolve)); };
    return { runner, fire, pending: () => pending, saved: () => saved, error: () => error, sends: () => sends, authorized: () => authorized };
}
test('check-ins are spread, lease fenced and persisted before scheduling the next run', async () => {
    const f = fixture(); await f.runner.start();
    assert.ok(f.pending().delay > 0 && f.pending().delay <= 60000);
    await f.fire(); assert.equal(f.sends(), 1); assert.equal(f.saved().intervalSeconds, 50000);
    assert.equal(f.pending().delay, 50000000); assert.equal(f.authorized(), 3);
    await f.runner.stop(); assert.equal(f.pending(), null); assert.equal(f.error(), undefined);
});
test('restarts use saved time and long delays are safely split', async () => {
    const f = fixture({ checkedAtMs: 1000000, intervalSeconds: 31536000 });
    await f.runner.start(); assert.equal(f.pending().delay, MAX_TIMER);
    await f.fire(); assert.equal(f.sends(), 0); assert.ok(f.pending().delay > 0);
    await f.runner.stop();
});
test('shutdown cancels a pending check-in and prevents a late result from being saved', async () => {
    let fire, complete, saved = 0, signal, clock = 0;
    const runner = createChromeCheckinRunner({ lease, credentials, now: () => clock, authorize: async () => {}, onFailure: () => assert.fail(),
        store: { chromeCheckinState: async () => ({ checkedAtMs: null, intervalSeconds: 172800 }), assertLease: async () => {},
            recordChromeCheckin: async () => { saved++; } },
        send: (_credentials, options) => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); },
        setTimer: cb => { fire = cb; return 1; }, clearTimer: () => {},
    });
    await runner.start(); clock = 60001; fire(); await new Promise(resolve => setImmediate(resolve));
    const stopping = runner.stop(); assert.equal(signal.aborted, true);
    complete({ intervalSeconds: 172800 }); await stopping; assert.equal(saved, 0);
});
test('errors reach the worker without scheduling another simultaneous check-in', async () => {
    let fire, failure, clock = 0;
    const runner = createChromeCheckinRunner({ lease, credentials, now: () => clock, authorize: async () => {}, onFailure: e => { failure = e; },
        store: { chromeCheckinState: async () => ({ checkedAtMs: null, intervalSeconds: 172800 }), assertLease: async () => {}, recordChromeCheckin: async () => assert.fail() },
        send: async () => { throw Object.assign(new Error('safe'), { code: 'X_PUSH_CHECKIN_UNAUTHORIZED' }); },
        setTimer: cb => { fire = cb; return 1; }, clearTimer: () => {},
    });
    await runner.start(); clock = 60001; fire(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(failure.code, 'X_PUSH_CHECKIN_UNAUTHORIZED'); await runner.stop();
});
