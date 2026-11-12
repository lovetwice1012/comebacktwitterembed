'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBoundedReceiptScheduler: createScheduler, createFairLeaseScanner } = require('../../experiments/chrome-push/bounded-receipt-scheduler.cjs');
const createBoundedReceiptScheduler = options => createScheduler({ isCurrent: () => true, ...options });
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('bounded experiment isolates 1000 subscriptions and retains overflow for a future scan', async () => {
    const durable = new Set(Array.from({ length: 1004 }, (_, i) => String(i))), seen = new Set();
    let running = 0, peak = 0;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 3, maxPending: 1000, execute: async job => {
        running++; peak = Math.max(peak, running); await turn();
        assert.equal(durable.has(job.key), true); assert.equal(seen.has(job.key), false);
        seen.add(job.key); durable.delete(job.key); running--; return { state: 'processed' };
    } });
    const jobs = Array.from({ length: 1003 }, (_, i) => scheduler.enqueue({ key: String(i), token: 'token', received: true }));
    assert.equal((await scheduler.enqueue({ key: '1003', token: 'token', received: true })).state, 'deferred');
    assert.equal(durable.has('1003'), true);
    assert((await Promise.all(jobs)).every(result => result.state === 'processed'));
    assert.equal((await scheduler.enqueue({ key: '1003', token: 'token', periodic: true })).state, 'processed');
    assert.equal(peak, 3); assert.equal(seen.size, 1004); assert.equal(durable.size, 0);
    assert.equal(scheduler.status().maxObserved, 1000); scheduler.stop();
});

test('a burst of duplicate wakes schedules only one pump microtask', async () => {
    const original = global.queueMicrotask; let scheduled = 0;
    global.queueMicrotask = callback => { scheduled++; original(callback); };
    try {
        const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, execute: async () => ({ state: 'processed' }) });
        const first = scheduler.enqueue({ key: 'same', token: 'token', received: true });
        for (let i = 0; i < 10000; i++) assert.equal(scheduler.enqueue({ key: 'same', token: 'token', received: true }), first);
        assert.equal(scheduler.status().pending, 1); assert.equal(scheduled, 1);
        assert.equal((await first).state, 'processed'); scheduler.stop();
    } finally { global.queueMicrotask = original; }
});

test('repeated scans of one stalled pending job do not add Promise handlers', async () => {
    const hold = deferred(), entered = deferred();
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, execute: async job => {
        if (job.key === 'busy') { entered.resolve(); await hold.promise; }
        return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', received: true }); await entered.promise;
    const pending = scheduler.enqueue({ key: 'pending', token: 'b', periodic: true });
    const originalCatch = pending.catch.bind(pending); let handlers = 0;
    pending.catch = (...args) => { handlers++; return originalCatch(...args); };
    const scanner = createFairLeaseScanner(scheduler);
    for (let i = 0; i < 10000; i++) scanner.scan([{ key: 'pending', token: 'b' }]);
    assert.equal(scheduler.status().pending, 1); assert.equal(handlers, 0);
    hold.resolve(); await Promise.all([busy, pending]); scheduler.stop();
});

test('urgent and periodic wakes both progress, and same subscription hints coalesce', async () => {
    const hold = deferred(), entered = deferred(), runs = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 8, execute: async job => {
        runs.push(job); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const first = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const periodic = scheduler.enqueue({ key: 'batch', token: 'b', periodic: true });
    const urgent = scheduler.enqueue({ key: 'real', token: 'c', received: true });
    const combined = scheduler.enqueue({ key: 'batch', token: 'b', received: true });
    assert.equal(periodic, combined); hold.resolve(); await Promise.all([first, periodic, urgent]);
    assert.equal(runs.length, 3); assert.deepEqual(runs.map(x => x.key), ['busy', 'real', 'batch']);
    assert.equal(runs[2].received, true); assert.equal(runs[2].periodic, true); scheduler.stop();
});

test('a continuing stream of receipt wakes does not starve periodic work', async () => {
    const hold = deferred(), entered = deferred(), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 20, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const batch = scheduler.enqueue({ key: 'batch', token: 'b', periodic: true });
    const wakes = Array.from({ length: 10 }, (_, i) => scheduler.enqueue({ key: `urgent-${i}`, token: 'c', received: true }));
    hold.resolve(); await Promise.all([busy, batch, ...wakes]);
    assert(starts.indexOf('batch') <= 2, 'periodic work must progress before an urgent backlog drains');
    scheduler.stop();
});

test('superseded token and cancelled recovery do not run after lease loss', async () => {
    const hold = deferred(), entered = deferred(), runs = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 4, execute: async job => {
        runs.push(job); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const old = scheduler.enqueue({ key: 'same', token: 'old', received: true });
    const current = scheduler.enqueue({ key: 'same', token: 'new', received: true });
    assert.equal((await old).state, 'superseded');
    const recovery = new AbortController();
    const cancelled = scheduler.enqueue({ key: 'recovery', token: 'r', recovery: true, signal: recovery.signal });
    recovery.abort(); assert.equal((await cancelled).state, 'stopped');
    hold.resolve(); await Promise.all([busy, current]);
    assert.deepEqual(runs.map(x => [x.key, x.token]), [['busy', 'a'], ['same', 'new']]); scheduler.stop();
});

test('stalled work retains its slot after abort; stop cannot launch a late callback', async () => {
    const hold = deferred(), entered = deferred(); let starts = 0, observedSignal, clock = 100;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async job => {
        starts++; observedSignal = job.signal; entered.resolve(); await hold.promise; return { state: 'done' };
    }, now: () => clock });
    const active = scheduler.enqueue({ key: 'active', token: 'a', received: true }); await entered.promise;
    clock += 5000; assert.equal(scheduler.status().saturated, true); assert.equal(scheduler.status().oldestActiveMs, 5000);
    const pending = scheduler.enqueue({ key: 'pending', token: 'b', received: true }); scheduler.stop();
    assert.equal((await pending).state, 'stopped'); assert.equal(observedSignal.aborted, true);
    assert.equal(scheduler.status().active, 1); await turn(); assert.equal(starts, 1);
    assert.equal((await scheduler.enqueue({ key: 'late', token: 'c', received: true })).state, 'stopped');
    hold.resolve(); assert.equal((await active).state, 'cancelled_uncertain'); await turn(); assert.equal(scheduler.status().active, 0);
});

test('watchdog cancels but does not replace a stalled operation; timed-out recovery remains durable', async () => {
    const hold = deferred(), entered = deferred(), durable = new Set(['active', 'recovery']); let runs = 0;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, executionTimeoutMs: 20, execute: async job => {
        runs++; if (job.key === 'active') { entered.resolve(); await hold.promise; }
        if (job.signal.aborted) return { state: 'stopped' };
        durable.delete(job.key); return { state: 'processed' };
    } });
    const first = scheduler.enqueue({ key: 'active', token: 'a', received: true }); await entered.promise;
    const recoveryController = new AbortController();
    const recovery = scheduler.enqueue({ key: 'recovery', token: 'b', recovery: true, signal: recoveryController.signal });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(scheduler.status().timedOut, 1); assert.equal(scheduler.status().active, 1); assert.equal(runs, 1);
    recoveryController.abort(); assert.equal((await recovery).state, 'stopped'); assert(durable.has('recovery'));
    hold.resolve(); assert.equal((await first).state, 'cancelled_uncertain');
    assert.equal((await scheduler.enqueue({ key: 'recovery', token: 'new', periodic: true })).state, 'processed');
    assert(durable.has('active')); assert.equal(durable.has('recovery'), false); scheduler.stop();
});

test('recovery coalesces with a queued wake and both await the same work', async () => {
    const hold = deferred(), entered = deferred(), runs = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async job => {
        runs.push(job); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'done' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const a = new AbortController(), b = new AbortController();
    const first = scheduler.enqueue({ key: 'same', token: 'token', received: true, signal: a.signal });
    const recovery = scheduler.enqueue({ key: 'same', token: 'token', recovery: true, signal: b.signal });
    assert.equal(first, recovery); let completed = false; void recovery.then(() => { completed = true; });
    await turn(); assert.equal(completed, false); hold.resolve(); await Promise.all([busy, first, recovery]);
    assert.equal(runs[1].recovery, true); scheduler.stop();
});

test('coalesced recovery cancellation stops the queued work and bounds signal listeners', async () => {
    const hold = deferred(), entered = deferred(); let starts = 0;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async () => {
        starts++; entered.resolve(); await hold.promise; return { state: 'done' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const a = new AbortController(), b = new AbortController(), c = new AbortController(), d = new AbortController();
    const first = scheduler.enqueue({ key: 'same', token: 'token', received: true, signal: a.signal });
    const recovery = scheduler.enqueue({ key: 'same', token: 'token', recovery: true, signal: b.signal });
    assert.equal(scheduler.enqueue({ key: 'same', token: 'token', received: true, signal: c.signal }), first);
    assert.equal((await scheduler.enqueue({ key: 'same', token: 'token', received: true, signal: d.signal })).state, 'deferred');
    b.abort(); assert.equal((await first).state, 'stopped'); assert.equal((await recovery).state, 'stopped');
    hold.resolve(); await busy; await turn(); assert.equal(starts, 1); scheduler.stop();
});

test('recovery has its own signal slot even after two ordinary callers', async () => {
    const hold = deferred(), entered = deferred(); const starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const owner = new AbortController(), second = new AbortController(), deadline = new AbortController();
    const first = scheduler.enqueue({ key: 'same', token: 'b', received: true, signal: owner.signal });
    assert.equal(scheduler.enqueue({ key: 'same', token: 'b', received: true, signal: second.signal }), first);
    const recovery = scheduler.enqueue({ key: 'same', token: 'b', recovery: true, signal: deadline.signal });
    assert.equal(recovery, first); let done = false; void recovery.then(() => { done = true; }); await turn(); assert.equal(done, false);
    assert.deepEqual(await scheduler.enqueue({ key: 'same', token: 'b', recovery: true, signal: new AbortController().signal }),
        { state: 'recovery_failed', code: 'SCHEDULER_DUPLICATE_RECOVERY' });
    hold.resolve(); await Promise.all([busy, first, recovery]); assert.deepEqual(starts, ['busy', 'same']); scheduler.stop();
});

test('recovery waits for capacity instead of returning deferred or releasing early', async () => {
    const hold = deferred(), entered = deferred(), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const queued = scheduler.enqueue({ key: 'queued', token: 'b', received: true });
    const deadline = new AbortController();
    const recovery = scheduler.enqueue({ key: 'recover', token: 'c', recovery: true, signal: deadline.signal });
    let done = false; void recovery.then(() => { done = true; }); await turn();
    assert.equal(done, false); assert.equal(scheduler.status().recoveryWaiting, 1);
    assert.deepEqual(await scheduler.enqueue({ key: 'overflow', token: 'd', recovery: true, signal: new AbortController().signal }),
        { state: 'recovery_failed', code: 'SCHEDULER_RECOVERY_CAPACITY' });
    hold.resolve(); assert.equal((await recovery).state, 'processed'); await Promise.all([busy, queued]);
    assert.deepEqual(starts, ['busy', 'recover', 'queued']); scheduler.stop();
});

test('a waiting recovery can use a free slot when the full queue belongs to a stalled subscription', async () => {
    const hold = deferred(), entered = deferred(), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 2, maxPending: 1, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', received: true }); await entered.promise;
    const repeated = scheduler.enqueue({ key: 'busy', token: 'a', received: true });
    const recovery = scheduler.enqueue({ key: 'recovery', token: 'b', recovery: true, signal: new AbortController().signal });
    assert.equal((await recovery).state, 'processed'); assert.deepEqual(starts, ['busy', 'recovery']);
    scheduler.stop(); assert.equal((await repeated).state, 'stopped'); hold.resolve(); await busy;
});

test('a normal realtime wake uses a free slot even when the full queue is blocked on a busy key', async () => {
    const hold = deferred(), entered = deferred(), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 2, maxPending: 1, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', received: true }); await entered.promise;
    const repeated = scheduler.enqueue({ key: 'busy', token: 'a', received: true });
    const other = scheduler.enqueue({ key: 'other', token: 'b', received: true });
    assert.equal((await other).state, 'processed'); assert.deepEqual(starts, ['busy', 'other']);
    assert.equal(scheduler.status().pending, 1); scheduler.stop(); assert.equal((await repeated).state, 'stopped');
    hold.resolve(); await busy;
});

test('fair scans resume after the last accepted session when the queue is full', async () => {
    const gate = deferred(), entered = deferred(), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, execute: async job => {
        starts.push(job.key); if (starts.length === 1) { entered.resolve(); await gate.promise; } return { state: 'processed' };
    } });
    const first = scheduler.enqueue({ key: 'a', token: 'a', received: true }); await entered.promise;
    const scanner = createFairLeaseScanner(scheduler), sessions = ['c', 'a', 'b'].map(key => ({ key, token: key }));
    assert.deepEqual(scanner.scan(sessions), { accepted: 1, full: true }); assert.equal(scanner.cursor(), 'a');
    gate.resolve(); await first;
    for (let tries = 0; tries < 10 && !starts.includes('c'); tries++) {
        await turn(); scanner.scan(sessions);
    }
    for (let tries = 0; tries < 20 && (scheduler.status().active || scheduler.status().pending); tries++) await turn();
    assert.equal(scheduler.status().pending, 0);
    assert(starts.includes('b')); assert(starts.includes('c'));
    const cancelled = new AbortController(); cancelled.abort();
    const other = createFairLeaseScanner(scheduler);
    assert.deepEqual(other.scan([{ key: 'a', token: 'a', signal: cancelled.signal }, { key: 'b', token: 'b' }]), { accepted: 1, full: false });
    assert.throws(() => other.scan([null]), /SCANNER_INPUT_INVALID/);
    assert.throws(() => other.scan([{ key: 'a', token: 'a' }, { key: 'a', token: 'b' }]), /SCANNER_INPUT_INVALID/);
    scheduler.stop();
});

test('fair scans skip stale sessions instead of mistaking them for full capacity', async () => {
    const starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, isCurrent: ({ key }) => key !== 'a',
        execute: async job => { starts.push(job.key); return { state: 'processed' }; } });
    const scanner = createFairLeaseScanner(scheduler);
    assert.deepEqual(scanner.scan([{ key: 'a', token: 'a' }, { key: 'b', token: 'b' }]), { accepted: 1, full: false });
    await turn(); assert.deepEqual(starts, ['b']); scheduler.stop();
});

test('a saturated per-key signal list does not starve later subscriptions', async () => {
    const hold = deferred(), entered = deferred(), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'x', periodic: true }); await entered.promise;
    const a = new AbortController(), b = new AbortController(), c = new AbortController();
    const first = scheduler.enqueue({ key: 'a', token: 'a', received: true, signal: a.signal });
    assert.equal(scheduler.enqueue({ key: 'a', token: 'a', received: true, signal: b.signal }), first);
    const scanner = createFairLeaseScanner(scheduler);
    assert.deepEqual(scanner.scan([{ key: 'a', token: 'a', signal: c.signal }, { key: 'b', token: 'b' }]), { accepted: 1, full: false });
    hold.resolve(); await Promise.all([busy, first]);
    for (let i = 0; i < 10 && !starts.includes('b'); i++) await turn();
    assert(starts.includes('b')); scheduler.stop();
});

test('a recovery waiting for capacity terminates on its lease deadline without running', async () => {
    const hold = deferred(), entered = deferred(); const starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, execute: async job => {
        starts.push(job.key); if (job.key === 'busy') { entered.resolve(); await hold.promise; } return { state: 'processed' };
    } });
    const busy = scheduler.enqueue({ key: 'busy', token: 'a', periodic: true }); await entered.promise;
    const queued = scheduler.enqueue({ key: 'queued', token: 'b', received: true });
    const deadline = new AbortController();
    const recovery = scheduler.enqueue({ key: 'recover', token: 'c', recovery: true, signal: deadline.signal });
    deadline.abort(); assert.equal((await recovery).state, 'stopped'); assert.equal(scheduler.status().recoveryWaiting, 0);
    hold.resolve(); await Promise.all([busy, queued]); assert.deepEqual(starts, ['busy', 'queued']); scheduler.stop();
});

test('a successor cancels stale work but never overlaps it for the same subscription', async () => {
    const hold = deferred(), entered = deferred(), calls = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 2, maxPending: 2, execute: async job => {
        calls.push(job); if (job.token === 'old') { entered.resolve(); await hold.promise; }
        return { state: 'processed' };
    } });
    const old = scheduler.enqueue({ key: 'same', token: 'old', received: true }); await entered.promise;
    const next = scheduler.enqueue({ key: 'same', token: 'new', received: true });
    assert.equal(calls[0].signal.aborted, true); await turn(); assert.equal(calls.length, 1);
    hold.resolve(); assert.equal((await old).state, 'cancelled_uncertain');
    assert.equal((await next).state, 'processed'); assert.equal(calls.length, 2); scheduler.stop();
});

test('late old token cannot cancel the current lease or replace its queued wake', async () => {
    const gate = deferred(), entered = deferred(), current = new Map([['same', 'new']]), starts = [];
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, isCurrent: ({ key, token }) => current.get(key) === token,
        execute: async job => { starts.push(job); entered.resolve(); await gate.promise; return { state: 'processed' }; } });
    const active = scheduler.enqueue({ key: 'same', token: 'new', received: true }); await entered.promise;
    const queued = scheduler.enqueue({ key: 'same', token: 'new', periodic: true });
    assert.equal((await scheduler.enqueue({ key: 'same', token: 'old', received: true })).state, 'stale');
    scheduler.cancel('same', 'old'); assert.equal(starts[0].signal.aborted, false);
    gate.resolve(); await Promise.all([active, queued]);
    assert.deepEqual(starts.map(item => item.token), ['new', 'new']); scheduler.stop();
});

test('cancelling a session removes only its own queued lease and aborts its active work', async () => {
    const hold = deferred(), entered = deferred(); let activeSignal;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async job => {
        activeSignal = job.signal; entered.resolve(); await hold.promise; return { state: 'processed' };
    } });
    const active = scheduler.enqueue({ key: 'same', token: 'a', received: true }); await entered.promise;
    const pending = scheduler.enqueue({ key: 'same', token: 'a', periodic: true });
    scheduler.cancel('same', 'a'); assert(activeSignal.aborted); assert.equal((await pending).state, 'stopped');
    assert.equal(scheduler.status().pending, 0); assert.equal(scheduler.status().active, 1);
    hold.resolve(); assert.equal((await active).state, 'cancelled_uncertain'); scheduler.stop();
});

test('authority changes or throws after admission stop execution without opening work', async () => {
    let current = true, starts = 0;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 1, isCurrent: () => current,
        execute: async () => { starts++; return { state: 'processed' }; } });
    const stale = scheduler.enqueue({ key: 'same', token: 'old', received: true }); current = false;
    assert.equal((await stale).state, 'stale'); assert.equal(starts, 0);
    assert.equal((await scheduler.enqueue({ key: 'same', token: 'old', received: true })).state, 'stale'); scheduler.stop();
    assert.throws(() => createScheduler({ concurrency: 1, maxPending: 1, execute() {} }), /SCHEDULER_CONFIG_INVALID/);
});

test('an executor failure leaves durable inbox untouched and a later scan can retry', async () => {
    const durable = new Set(['x']); let attempt = 0;
    const scheduler = createBoundedReceiptScheduler({ concurrency: 1, maxPending: 2, execute: async job => {
        if (++attempt === 1) throw new Error('synthetic database failure');
        assert(durable.has(job.key)); durable.delete(job.key); return { state: 'processed' };
    } });
    assert.equal((await scheduler.enqueue({ key: 'x', token: 'a', received: true })).state, 'failed');
    assert(durable.has('x'));
    assert.equal((await scheduler.enqueue({ key: 'x', token: 'a', periodic: true })).state, 'processed');
    assert.equal(durable.size, 0); scheduler.stop();
});
