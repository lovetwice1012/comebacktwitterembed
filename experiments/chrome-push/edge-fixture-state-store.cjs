'use strict';
// Disposable-schema experiment only; no production schema or runtime uses it.
const { lockOwner } = require('../../src/automation/entitlements');
const fail = code => Object.assign(new Error(code), { code });
function createSyntheticTokenStateStore(db, { vault, now = Date.now } = {}) {
    if (process.env.NODE_ENV !== 'test' || !db || !/^cbte_automation_test_[0-9a-f]{20}$/.test(db.schema || '') || db.fixturePort !== 33621
        || typeof db.queryDatabase !== 'function' || typeof db.withDatabaseTransaction !== 'function'
        || !vault || typeof vault.seal !== 'function' || typeof vault.open !== 'function' || typeof now !== 'function')
        throw fail('PROBE_STATE_CONFIG_INVALID');
    function validateLease(lease) {
        if (!lease || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(lease.subscriptionId || '')
            || !/^\d{1,32}$/.test(lease.ownerUserId || '') || !/^[0-9a-f]{64}$/.test(lease.token || '')
            || !Number.isSafeInteger(lease.revision) || lease.revision < 1) throw fail('PROBE_STATE_LEASE_INVALID');
    }
    function fence(lease, subscription, receiver) {
        if (!subscription || !receiver || Number(subscription.revision) !== lease.revision || Number(receiver.subscription_revision) !== lease.revision
            || receiver.lease_token !== lease.token || Number(receiver.lease_expires_at_ms) <= now()) throw fail('PROBE_STATE_LEASE_LOST');
    }
    async function locked(lease, authorize, work) {
        validateLease(lease); if (typeof authorize !== 'function') throw fail('PROBE_STATE_CONFIG_INVALID');
        try {
            return await db.withDatabaseTransaction(async query => {
                await lockOwner(query, lease.ownerUserId);
                const subscription = (await query('SELECT revision FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [lease.subscriptionId, lease.ownerUserId]))[0];
                const receiver = (await query('SELECT * FROM automation_x_push_receivers WHERE subscription_id=? FOR UPDATE', [lease.subscriptionId]))[0];
                fence(lease, subscription, receiver); await authorize(query); fence(lease, subscription, receiver);
                return work(query, subscription, receiver);
            });
        } catch (error) { if (/^PROBE_STATE_[A-Z_]+$/.test(error?.code || '')) throw error; throw fail('PROBE_STATE_STORE_UNAVAILABLE'); }
    }
    return {
        async initialize() {
            await db.queryDatabase(`CREATE TABLE IF NOT EXISTS cbte_fixture_wns_state (
                subscription_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
                subscription_revision INT UNSIGNED NOT NULL, generation BIGINT UNSIGNED NOT NULL,
                sealed_json TEXT NULL
            ) ENGINE=InnoDB`);
        },
        async save(lease, token, expectedGeneration, authorize) {
            if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || expectedGeneration >= Number.MAX_SAFE_INTEGER) throw fail('PROBE_STATE_GENERATION_INVALID');
            return locked(lease, authorize, async (query, subscription, receiver) => {
                await query('INSERT INTO cbte_fixture_wns_state (subscription_id,subscription_revision,generation,sealed_json) VALUES (?,?,0,NULL) ON DUPLICATE KEY UPDATE subscription_id=VALUES(subscription_id)', [lease.subscriptionId, lease.revision]);
                const row = (await query('SELECT * FROM cbte_fixture_wns_state WHERE subscription_id=? FOR UPDATE', [lease.subscriptionId]))[0];
                if (!row || Number(row.subscription_revision) !== lease.revision || Number(row.generation) !== expectedGeneration) throw fail('PROBE_STATE_GENERATION_CONFLICT');
                const generation = expectedGeneration + 1;
                const sealed = vault.seal(token, { subscriptionId: lease.subscriptionId, ownerUserId: lease.ownerUserId, revision: lease.revision, generation });
                const updated = await query('UPDATE cbte_fixture_wns_state SET generation=?,sealed_json=? WHERE subscription_id=? AND generation=?',
                    [generation, JSON.stringify(sealed), lease.subscriptionId, expectedGeneration]);
                if (Number(updated.affectedRows) !== 1) throw fail('PROBE_STATE_GENERATION_CONFLICT');
                fence(lease, subscription, receiver);
                return { generation };
            });
        },
        async read(lease, authorize) {
            let opened;
            try { return await locked(lease, authorize, async (query, subscription, receiver) => {
                const row = (await query('SELECT * FROM cbte_fixture_wns_state WHERE subscription_id=? FOR UPDATE', [lease.subscriptionId]))[0];
                if (!row) return null;
                const generation = Number(row.generation);
                if (Number(row.subscription_revision) !== lease.revision || !Number.isSafeInteger(generation) || generation < 1 || typeof row.sealed_json !== 'string')
                    throw fail('PROBE_STATE_GENERATION_CONFLICT');
                opened = vault.open(JSON.parse(row.sealed_json), { subscriptionId: lease.subscriptionId, ownerUserId: lease.ownerUserId, revision: lease.revision, generation });
                fence(lease, subscription, receiver);
                return { generation, token: opened };
            }); } catch (error) { opened?.fill(0); throw error; }
        },
    };
}
module.exports = { createSyntheticTokenStateStore };
