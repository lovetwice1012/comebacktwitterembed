'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutomationError } = require('../../src/automation/service');
const { evaluateXRollout, requireXEnrollment } = require('../../src/automation/x-rollout-policy');

// Query fixtures only. No database, payment, browser, X or deployment is used.
const actor = { userId: '123456789012345678' };
const noQuery = async () => assert.fail('This rollout state must not read or mutate the database.');
const donorQuery = async () => [{ is_donor: 1 }];
const nonDonorQuery = async () => [{ is_donor: 0 }];
function rolloutEnvironment(t, initial) {
    const previous = process.env.X_NOTIFICATION_ROLLOUT;
    const setMode = value => {
        if (value === undefined) delete process.env.X_NOTIFICATION_ROLLOUT;
        else process.env.X_NOTIFICATION_ROLLOUT = value;
    };
    t.after(() => setMode(previous));
    setMode(initial);
    return setMode;
}

test('missing and invalid rollout configuration stay disabled regardless of donor or staff status', async t => {
    const setMode = rolloutEnvironment(t, undefined);
    for (const person of [actor, { ...actor, isAdmin: true, isDonor: true, planId: 'paid', totalSupporterSlots: 100 }]) {
        const decision = await evaluateXRollout(noQuery, person);
        assert.equal(decision.mode, 'disabled');
        assert.equal(decision.eligible, false);
        assert.equal(decision.reasonCode, 'X_ROLLOUT_DISABLED');
        assert.ok(decision.reason);
    }
    for (const mode of ['', 'SUPPORTERS', 'PUBLIC', ' public ', '1', 'enabled', '__proto__']) {
        setMode(mode);
        assert.equal((await evaluateXRollout(noQuery, actor)).mode, 'disabled');
    }
});

test('public rollout accepts an authenticated owner without donor, plan or credit queries', async t => {
    rolloutEnvironment(t, 'public');
    assert.deepEqual(await evaluateXRollout(noQuery, actor), { mode: 'public', eligible: true, reasonCode: null, reason: null });
    assert.deepEqual(await requireXEnrollment(noQuery, actor), { mode: 'public', eligible: true, reasonCode: null, reason: null });
});

test('supporter beta reads exactly the reviewed donor flag for the authenticated owner', async t => {
    rolloutEnvironment(t, 'supporters');
    const calls = [];
    const query = async (sql, params) => { calls.push({ sql, params }); return [{ is_donor: 1 }]; };
    assert.deepEqual(await evaluateXRollout(query, actor), { mode: 'supporters', eligible: true, reasonCode: null, reason: null });
    assert.deepEqual(calls, [{ sql: 'SELECT is_donor FROM users WHERE user_id=?', params: [actor.userId] }]);
    assert.equal((await evaluateXRollout(async () => [{ is_donor: '1' }], actor)).eligible, true);
});

test('missing and malformed donor records do not grant beta access', async () => {
    const records = [[], null, undefined, {}, { is_donor: 1 }, [null], [{}], [{ is_donor: 1 }, { is_donor: 1 }]];
    for (const is_donor of [undefined, null, 0, '0', 2, -1, true, false, 'true', '01', '1.0', ' 1 ', [], [1], {}, { valueOf: () => 1 }]) records.push([{ is_donor }]);
    for (const record of records) {
        const decision = await evaluateXRollout(async () => record, actor, { mode: 'supporters' });
        assert.equal(decision.eligible, false);
        assert.equal(decision.reasonCode, 'X_ROLLOUT_SUPPORTERS_ONLY');
        assert.ok(decision.reason);
    }
});

test('staff, paid contracts, legacy credits and new donation credits never bypass beta membership', async () => {
    const attemptedBypasses = [
        { isAdmin: true }, { isDonor: true }, { is_donor: 1 }, { planId: 'paid', tier: 'paid' },
        { isSupporter: true, totalSupporterSlots: 100, legacySlots: 100 },
        { newPaidSlots: 100, verified: true, donation: { active: true } },
        { body: { userId: '999999999999999999', is_donor: 1, mode: 'public' } },
    ];
    for (const extras of attemptedBypasses) {
        const calls = [];
        const decision = await evaluateXRollout(async (sql, params) => { calls.push(params); return [{ is_donor: 0 }]; }, { ...actor, ...extras }, { mode: 'supporters' });
        assert.equal(decision.eligible, false);
        assert.deepEqual(calls, [[actor.userId]]);
    }
});

test('trusted mode injection is explicit and malformed options cannot open rollout', async t => {
    const setMode = rolloutEnvironment(t, 'disabled');
    assert.equal((await evaluateXRollout(noQuery, actor, { mode: 'public' })).eligible, true);
    assert.equal((await evaluateXRollout(donorQuery, actor, { mode: 'supporters' })).eligible, true);
    for (const options of [null, true, 'public', ['public'], { body: { mode: 'public' } }, { rollout: 'public' }, Object.create({ mode: 'public' })]) {
        assert.equal((await evaluateXRollout(noQuery, actor, options)).mode, 'disabled');
    }
    setMode('public');
    for (const mode of [undefined, null, true, 1, {}, ['public'], 'PUBLIC', ' public ']) {
        assert.equal((await evaluateXRollout(noQuery, actor, { mode })).mode, 'disabled');
    }
    assert.equal((await evaluateXRollout(noQuery, actor, { mode: 'disabled' })).mode, 'disabled');
});

test('actor and nested request fields cannot replace the server environment policy', async t => {
    rolloutEnvironment(t, 'supporters');
    const requestActor = { ...actor, mode: 'public', rollout: 'public', body: { mode: 'public', userId: '999999999999999999' } };
    assert.equal((await evaluateXRollout(nonDonorQuery, requestActor)).eligible, false);
    assert.equal((await evaluateXRollout(nonDonorQuery, actor, { body: { mode: 'public' } })).eligible, false);
});

test('enrollment guard returns safe rollout errors without exposing donor records or configuration values', async () => {
    const secret = 'PRIVATE-DONOR-SENTINEL';
    for (const [mode, code, status] of [['disabled', 'X_ROLLOUT_DISABLED', 503], ['supporters', 'X_ROLLOUT_SUPPORTERS_ONLY', 403]]) {
        await assert.rejects(requireXEnrollment(async () => [{ is_donor: 0, detail: secret }], actor, { mode }), error => {
            assert.ok(error instanceof AutomationError);
            assert.equal(error.code, code);
            assert.equal(error.status, status);
            assert.ok(!JSON.stringify(error).includes(secret));
            assert.ok(!error.message.includes(actor.userId));
            return true;
        });
    }
    assert.equal((await requireXEnrollment(donorQuery, actor, { mode: 'supporters' })).eligible, true);
});

test('all modes authenticate before granting access or querying donor information', async () => {
    for (const mode of ['disabled', 'supporters', 'public']) for (const person of [null, {}, { userId: '' }, { userId: 'x' }, { userId: '1'.repeat(33) }]) {
        await assert.rejects(evaluateXRollout(noQuery, person, { mode }), { code: 'AUTH_REQUIRED', status: 401 });
        await assert.rejects(requireXEnrollment(noQuery, person, { mode }), { code: 'AUTH_REQUIRED', status: 401 });
    }
});

test('database failures propagate without converting a failed donor check into eligible access', async () => {
    const failure = Object.assign(new Error('SYNTHETIC-DB-FAILURE'), { code: 'FIXTURE_DB_FAILURE' });
    const query = async () => { throw failure; };
    await assert.rejects(evaluateXRollout(query, actor, { mode: 'supporters' }), error => error === failure);
    await assert.rejects(requireXEnrollment(query, actor, { mode: 'supporters' }), error => error === failure);
});

test('donor authorization does not promise capacity or modify donor and donation state', async () => {
    const row = { is_donor: 1, additional_auto_extract_slots: 0, availableSlots: 0, receiverEnabled: false };
    const before = structuredClone(row), queries = [];
    const result = await requireXEnrollment(async (sql, params) => { queries.push({ sql, params }); return [row]; }, actor, { mode: 'supporters' });
    assert.deepEqual(result, { mode: 'supporters', eligible: true, reasonCode: null, reason: null });
    assert.deepEqual(row, before);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /^SELECT is_donor FROM users WHERE user_id=\?$/);
    assert.deepEqual(Object.keys(result).sort(), ['eligible', 'mode', 'reason', 'reasonCode']);
});
