'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runResearchSession } = require('../native-test/edge-mac-session-research.cjs');
function driver() {
    let active = null, lose, releases = 0;
    return { async acquire() {
        if (active) throw Object.assign(new Error('busy'), { code: 'RESEARCH_BUSY' });
        const identity = {}; active = identity; let resolve; const lost = new Promise(r => { resolve = r; });
        lose = () => { if (active === identity) active = null; resolve(); };
        return { lost, async release() { if (active === identity) active = null; releases++; } };
    }, lose: () => lose(), get releases() { return releases; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('session acquires the lock before reading the index and releases on normal completion', async () => {
    const d = driver(), events = [];
    const result = await runResearchSession({ acquire: async () => { events.push('lock'); return d.acquire(); },
        readIndex: async () => { events.push('index'); return 'synthetic'; }, work: async ({ index }) => { events.push('work'); return index; } });
    assert.equal(result, 'synthetic'); assert.deepEqual(events, ['lock', 'index', 'work']); assert.equal(d.releases, 1);
});
test('a concurrent session is refused while the first owns the lock', async () => {
    const d = driver(), started = deferred(), finish = deferred();
    const first = runResearchSession({ acquire: d.acquire, readIndex: async () => 'old', work: async () => { started.resolve(); await finish.promise; } });
    await started.promise;
    await assert.rejects(runResearchSession({ acquire: d.acquire, readIndex: async () => { throw new Error('must not run'); }, work: async () => {} }), { code: 'RESEARCH_BUSY' });
    finish.resolve(); await first; assert.equal(d.releases, 1);
});
test('helper loss aborts cooperative work and returns a fixed failure', async () => {
    const d = driver(), started = deferred(); let aborted = false;
    const first = runResearchSession({ acquire: d.acquire, readIndex: async () => 'old', work: async ({ signal }) => {
        started.resolve(); await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    } });
    await started.promise; d.lose(); await assert.rejects(first, { code: 'RESEARCH_LOCK_LOST' }); assert.equal(aborted, true); assert.equal(d.releases, 1);
});
test('helper loss during index lookup prevents subsequent work', async () => {
    const d = driver(), started = deferred(); let workCalled = false;
    const first = runResearchSession({ acquire: d.acquire, readIndex: async ({ signal }) => {
        started.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return 'old';
    }, work: async () => { workCalled = true; } });
    await started.promise; d.lose(); await assert.rejects(first, { code: 'RESEARCH_LOCK_LOST' }); assert.equal(workCalled, false);
});
test('work and release failures remain failures', async () => {
    const d = driver();
    await assert.rejects(runResearchSession({ acquire: d.acquire, readIndex: async () => 'old', work: async () => { throw new Error('secret'); } }),
        { code: 'RESEARCH_WORK_FAILED' });
    assert.equal(d.releases, 1);
    await assert.rejects(runResearchSession({ acquire: async () => ({ lost: new Promise(() => {}), release: async () => { throw new Error('release failed'); } }),
        readIndex: async () => 'old', work: async () => true }), { code: 'RESEARCH_RELEASE_FAILED' });
});
test('an invalid loss notifier still releases an acquired lease, with a bounded failure', async () => {
    let released = false;
    await assert.rejects(runResearchSession({ acquire: async () => ({ lost: null, release: async () => { released = true; } }),
        readIndex: async () => 'old', work: async () => {} }), { code: 'RESEARCH_INVALID' });
    assert.equal(released, true);
    await assert.rejects(runResearchSession({ acquire: async () => ({ lost: null, release: () => new Promise(() => {}) }),
        readIndex: async () => 'old', work: async () => {}, settleTimeoutMs: 5 }), { code: 'RESEARCH_RELEASE_PENDING' });
});
test('throwing notifier accessors still release without leaking exception text', async () => {
    for (const value of [Object.defineProperty({}, 'lost', { get() { throw new Error('sensitive'); } }),
        { lost: Object.defineProperty({}, 'then', { get() { throw new Error('sensitive'); } }) }]) {
        let released = false; value.release = async () => { released = true; };
        await assert.rejects(runResearchSession({ acquire: async () => value, readIndex: async () => 'old', work: async () => {} }),
            { code: 'RESEARCH_INVALID', message: 'RESEARCH_INVALID' });
        assert.equal(released, true);
    }
});
test('uncooperative work is reported pending rather than falsely reported stopped', async () => {
    const d = driver(), started = deferred(), finish = deferred();
    const first = runResearchSession({ acquire: d.acquire, readIndex: async () => 'old', settleTimeoutMs: 5,
        work: async () => { started.resolve(); await finish.promise; } });
    await started.promise; d.lose(); await assert.rejects(first, { code: 'RESEARCH_CLEANUP_PENDING' }); finish.resolve();
});
test('research boundary: losing a helper does not fence already running work', async () => {
    const d = driver(), started = deferred(), finish = deferred(), trace = [];
    const first = runResearchSession({ acquire: d.acquire, readIndex: async () => 'old', settleTimeoutMs: 5,
        work: async () => { started.resolve(); await finish.promise; trace.push('old-work-after-loss'); } });
    await started.promise; d.lose();
    const second = runResearchSession({ acquire: d.acquire, readIndex: async () => { trace.push('new-index'); return 'new'; },
        work: async () => { await finish.promise; } });
    await assert.rejects(first, { code: 'RESEARCH_CLEANUP_PENDING' }); finish.resolve(); await second;
    assert.deepEqual(trace, ['new-index', 'old-work-after-loss']);
});
