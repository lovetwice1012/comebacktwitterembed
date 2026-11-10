'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const entitlements = require('../../src/automation/entitlements');
const { applyApprovedPlanPolicies } = require('../../src/automation/plan-redesign');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('This test requires disposable AUTOMATION_TEST_DB_PORT=33621');

test('shared price sources preserve each plan baseline and wake on upgrade', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), now = Date.now(), admin = { userId: '900', isAdmin: true };
    const paths = ['../../src/db', '../../src/providers/priceWatch/store', '../../src/providers/priceWatch/runner', '../../src/db_schema'].map(require.resolve);
    const previous = paths.map(path => require.cache[path]);
    try {
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1),(?,0,0),(?,0,0)', ['100', '200', '300']);
        await db.withDatabaseTransaction(query => entitlements.savePlanPolicy(query, admin, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30 }));
        const snapshot = { productName: 'Fixture', productUrl: 'https://store.steampowered.com/app/730', priceAmount: 2000, currency: 'JPY', observationSequence: 1 };
        const source = await db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,state_json,initialized_at_ms,poll_interval_ms,next_check_at_ms,last_checked_at_ms,created_at_ms) VALUES ('steam','app:730',?,'ja',?,?,3600000,?,?,1)", [snapshot.productUrl, JSON.stringify(snapshot), now - 1, now + 3600000, now]);
        await db.queryDatabase("INSERT INTO price_watch_targets (source_id,user_id,destination_type,destination_key,watch_mode,rule_key,baseline_at_ms,created_at_ms) VALUES (?,?,'dm','dm:200','change','change',?,1),(?,?,'dm','dm:300','change','change',?,1)", [source.insertId, '200', now - 1, source.insertId, '300', now - 1]);
        await db.withDatabaseTransaction(query => applyApprovedPlanPolicies(query, { actor: admin, ownerIds: ['100'], now }));
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, admin, '300', 'subscription_basic'));
        const next = (await db.queryDatabase('SELECT next_check_at_ms FROM price_watch_sources WHERE id=?', [source.insertId]))[0];
        assert(Number(next.next_check_at_ms) <= Date.now());
        db.ensureUserExistsInDatabase = async id => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [id]);
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: db };
        const schema = require(paths[3]);
        require.cache[paths[3]] = { ...previous[3], exports: { ...schema, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[1]]; delete require.cache[paths[2]];
        const nativeStore = require(paths[1]), { tick } = require(paths[2]);
        const store = { ...nativeStore, reserveProvider: async () => ({ allowed: true }), claimDueDeliveries: async () => [] };
        const fetchPrice = async () => ({ ...snapshot, priceAmount: 1000 });
        let result = await tick({ now: now + 10 * 60000, store, fetchPrice });
        assert.equal(result.sources[0].status, 'processed');
        let deliveries = await db.queryDatabase('SELECT t.user_id,d.event_json FROM price_watch_deliveries d JOIN price_watch_targets t ON t.id=d.target_id');
        assert.deepEqual(deliveries.map(row => row.user_id), ['300']);
        result = await tick({ now: now + 180 * 60000, store, fetchPrice });
        assert.equal(result.sources[0].status, 'processed');
        deliveries = await db.queryDatabase('SELECT t.user_id,d.event_json FROM price_watch_deliveries d JOIN price_watch_targets t ON t.id=d.target_id ORDER BY t.user_id');
        assert.deepEqual(deliveries.map(row => row.user_id), ['200', '300']);
        assert.equal(JSON.parse(deliveries[0].event_json).previousPriceAmount, 2000);
        const savedBaseline = (await db.queryDatabase("SELECT c.target_id,c.baseline_json FROM automation_price_watch_cadence c JOIN price_watch_targets t ON t.id=c.target_id WHERE t.user_id='200'"))[0];
        await db.queryDatabase("UPDATE automation_price_watch_cadence SET baseline_json='{' WHERE target_id=?", [savedBaseline.target_id]);
        await assert.rejects(nativeStore.sourceTargets(source.insertId, now + 180 * 60000), { code: 'PRICE_WATCH_CADENCE_CORRUPT' });
        assert.equal((await db.queryDatabase('SELECT baseline_json FROM automation_price_watch_cadence WHERE target_id=?', [savedBaseline.target_id]))[0].baseline_json, '{');
        await db.queryDatabase('UPDATE automation_price_watch_cadence SET baseline_json=? WHERE target_id=?', [savedBaseline.baseline_json, savedBaseline.target_id]);
        const changedAt = now + 181 * 60000;
        const stale = (await nativeStore.sourceTargets(source.insertId, changedAt)).find(row => row.user_id === '300');
        await db.withDatabaseTransaction(query => entitlements.setUserPlan(query, admin, '300', 'subscription_lite'));
        await db.queryDatabase("UPDATE price_watch_sources SET lease_token='fixture-lease',lease_expires_at_ms=? WHERE id=?", [Date.now() + 3600000, source.insertId]);
        await nativeStore.completeSource({ id: source.insertId, lease_token: 'fixture-lease' }, { ...snapshot, priceAmount: 500 },
            [{ targetId: stale.id, eventKey: 'a'.repeat(64), messageText: 'fixture', event: {} }],
            [{ targetId: stale.id, conditionActive: false, ruleKey: stale.rule_key, destinationKey: stale.destination_key, configurationRevision: Number(stale.configuration_revision), planCadence: stale.planCadence }], changedAt, changedAt + 600000);
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM price_watch_deliveries WHERE event_key=?", ['a'.repeat(64)]))[0].n), 0);
        assert(Number((await db.queryDatabase('SELECT next_check_at_ms FROM price_watch_sources WHERE id=?', [source.insertId]))[0].next_check_at_ms) <= changedAt + 1000);
        const freshAt = changedAt + 3600000;
        const fresh = (await nativeStore.sourceTargets(source.insertId, freshAt)).find(row => row.user_id === '300');
        const prior = (await db.queryDatabase('SELECT last_checked_at_ms,baseline_json FROM automation_price_watch_cadence WHERE target_id=?', [fresh.id]))[0];
        const sourceBeforeFailure = (await db.queryDatabase('SELECT state_json FROM price_watch_sources WHERE id=?', [source.insertId]))[0].state_json;
        await db.queryDatabase("UPDATE price_watch_sources SET lease_token='failure-lease',lease_expires_at_ms=? WHERE id=?", [Date.now() + 3600000, source.insertId]);
        const transaction = db.withDatabaseTransaction;
        db.withDatabaseTransaction = work => transaction(query => work(async (sql, params) => {
            if (sql.includes('INSERT IGNORE INTO price_watch_deliveries')) await query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected delivery failure'");
            return query(sql, params);
        }));
        try {
            await assert.rejects(nativeStore.completeSource({ id: source.insertId, lease_token: 'failure-lease' }, { ...snapshot, priceAmount: 300 },
                [{ targetId: fresh.id, eventKey: 'b'.repeat(64), messageText: 'fixture', event: {} }],
                [{ targetId: fresh.id, conditionActive: false, ruleKey: fresh.rule_key, destinationKey: fresh.destination_key, configurationRevision: Number(fresh.configuration_revision), planCadence: fresh.planCadence }], freshAt, freshAt + 600000));
        } finally { db.withDatabaseTransaction = transaction; }
        const afterFailure = (await db.queryDatabase('SELECT last_checked_at_ms,baseline_json FROM automation_price_watch_cadence WHERE target_id=?', [fresh.id]))[0];
        assert.equal(String(afterFailure.last_checked_at_ms), String(prior.last_checked_at_ms));
        assert.equal(afterFailure.baseline_json, prior.baseline_json);
        assert.equal((await db.queryDatabase('SELECT state_json FROM price_watch_sources WHERE id=?', [source.insertId]))[0].state_json, sourceBeforeFailure);
        await db.queryDatabase('UPDATE price_watch_targets SET enabled=0 WHERE id=?', [fresh.id]);
        await db.queryDatabase('UPDATE price_watch_sources SET next_check_at_ms=? WHERE id=?', [Date.now() + 3600000, source.insertId]);
        const resumed = await nativeStore.registerTarget({ userId: '300', providerId: 'steam', productUrl: snapshot.productUrl, locale: 'ja', destinationType: 'dm', mode: 'change' }, { now: Date.now(), random: () => 0 });
        assert.equal(resumed.id, String(fresh.id));
        assert.equal((await db.queryDatabase('SELECT baseline_at_ms FROM price_watch_targets WHERE id=?', [fresh.id]))[0].baseline_at_ms, null);
        assert.equal((await db.queryDatabase('SELECT * FROM automation_price_watch_cadence WHERE target_id=?', [fresh.id])).length, 0);
        assert(Number((await db.queryDatabase('SELECT next_check_at_ms FROM price_watch_sources WHERE id=?', [source.insertId]))[0].next_check_at_ms) <= Date.now());
    } finally {
        for (let i = 0; i < paths.length; i++) if (previous[i]) require.cache[paths[i]] = previous[i]; else delete require.cache[paths[i]];
        await db.close();
    }
});
