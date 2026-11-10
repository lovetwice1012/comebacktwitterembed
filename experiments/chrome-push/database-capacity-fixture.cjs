'use strict';
// Synthetic users and fake sockets, real candidate queries and routing policy.
// This fixture is deliberately restricted to the disposable loopback DB.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createTestDatabase } = require('../../scripts/lib/automation-test-db');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const entitlements = require('../../src/automation/entitlements');

async function main() {
    assert.equal(Number(process.env.AUTOMATION_TEST_DB_PORT), 33631);
    const count = Number(process.env.CBTE_CAPACITY_COUNT || 1000);
    assert(Number.isInteger(count) && count >= 1 && count <= 1000);
    const db = await createTestDatabase(33631); let runtime;
    try {
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query,
            { userId: '999999999999999999', isAdmin: true },
            { planId: 'free', label: 'fixture', slotLimit: 5, minuteLimit: 5, dayLimit: 24, priority: 0, intervalMinutes: 5 }));
        const records = Array.from({ length: count }, (_, i) => ({
            id: randomUUID(), owner: String(200000000000000000n + BigInt(i)),
            hash: createHash('sha256').update(String(i)).digest('hex'),
        }));
        for (let i = 0; i < records.length; i += 100) {
            const batch = records.slice(i, i + 100);
            await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES ?', [batch.map(r => [r.owner, 0, 1])]);
            await db.queryDatabase('INSERT INTO automation_x_subscriptions (id,owner_user_id,uaid_hash,channel_hash,content_hash,sealed_json,key_id,browser_kind,browser_version,revision,created_at_ms,updated_at_ms) VALUES ?',
                [batch.map(r => [r.id, r.owner, r.hash, r.hash, r.hash, '{}', 'fixture', 'chrome', '157.0.0.0', 1, 0, 0])]);
            await db.queryDatabase('INSERT INTO automation_x_monitors (owner_user_id,account_id,name,enabled,state,pool_kind,notification_settings_json,subscription_state,created_at_ms,updated_at_ms) VALUES ?',
                [batch.map(r => [r.owner, '12345', 'fixture', 1, 'ready', 'free', JSON.stringify({ subscriptionId: r.id }), 'bound', 0, 0])]);
        }
        let queries = 0, active = 0;
        const groups = { monitors: 0, donor: 0, slots: 0, plan: 0, other: 0 };
        const measuredDb = { ...db, queryDatabase: async (...args) => {
            queries++;
            const sql = String(args[0]);
            const group = sql.includes('automation_x_monitors') ? 'monitors' : sql.includes('is_donor') ? 'donor'
                : sql.includes('automation_notification_slots') ? 'slots' : /automation_(?:push_plan_policy|notification_plans)/.test(sql) ? 'plan' : 'other';
            groups[group]++;
            return db.queryDatabase(...args);
        } };
        const gateway = { store: { assertLease: async () => {}, beginProcessing: async () => ({ ready: false }) }, run: input => {
            active++;
            queueMicrotask(() => input.onSession({ lease: { subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId, revision: 1 } }));
            return new Promise(resolve => input.signal.addEventListener('abort', () => { active--; resolve({ state: 'stopped' }); }, { once: true }));
        } };
        runtime = createXPushRuntime(measuredDb, {}, { enabled: true, gateway, rolloutMode: 'supporters', processingPolicy: 'batch', assertAllowed() {} });
        const started = performance.now(), startupTicks = [];
        while (runtime.status().sessions < count) {
            if (startupTicks.length > Math.ceil(count / 100) + 2) throw new Error('FIXTURE_CAPACITY_ADMISSION_FAILED');
            const tick = performance.now(); await runtime.tick(); startupTicks.push(Math.round(performance.now() - tick));
        }
        const afterStartupQueries = queries, beforeGroups = { ...groups }, steadyTicks = [];
        for (let i = 0; i < 3; i++) { const tick = performance.now(); await runtime.tick(); steadyTicks.push(Math.round(performance.now() - tick)); }
        assert.equal(active, count); assert.equal(runtime.status().sessions, count);
        console.log(JSON.stringify({ fixture: 'fake-sockets-real-sql', connections: count, processCount: 1,
            databasePoolLimit: 8, startupMs: Math.round(performance.now() - started - steadyTicks.reduce((a, b) => a + b, 0)),
            startupTickMs: startupTicks, steadyTickMs: steadyTicks, steadySqlQueries: queries - afterStartupQueries,
            steadySqlGroups: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value - beforeGroups[key]])),
            rssMiB: Math.round(process.memoryUsage().rss / 1048576), externalPushRequests: 0 }));
    } finally { await runtime?.stop(); await db.close(); }
}
main().catch(error => { console.error(/^FIXTURE_[A-Z_]+$/.test(error?.message || '') ? error.message : error?.code || 'FIXTURE_CAPACITY_FAILED'); process.exitCode = 1; });
