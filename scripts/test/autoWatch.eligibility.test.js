'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertRegistrationAllowed, registrationStatus } = require('../../src/providers/autoWatch/eligibility');
const U = '222222222222222222';

test('free users may register; supporter status no longer acts as a donor-only admission gate', async () => {
    for (const flag of [0, '0', 1, '1', 2, -1, null, undefined, 'true']) {
        const query = async (sql, params) => {
            assert.match(sql, /SELECT is_donor FROM users WHERE user_id=\?/); assert.deepEqual(params, [U]);
            return [{ is_donor: flag }];
        };
        assert.deepEqual(await registrationStatus(query, U), { donorOnly: false, eligible: true });
        assert.equal((await assertRegistrationAllowed(query, U)).eligible, true);
    }
    assert.equal((await assertRegistrationAllowed(async () => [], U)).eligible, true);
});

test('registration can still lock a trusted user row and propagates database failures', async () => {
    await assertRegistrationAllowed(async sql => { assert.match(sql, /FOR UPDATE$/); return [{ is_donor: 0 }]; }, U, true);
    await assert.rejects(assertRegistrationAllowed(async () => { throw new Error('database unavailable'); }, U), /database unavailable/);
    for (const id of ['', 'spoof', '../user']) await assert.rejects(assertRegistrationAllowed(async () => [], id), { code: 'AUTO_WATCH_INVALID_USER' });
});
