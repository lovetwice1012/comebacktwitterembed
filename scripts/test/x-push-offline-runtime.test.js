'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfflineProcessingScheduler } = require('../../src/automation/x-push-offline-runtime');
const pause = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
    const controller = new AbortController();
    const rows = Array.from({ length: 1031 }, (_, i) => ({ id: String(i + 1).padStart(6, '0'), owner_user_id: String(i + 1) }));
    const options = { db: {}, workerId: 'test', signal: controller.signal, authorize: async () => {}, assertAllowed: () => {}, pageSize: 100, concurrency: 8,
        listCandidates: async cursor => rows.filter(row => row.id > cursor).slice(0, 100),
        leaseManager: { claim: async input => ({ ...input, expiresAtMs: Date.now() + 5000 }), renew: async lease => lease, release: async () => {} },
        drain: async () => ({ state: 'pending' }), ...overrides };
    return { scheduler: createOfflineProcessingScheduler(options), controller, rows };
}
test('independent cursor reaches 1031 candidates without exceeding bounded concurrency', async () => {
    const seen = new Set(); let current = 0, max = 0;
    const { scheduler } = harness({ drain: async lease => { current++; max = Math.max(max, current); seen.add(lease.subscriptionId); await pause(); current--; return { state: 'pending' }; } });
    for (let i = 0; i < 180 && seen.size < 1031; i++) { await scheduler.tick(); await pause(); await pause(); }
    assert.equal(seen.size, 1031); assert.ok(max <= 8); scheduler.stop();
    await Promise.allSettled(scheduler.pending());
});
test('claims check candidate owner and stop cancels delayed drain', async () => {
    let unblock, observed; const gate = new Promise(resolve => { unblock = resolve; });
    const { scheduler, controller } = harness({ pageSize: 1, concurrency: 1,
        listCandidates: async () => [{ id: 'id', owner_user_id: '42' }],
        authorize: async (query, candidate) => { observed = candidate.owner_user_id; },
        leaseManager: { claim: async (input, { authorize }) => { await authorize(() => {}); return { ...input, expiresAtMs: Date.now() + 5000 }; }, renew: async l => l, release: async () => {} },
        drain: async (lease, { recoverySignal }) => { await gate; assert.equal(recoverySignal.aborted, true); return { state: 'stopped' }; } });
    await scheduler.tick(); await pause(); assert.equal(observed, '42'); controller.abort(); scheduler.stop(); unblock();
    await Promise.allSettled(scheduler.pending()); assert.equal(scheduler.active(), 0);
});
test('failed renewal aborts a delayed callback before release', async () => {
    let unblock, aborted = false, releases = 0; const gate = new Promise(resolve => { unblock = resolve; });
    const { scheduler } = harness({ pageSize: 1, concurrency: 1, listCandidates: async () => [{ id: 'id', owner_user_id: '42' }],
        leaseManager: { claim: async input => ({ ...input, expiresAtMs: Date.now() + 60 }), renew: async () => { throw Error('lease lost'); }, release: async () => { releases++; } },
        drain: async (lease, { recoverySignal }) => { await gate; aborted = recoverySignal.aborted; return { state: 'stopped' }; } });
    await scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 45)); unblock(); await Promise.allSettled(scheduler.pending());
    assert.equal(aborted, true); assert.equal(releases, 1); scheduler.stop();
});
test('synchronous authority failure frees capacity and can be retried after scan wrap', async () => {
    let checks = 0, claims = 0;
    const { scheduler } = harness({ pageSize: 1, concurrency: 1, listCandidates: async cursor => cursor ? [] : [{ id: 'id', owner_user_id: '42' }],
        assertAllowed: () => { if (++checks === 2) throw Error('temporarily disabled'); },
        leaseManager: { claim: async input => { claims++; return { ...input, expiresAtMs: Date.now() + 5000 }; }, renew: async l => l, release: async () => {} } });
    await scheduler.tick(); await pause(); assert.equal(scheduler.active(), 0); assert.equal(claims, 0);
    await scheduler.tick(); await scheduler.tick(); await pause(); await pause(); assert.equal(claims, 1); scheduler.stop();
});
test('stop while a claim is pending never starts a drain and releases the obtained lease', async () => {
    let finish, released = 0, drains = 0; const pending = new Promise(resolve => { finish = resolve; });
    const { scheduler } = harness({ pageSize: 1, concurrency: 1, listCandidates: async () => [{ id: 'id', owner_user_id: '42' }],
        leaseManager: { claim: async input => { await pending; return { ...input, expiresAtMs: Date.now() + 5000 }; }, renew: async l => l, release: async () => { released++; } },
        drain: async () => { drains++; return { state: 'processed' }; } });
    await scheduler.tick(); scheduler.stop(); finish(); await Promise.allSettled(scheduler.pending());
    assert.equal(drains, 0); assert.equal(released, 1); assert.equal(scheduler.active(), 0);
});
test('pending batch cooldown follows due time and invalidates on plan or realtime changes', async () => {
    let time = 1000, interval = 5, realtime = false, claims = 0;
    const { scheduler } = harness({ clock: () => time, pageSize: 1, concurrency: 1,
        listCandidates: async cursor => cursor ? [] : [{ id: 'id', owner_user_id: '42' }],
        processingSnapshot: async () => ({ intervalMinutes: interval, realtime, batch: true }),
        leaseManager: { claim: async input => { claims++; return { ...input, expiresAtMs: time + 5000 }; }, renew: async l => l, release: async () => {} },
        drain: async () => ({ state: 'pending', dueAtMs: 9000 }) });
    async function scan() { await scheduler.tick(); await scheduler.tick(); await pause(); await pause(); }
    await scan(); assert.equal(claims, 1);
    await scan(); assert.equal(claims, 1);
    interval = 10; await scan(); assert.equal(claims, 2);
    realtime = true; await scan(); assert.equal(claims, 3);
    realtime = false; await scan(); assert.equal(claims, 4);
    await scan(); assert.equal(claims, 4);
    time = 9000; await scan(); assert.equal(claims, 5);
    scheduler.stop();
});
test('stalled read-only snapshot times out without duplicate queries or blocking claims', async () => {
    let snapshots = 0, claims = 0, resolveSnapshot;
    const waiting = new Promise(resolve => { resolveSnapshot = resolve; });
    const { scheduler } = harness({ pageSize: 1, concurrency: 1, snapshotTimeoutMs: 10,
        listCandidates: async cursor => cursor ? [] : [{ id: 'id', owner_user_id: '42' }],
        processingSnapshot: async () => { snapshots++; return waiting; },
        leaseManager: { claim: async input => { claims++; return { ...input, expiresAtMs: Date.now() + 5000 }; }, renew: async l => l, release: async () => {} } });
    await scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(claims, 1);
    await scheduler.tick(); await scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(claims, 2); assert.equal(snapshots, 1);
    resolveSnapshot({ intervalMinutes: 5, realtime: false, batch: true }); await pause(); scheduler.stop();
});
