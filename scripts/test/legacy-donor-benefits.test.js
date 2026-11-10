'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLegacyBenefit, inspectLegacyBenefit, isLegacyDonor, snapshotLegacyBenefits, activateLegacyCutover } = require('../../src/automation/legacy-donor-benefits');

const legacy = { slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30 };
const free = { planId: 'free', slotLimit: 3, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 180 };

test('legacy benefits improve the current plan without creating a separate subscription', () => {
    assert.deepEqual(applyLegacyBenefit(free, legacy), { planId: 'free', slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30, legacyDonor: true });
    assert.equal(free.slotLimit, 3);
});
test('each paid benefit survives if better than the frozen legacy floor', () => {
    const paid = { planId: 'basic', slotLimit: 10, minuteLimit: 20, dayLimit: 72, priority: 4, intervalMinutes: 10 };
    assert.deepEqual(applyLegacyBenefit(paid, legacy), { ...paid, legacyDonor: true });
    assert.deepEqual(applyLegacyBenefit(paid, null), paid);
});
test('missing paid interval retains the protected legacy interval', () => {
    assert.equal(applyLegacyBenefit({ ...free, intervalMinutes: null }, legacy).intervalMinutes, 30);
});
test('malformed stored benefits do not silently grant or lower entitlement', () => {
    for (const changes of [{ slotLimit: 0 }, { priority: -1 }, { dayLimit: NaN }, { intervalMinutes: 4 }])
        assert.throws(() => applyLegacyBenefit(free, { ...legacy, ...changes }), { code: 'LEGACY_DONOR_BENEFIT_INVALID' });
});

test('snapshot checks every donor before writing and records the frozen policy', async () => {
    const calls = [];
    const query = async (sql, params) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT id FROM automation_legacy_donor_cutover')) return [];
        if (sql.startsWith('SELECT slot_limit')) return [{ slot_limit: 5, minute_limit: 7, day_limit: 36, priority: 1, confirmation_interval_minutes: 30 }];
        if (sql.startsWith('SELECT u.user_id')) return [{ user_id: '1', is_donor: 1 }, { user_id: '2', is_donor: 1 }];
        return { affectedRows: 1 };
    };
    const result = await snapshotLegacyBenefits(query, { ownerIds: ['2', '1'], actor: { userId: '9', isAdmin: true }, now: 123 });
    assert.equal(result.count, 2);
    assert.equal(calls.filter(call => call.sql.startsWith('INSERT INTO automation_legacy_donor_benefits')).length, 2);
    assert.equal(calls.filter(call => call.sql.startsWith('INSERT INTO automation_audit')).length, 2);
    assert.deepEqual(calls.find(call => call.sql.startsWith('INSERT INTO automation_legacy_donor_benefits')).params, ['1', 5, 7, 36, 1, 30, 123, '9']);
});

test('snapshot rejects unverified users and non-admin callers before inserting', async () => {
    const calls = [];
    const query = async sql => {
        calls.push(sql);
        if (sql.startsWith('SELECT id FROM automation_legacy_donor_cutover')) return [];
        if (sql.startsWith('SELECT slot_limit')) return [{ slot_limit: 5, minute_limit: 7, day_limit: 36, priority: 1, confirmation_interval_minutes: 30 }];
        return [{ user_id: '1', is_donor: 1 }, { user_id: '2', is_donor: 0 }];
    };
    await assert.rejects(snapshotLegacyBenefits(query, { ownerIds: ['1', '2'], actor: { userId: '9', isAdmin: true }, now: 1 }), { code: 'LEGACY_DONOR_COHORT_MISMATCH' });
    assert.equal(calls.some(sql => sql.startsWith('INSERT')), false);
    await assert.rejects(snapshotLegacyBenefits(query, { ownerIds: ['1'], actor: { userId: '9' }, now: 1 }), { code: 'AUTOMATION_FORBIDDEN' });
});

test('cutover uses the frozen cohort while the old flag remains available before cutover', async () => {
    const old = async sql => sql.includes('FROM (SELECT 1') ? [{}] : [{ is_donor: 1 }];
    assert.equal(await isLegacyDonor(old, '1'), true);
    const current = async () => [{ cutover_id: 1, owner_user_id: '1', slot_limit: '5', minute_limit: '7', day_limit: '36', priority: '1', confirmation_interval_minutes: '30' }];
    assert.deepEqual(await inspectLegacyBenefit(current, '1'), { cutover: true, benefit: legacy });
    const notIncluded = async () => [{ cutover_id: 1, owner_user_id: null }];
    assert.equal(await isLegacyDonor(notIncluded, '1'), false);
});

test('cutover refuses a changed or incomplete cohort before activation', async () => {
    for (const scenario of ['changed', 'missing']) {
        const writes = [];
        const query = async sql => {
            if (sql.startsWith('SELECT user_id')) return [{ user_id: '1' }, { user_id: '2' }];
            if (sql.startsWith('SELECT owner_user_id')) return [{ owner_user_id: '1' }];
            writes.push(sql); return { affectedRows: 1 };
        };
        const ownerIds = scenario === 'changed' ? ['1'] : ['1', '2'];
        await assert.rejects(activateLegacyCutover(query, { ownerIds, actor: { userId: '9', isAdmin: true }, now: 1 }),
            { code: scenario === 'changed' ? 'LEGACY_DONOR_COHORT_MISMATCH' : 'LEGACY_DONOR_SNAPSHOT_INCOMPLETE' });
        assert.deepEqual(writes, []);
    }
});
