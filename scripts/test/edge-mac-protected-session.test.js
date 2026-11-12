'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProtectedExperiment } = require('../native-test/edge-mac-protected-session.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function addonFixture() {
    let locked = false, active = false; const events = [];
    return { events, acquire() { events.push('acquire'); if (locked) return 'BUSY'; locked = true; return 'OK'; },
        begin() { events.push('begin'); if (!locked || active) return 'INVALID'; active = true; return 'OK'; },
        end() { events.push('end'); if (!active) return 'INVALID'; active = false; return 'OK'; },
        release() { events.push('release'); if (!locked || active) return 'INVALID'; locked = false; return 'OK'; } };
}
test('lock covers index lookup through completion of the entire session', async () => {
    const addon = addonFixture();
    const value = await runProtectedExperiment({ base: '/fixture', addon, execute: async () => { addon.events.push('index'); addon.events.push('rotation'); return 'saved'; } });
    assert.equal(value, 'saved'); assert.deepEqual(addon.events, ['acquire', 'begin', 'index', 'rotation', 'end', 'release']);
});
test('concurrent and pending work never releases or starts a second session early', async () => {
    const addon = addonFixture(), entered = deferred(), finish = deferred();
    const first = runProtectedExperiment({ base: '/fixture', addon, execute: async () => { entered.resolve(); await finish.promise; } });
    await entered.promise; let secondRan = false;
    await assert.rejects(runProtectedExperiment({ base: '/fixture', addon, execute: async () => { secondRan = true; } }), { code: 'RESEARCH_SESSION_BUSY' });
    assert.equal(secondRan, false); assert.equal(addon.events.includes('release'), false);
    finish.resolve(); await first; assert.equal(addon.events.at(-1), 'release');
});
test('session errors and unconfirmed guards retain the lock', async () => {
    const addon = addonFixture();
    await assert.rejects(runProtectedExperiment({ base: '/fixture', addon, execute: async () => { throw new Error('fixture error'); } }),
        { code: 'RESEARCH_SESSION_WORK_UNCERTAIN' });
    assert.deepEqual(addon.events, ['acquire', 'begin']);
    const invalid = addonFixture(); invalid.end = () => { invalid.events.push('end-invalid'); return 'INVALID'; };
    await assert.rejects(runProtectedExperiment({ base: '/fixture', addon: invalid, execute: async () => {} }), { code: 'RESEARCH_SESSION_GUARD_UNCERTAIN' });
    assert.equal(invalid.events.includes('release'), false);
});
test('research boundary: untracked fire-and-forget work outlives the guard', async () => {
    const addon = addonFixture(), trigger = deferred(), done = deferred(); let lateHadLock = true;
    await runProtectedExperiment({ base: '/fixture', addon, execute: async () => {
        trigger.promise.then(() => { lateHadLock = !addon.events.includes('release'); done.resolve(); });
    } });
    trigger.resolve(); await done.promise; assert.equal(lateHadLock, false);
});
