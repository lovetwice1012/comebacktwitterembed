'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const { withRateOperation } = require('../../src/automation/rate-operation');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL: native watch operations share durable actor limits, preserve nested preflight and keep deletion available', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), U = '222222222222222222', V = '333333333333333333', W = '444444444444444444';
    const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/autoWatch/store'), require.resolve('../../src/providers/priceWatch/store')];
    const originals = paths.map(path => require.cache[path]);
    let now = Date.now();
    const limiter = createRateLimiter(db, { clock: () => now });
    try {
        const binding = { ...db, ensureUserExistsInDatabase: async userId => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [userId]) };
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: binding };
        require.cache[paths[1]] = { ...originals[1], exports: { ...originals[1].exports, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[2]]; delete require.cache[paths[3]];
        let auto = require(paths[2]); const price = require(paths[3]), options = { operationRateLimiter: limiter };
        const input = userId => ({ userId, providerId: 'github', source: 'octocat', destinationType: 'dm' });
        let first;
        await t.test('11th repeated existing registration rejects before target mutation and survives a fresh store/limiter', async () => {
            first = await auto.registerTarget(input(U), options);
            for (let i = 1; i < 10; i++) assert.equal((await auto.registerTarget(input(U), options)).id, first.id);
            await assert.rejects(auto.registerTarget(input(U), options), error => error.code === 'AUTOMATION_RATE_LIMITED' && error.status === 429 && error.limit === 10 && error.retryAfterMs > 0 && error.issues[0].path === 'request');
            delete require.cache[paths[2]]; auto = require(paths[2]);
            const restarted = createRateLimiter(db, { clock: () => now });
            await assert.rejects(auto.registerTarget(input(U), { operationRateLimiter: restarted }), { code: 'AUTOMATION_RATE_LIMITED' });
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets WHERE user_id=?', [U]))[0].n), 1);
            await auto.deleteTarget(U, first.id);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets WHERE user_id=?', [U]))[0].n), 0);
        });
        await t.test('minute rollover permits new operations while actor allowance remains independent', async () => {
            now += 60001;
            first = await auto.registerTarget(input(U), options);
            const other = await auto.registerTarget(input(V), options);
            assert(first.id && other.id); assert.notEqual(first.id, other.id);
        });
        await t.test('concurrent repeated native auto/price registration consumes the same monitor budget once per attempt', async () => {
            const source = (await db.queryDatabase('SELECT source_id FROM auto_watch_targets WHERE user_id=?', [V]))[0].source_id;
            await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [W]);
            await db.queryDatabase("INSERT INTO auto_watch_targets (user_id,source_id,destination_type,destination_key,premium_slot,enabled,created_at_ms) VALUES (?,?,'dm',?,0,1,0)", [W, source, `dm:${W}`]);
            await db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES ('steam','app:440','https://store.steampowered.com/app/440','en-US',60000,0,0)");
            const priceSource = (await db.queryDatabase("SELECT id FROM price_watch_sources WHERE provider_id='steam'"))[0].id;
            await db.queryDatabase("INSERT INTO price_watch_targets (user_id,source_id,destination_type,destination_key,watch_mode,rule_key,enabled,created_at_ms) VALUES (?,?,'dm',?,'change','change',1,0)", [W, priceSource, `dm:${W}`]);
            const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => index % 2
                ? price.registerTarget({ userId: W, providerId: 'steam', productUrl: 'https://store.steampowered.com/app/440/', destinationType: 'dm', mode: 'change' }, options)
                : auto.registerTarget(input(W), options)));
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
            for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'AUTOMATION_RATE_LIMITED');
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets WHERE user_id=?', [W]))[0].n), 1);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM price_watch_targets WHERE user_id=?', [W]))[0].n), 1);
        });
        await t.test('Discord-style preflight and nested store share admission, but a nested different actor is charged separately', async () => {
            const X = '555555555555555555', Y = '666666666666666666';
            for (let index = 0; index < 10; index++) await withRateOperation(binding, { userId: X }, 'monitor', () => auto.registerTarget(input(X), options), { rateLimiter: limiter });
            await assert.rejects(auto.registerTarget(input(X), options), { code: 'AUTOMATION_RATE_LIMITED' });
            // A saturated actor cannot borrow the enclosing actor's admission.
            await assert.rejects(withRateOperation(binding, { userId: Y }, 'monitor', () => auto.registerTarget(input(X), options), { rateLimiter: limiter }), { code: 'AUTOMATION_RATE_LIMITED' });
            const y = await auto.registerTarget(input(Y), options); assert(y.id);
        });
    } finally {
        paths.forEach((path, index) => { if (originals[index]) require.cache[path] = originals[index]; else delete require.cache[path]; });
        await db.close();
    }
});
