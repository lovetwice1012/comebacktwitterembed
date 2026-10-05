'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL sources: per-target baseline, source lease fencing, atomic cursor+queue and edits during polling', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), binding = require('../../src/db');
    const previousQuery = binding.queryDatabase, previousTransaction = binding.withDatabaseTransaction;
    let injectDeliveryFailure = false;
    binding.queryDatabase = async (sql, params) => { if (injectDeliveryFailure && /INSERT IGNORE INTO auto_watch_deliveries/.test(sql)) throw new Error('fixture delivery write failed'); return db.queryDatabase(sql, params); };
    binding.withDatabaseTransaction = db.withDatabaseTransaction;
    const autoStore = require('../../src/providers/autoWatch/store'), priceStore = require('../../src/providers/priceWatch/store');
    const service = createService(db), monitors = createMonitors(db, service, { verifyChannel: async () => ({ channel: {} }) });
    const actor = { userId: '222222222222222222' }, second = { userId: '333333333333333333' };
    await require('../lib/automation-test-db').grantTestDonor(db, actor.userId);
    await require('../lib/automation-test-db').grantTestDonor(db, second.userId);
    const dm = await service.saveDestination(actor, { name: 'DM', kind: 'dm' }), dm2 = await service.saveDestination(second, { name: 'DM2', kind: 'dm' });
    const auto = await monitors.save(actor, 'auto', { name: 'watch', providerId: 'github', source: 'octocat', destinationId: dm.id });
    const first = await monitors.getRow(actor, 'auto', auto.id);
    async function lease(kind, id) {
        const prefix = kind === 'auto' ? 'auto_watch' : 'price_watch';
        await db.queryDatabase(`UPDATE ${prefix}_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?`, [randomUUID(), Date.now() + 60000, id]);
        return (await db.queryDatabase(`SELECT * FROM ${prefix}_sources WHERE id=?`, [id]))[0];
    }
    const autoResult = contentId => ({ state: {}, cursor: { seenContentIds: [contentId] }, initializedAtMs: Date.now(), checkedAtMs: Date.now(), nextCheckAtMs: Date.now() + 3600000,
        items: [{ contentId, title: contentId, url: `https://github.com/octocat/example/releases/tag/${contentId}` }] });
    try {
        await t.test('a new target sharing an initialized source seeds itself without receiving older discoveries', async () => {
            await db.queryDatabase('UPDATE auto_watch_sources SET initialized_at_ms=? WHERE id=?', [Date.now() - 10000, first.source_id]);
            await autoStore.completeSource(await lease('auto', first.source_id), autoResult('a'));
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_deliveries'))[0].n), 0);
            assert((await monitors.getRow(actor, 'auto', auto.id)).baseline_at_ms);
            const added = await monitors.save(second, 'auto', { name: 'second', providerId: 'github', source: 'octocat', destinationId: dm2.id });
            assert.equal(String((await monitors.getRow(second, 'auto', added.id)).source_id), String(first.source_id));
            await autoStore.completeSource(await lease('auto', first.source_id), autoResult('b'));
            let deliveries = await db.queryDatabase('SELECT target_id FROM auto_watch_deliveries'); assert.equal(deliveries.length, 1); assert.equal(String(deliveries[0].target_id), auto.id);
            await autoStore.completeSource(await lease('auto', first.source_id), autoResult('c'));
            deliveries = await db.queryDatabase('SELECT target_id FROM auto_watch_deliveries'); assert.equal(deliveries.length, 3);
        });
        await t.test('an expired or replaced source lease cannot add events or advance the cursor', async () => {
            const stale = await lease('auto', first.source_id); await lease('auto', first.source_id);
            await assert.rejects(autoStore.completeSource(stale, autoResult('stale')), { code: 'AUTO_WATCH_LEASE_LOST' });
            assert.equal((await db.queryDatabase("SELECT * FROM auto_watch_items WHERE content_key='stale'")).length, 0);
            assert.equal(JSON.parse((await db.queryDatabase('SELECT cursor_json FROM auto_watch_sources WHERE id=?', [first.source_id]))[0].cursor_json).seenContentIds[0], 'c');
        });
        await t.test('queue insertion failure rolls back the observation cursor and item together', async () => {
            const source = await lease('auto', first.source_id); injectDeliveryFailure = true;
            await assert.rejects(autoStore.completeSource(source, autoResult('rollback')), /fixture delivery/); injectDeliveryFailure = false;
            assert.equal((await db.queryDatabase("SELECT * FROM auto_watch_items WHERE content_key='rollback'")).length, 0);
            const row = (await db.queryDatabase('SELECT cursor_json,lease_token FROM auto_watch_sources WHERE id=?', [first.source_id]))[0];
            assert.equal(JSON.parse(row.cursor_json).seenContentIds[0], 'c'); assert.equal(row.lease_token, source.lease_token);
        });
        await t.test('new price targets establish their own baseline and notify only on repeated later crossings', async () => {
            const target = await monitors.save(actor, 'price', { name: 'price', providerId: 'steam', source: 'https://store.steampowered.com/app/730', destinationId: dm.id, mode: 'threshold', maxPriceAmount: 1000 });
            const row = await monitors.getRow(actor, 'price', target.id);
            await db.queryDatabase('UPDATE price_watch_sources SET initialized_at_ms=?,state_json=? WHERE id=?', [Date.now() - 10000, JSON.stringify({ priceAmount: 1200, currency: 'JPY' }), row.source_id]);
            let amount = 900;
            const runner = require('../../src/providers/priceWatch/runner');
            const store = { ...priceStore, claimDueSources: async () => [await lease('price', row.source_id)], reserveProvider: async () => ({ allowed: true }), claimDueDeliveries: async () => [] };
            const tick = () => runner.tick({ store, now: Date.now(), fetchPrice: async () => ({ priceAmount: amount, currency: 'JPY', discountPercent: 0, productName: 'Fixture', productUrl: 'https://store.steampowered.com/app/730' }) });
            await tick(); assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM price_watch_deliveries'))[0].n), 0);
            amount = 1100; await tick(); amount = 900; await tick();
            amount = 1100; await tick(); amount = 900; await tick();
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM price_watch_deliveries'))[0].n), 2);
            const stale = await lease('price', row.source_id); await lease('price', row.source_id);
            await assert.rejects(priceStore.completeSource(stale, { priceAmount: 1 }, [], [], Date.now(), Date.now() + 1000), { code: 'PRICE_WATCH_LEASE_LOST' });
            amount = 1100; await tick(); amount = 900;
            const completing = store.completeSource;
            store.completeSource = async (...args) => {
                await monitors.save(actor, 'price', { expectedRevision: 1, enabled: false }, target.id);
                return completing(...args);
            };
            await tick(); assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM price_watch_deliveries'))[0].n), 2, 'a target disabled after fetch gets no new event');
        });
    } finally { binding.queryDatabase = previousQuery; binding.withDatabaseTransaction = previousTransaction; await db.close(); }
});
