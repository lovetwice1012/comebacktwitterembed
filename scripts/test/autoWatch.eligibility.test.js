'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertRegistrationAllowed, registrationStatus } = require('../../src/providers/autoWatch/eligibility');
const { createMonitors } = require('../../src/automation/monitors');
const U = '222222222222222222';
const actor = { userId: U, isAdmin: true, isDonor: true };
const auto = { normalizeSource: (_provider, source) => ({ sourceKey: source, sourceUrl: source }), PROVIDERS: {}, ratePolicy: () => ({}) };

test('only the database donor flag grants registration, regardless of slots or caller flags', async () => {
    for (const flag of [0, '0', 2, -1, null, undefined, 'true']) {
        const query = async (sql, params) => {
            assert.match(sql, /SELECT is_donor FROM users WHERE user_id=\?/);
            assert.deepEqual(params, [U]);
            return [{ is_donor: flag, additional_auto_extract_slots: 999 }];
        };
        assert.deepEqual(await registrationStatus(query, U), { donorOnly: true, eligible: false });
        await assert.rejects(assertRegistrationAllowed(query, U), { code: 'AUTO_WATCH_DONOR_REQUIRED', status: 403 });
    }
    await assert.rejects(assertRegistrationAllowed(async () => [], U), { status: 403 });
    for (const is_donor of [1, '1']) assert.equal((await assertRegistrationAllowed(async () => [{ is_donor }], U)).eligible, true);
});

test('registration transaction can lock donor status and database failures never grant access', async () => {
    await assertRegistrationAllowed(async sql => { assert.match(sql, /FOR UPDATE$/); return [{ is_donor: 1 }]; }, U, true);
    await assert.rejects(assertRegistrationAllowed(async () => { throw new Error('database unavailable'); }, U), /database unavailable/);
});

test('authenticated non-donor API actors cannot create even paused monitors or spoof another donor', async () => {
    const writes = [];
    const query = async sql => { if (!sql.startsWith('SELECT')) writes.push(sql); return [{ is_donor: 0 }]; };
    const monitors = createMonitors({ queryDatabase: query }, {}, { verifyChannel: async () => { throw new Error('No Discord access allowed'); } }, { auto, price: {} });
    for (const enabled of [true, false]) await assert.rejects(monitors.save(actor, 'auto', {
        name: 'watch', providerId: 'github', source: 'octocat', destinationId: 'destination', enabled, userId: '333333333333333333', is_donor: 1,
    }), { code: 'AUTO_WATCH_DONOR_REQUIRED', status: 403 });
    assert.deepEqual(writes, []);
    const catalog = createMonitors({ queryDatabase: query }, {}, {}, { auto, price: { PROVIDERS: {} } });
    assert.equal((await catalog.providers(actor)).autoRegistration.eligible, false);
});

test('existing non-donor monitors can be stopped but cannot be reactivated or pointed at a new source', async () => {
    const row = { id: '8', user_id: U, scope: 'private', revision: 1, enabled: 0, provider_id: 'github', source_key: 'octocat', source_url: 'octocat', destination_id: 'destination', destination_type: 'dm' };
    const statements = [];
    const query = async sql => { statements.push(sql); return sql.startsWith('SELECT t.*') ? [{ ...row }] : [{ is_donor: 0 }]; };
    const monitors = createMonitors({ queryDatabase: query, withDatabaseTransaction: work => work(query) }, { audit: async () => {} }, {}, { auto, price: {}, slotDecision: async () => { throw new Error('No slot allocation allowed'); } });
    await assert.rejects(monitors.save(actor, 'auto', { expectedRevision: 1, enabled: true }, '8'), { status: 403 });
    await assert.rejects(monitors.save(actor, 'auto', { expectedRevision: 1, source: 'other' }, '8'), { status: 403 });
    assert(!statements.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE')));
    assert.equal((await monitors.save(actor, 'auto', { expectedRevision: 1, enabled: false }, '8')).revision, 2);
});

test('donor status is rechecked inside the transaction before adopting any target', async () => {
    const writes = [];
    const destination = { id: 'destination', enabled: 1, revision: 1, kind: 'dm', dm_user_id: U, scope: 'private' };
    const read = async () => [{ is_donor: 1 }];
    const transaction = async sql => { if (!sql.startsWith('SELECT')) writes.push(sql); return sql.includes('SELECT is_donor') ? [{ is_donor: 0 }] : []; };
    const monitors = createMonitors({ queryDatabase: read, withDatabaseTransaction: work => work(transaction) }, { getRow: async () => destination }, {}, { auto, price: {} });
    await assert.rejects(monitors.save(actor, 'auto', { name: 'watch', providerId: 'github', source: 'octocat', destinationId: 'destination' }), { status: 403 });
    assert(!writes.some(sql => /auto_watch_(sources|targets)|automation_monitors/.test(sql)));
});
