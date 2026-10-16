'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const priceRunner = require('../../src/providers/priceWatch/runner');
const { fetchSource } = require('../../src/providers/autoWatch');
const { fetchPrice } = require('../../src/providers/priceWatch');
const root = path.resolve(__dirname, '../..');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), user = '222222222222222222';
const autoRunner = load('src/providers/autoWatch/runner.js', null)._internal;

function load(relative, db) {
    const filename = path.join(root, relative), native = createRequire(filename), mod = { exports: {} };
    const replacements = { '../../db': { ...db, ensureUserExistsInDatabase: id => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [id]) },
        '../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} }, '../../errorTracking': { recordError: () => {} } };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => Object.hasOwn(replacements, id) ? replacements[id] : native(id), mod, mod.exports);
    return mod.exports;
}
function response(body, url) { return { ok: true, status: 200, url, text: async () => body, json: async () => body }; }

test('S14-1 SQL BOOTH unavailable first page preserves uninitialized state; recovery seeds history, explicit empty shop admits future items', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, user);
        const store = { ...load('src/providers/autoWatch/store.js', db), reserveProviderRequest: async () => ({ allowed: true }), recordProviderRateLimit: async () => {} };
        const registration = await store.registerTarget({ userId: user, providerId: 'booth', source: 'sample', destinationType: 'dm' }, { initialJitterMs: 0 });
        const target = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [registration.id]))[0];
        let html = '<h1>Temporarily unavailable</h1>Please try again later', now = Date.now() + 100;
        const run = async () => {
            await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [randomUUID(), Date.now() + 60000, target.source_id]);
            const source = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [target.source_id]))[0];
            return autoRunner.processSource(source, { now: now += 1000, store, config: { enableGuestCrawls: true }, sourceCounts: new Map(),
                fetchSource: source => fetchSource(source, { config: { enableGuestCrawls: true }, fetch: async url => response(html, url) }) });
        };
        const catalog = ids => `<div data-items="${JSON.stringify(ids.map(id => ({ id, shop_item_url: `https://sample.booth.pm/items/${id}`, name: `Item ${id}`, published_at: '2025-01-01T00:00:00Z' }))).replaceAll('"', '&quot;')}"></div>`;
        assert.equal((await run()).errorCode, 'AUTO_WATCH_INVALID_RESPONSE');
        assert.equal((await db.queryDatabase('SELECT initialized_at_ms FROM auto_watch_sources WHERE id=?', [target.source_id]))[0].initialized_at_ms, null);
        assert.equal((await db.queryDatabase('SELECT baseline_at_ms FROM auto_watch_targets WHERE id=?', [registration.id]))[0].baseline_at_ms, null);
        html = catalog([100]); assert.equal((await run()).status, 'seeded');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_items'))[0].n), 0);
        html = catalog([101, 100]); assert.equal((await run()).newItemCount, 1);
        assert.deepEqual((await db.queryDatabase('SELECT content_key FROM auto_watch_items')).map(row => row.content_key), ['101']);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_deliveries'))[0].n), 1);
        // A real explicit empty catalog is a valid first baseline, independently
        // of the unavailable response's retry path.
        const emptyRegistration = await store.registerTarget({ userId: user, providerId: 'booth', source: 'empty-shop', destinationType: 'dm' }, { initialJitterMs: 0 });
        const emptyTarget = (await db.queryDatabase('SELECT * FROM auto_watch_targets WHERE id=?', [emptyRegistration.id]))[0];
        await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', ['empty', Date.now() + 60000, emptyTarget.source_id]);
        const emptySource = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [emptyTarget.source_id]))[0];
        const empty = await autoRunner.processSource(emptySource, { now, store, config: {}, sourceCounts: new Map(),
            fetchSource: source => fetchSource(source, { config: {}, fetch: async url => response('<div data-items="[]"></div>', url) }) });
        assert.equal(empty.status, 'seeded');
        assert.notEqual((await db.queryDatabase('SELECT baseline_at_ms FROM auto_watch_targets WHERE id=?', [emptyRegistration.id]))[0].baseline_at_ms, null);
        await db.queryDatabase('UPDATE auto_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', ['empty-next', Date.now() + 60000, emptyTarget.source_id]);
        const emptyNextSource = (await db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [emptyTarget.source_id]))[0];
        const added = await autoRunner.processSource(emptyNextSource, { now: now + 1000, store, config: {}, sourceCounts: new Map(),
            fetchSource: source => fetchSource(source, { config: {}, fetch: async url => response('<a href="https://empty-shop.booth.pm/items/200">New item</a>', url) }) });
        assert.equal(added.newItemCount, 1);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_deliveries WHERE target_id=?', [emptyRegistration.id]))[0].n), 1);
    } finally { await db.close(); }
});

test('T7 SQL Steam API/HTML fallback retains the current sale condition across restart, and a verified sale end permits a later alert', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, user);
        const store = { ...load('src/providers/priceWatch/store.js', db), reserveProvider: async () => ({ allowed: true }), claimDueDeliveries: async () => [] };
        const registration = await store.registerTarget({ userId: user, providerId: 'steam', productUrl: 'https://store.steampowered.com/app/730', locale: 'ja', destinationType: 'dm', mode: 'threshold', minDiscountPercent: 50 }, { initialJitterMs: 0 });
        let kind = 'regular', now = Date.now() + 100;
        const fetch = async url => {
            if (String(url).includes('appdetails')) {
                if (kind === 'unknown' || kind === 'html') return { ok: false, status: 503 };
                const final = kind === 'regular' ? 100000 : 50000;
                return response({ 730: { success: true, data: { name: 'Fixture', price_overview: { final, initial: 100000, currency: 'JPY', discount_percent: kind === 'regular' ? 0 : 50 } } } }, url);
            }
            return response(`<div itemprop="offers"><meta itemprop="priceCurrency" content="JPY"><meta itemprop="price" content="500"></div><div class="game_purchase_action_bg"><div class="discount_block" data-price-final="50000" ${kind === 'html' ? 'data-discount="50"' : ''}>${kind === 'html' ? '<div class="discount_original_price">¥1,000</div>' : ''}<div class="discount_final_price">¥500</div></div></div>`, url);
        };
        const observe = async mode => {
            kind = mode; now += 1000;
            await db.queryDatabase('UPDATE price_watch_sources SET next_check_at_ms=0,lease_expires_at_ms=0');
            // Every tick reloads its checkpoint/condition from SQL, representing
            // a new process with no retained in-memory sale state.
            const result = await priceRunner.tick({ now, store, sourceLimit: 1, fetchPrice: source => fetchPrice(source, { fetch }) });
            assert.notEqual(result.sources[0].status, 'failed');
        };
        await observe('regular'); await observe('api');
        const count = async () => Number((await db.queryDatabase('SELECT COUNT(*) n FROM price_watch_deliveries'))[0].n);
        assert.equal(await count(), 1);
        for (const mode of ['html', 'unknown', 'api']) { await observe(mode); assert.equal(await count(), 1); assert.equal(Number((await db.queryDatabase('SELECT condition_active FROM price_watch_targets WHERE id=?', [registration.id]))[0].condition_active), 1); }
        await observe('regular'); assert.equal(Number((await db.queryDatabase('SELECT condition_active FROM price_watch_targets WHERE id=?', [registration.id]))[0].condition_active), 0);
        await observe('api'); assert.equal(await count(), 2);
    } finally { await db.close(); }
});
