'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createPolicy, intervalMinutes } = require('../../src/providers/autoWatch/intervalPolicy');
const { effectivePollIntervalMs } = require('../../src/providers/autoWatch');
const load = require('./helpers/load-dashboard.cjs');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const A = '111111111111111111', B = '222222222222222222', ADMIN = '796972193287503913';

test('interval overrides accept only integer minutes at least five, and retain provider budgets', () => {
    for (const value of [0, 4, 5.5, '5', undefined, NaN, 10081]) assert.throws(() => intervalMinutes(value), { code: 'AUTO_WATCH_INVALID_INTERVAL' });
    assert.equal(intervalMinutes(5), 5); assert.equal(intervalMinutes(null), null);
    assert.equal(effectivePollIntervalMs('youtube', 1, 300000, { userOverride: true }), 300000);
    assert.equal(effectivePollIntervalMs('youtube', 1, 0), 1800000);
    assert(effectivePollIntervalMs('github', 30, 300000, { userOverride: true }) >= 3600000);
});

test('shared SQL retrieval uses the fastest active user but routes notifications at independent user windows', { skip: !port }, async () => {
    const db = await createTestDatabase(port), binding = require('../../src/db');
    const originalQuery = binding.queryDatabase, originalTransaction = binding.withDatabaseTransaction, originalEnsureUser = binding.ensureUserExistsInDatabase;
    binding.queryDatabase = db.queryDatabase; binding.withDatabaseTransaction = db.withDatabaseTransaction;
    binding.ensureUserExistsInDatabase = async () => {}; // Both disposable users are explicitly seeded below.
    try {
        const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../migrations/20261006_add_user_auto_watch_intervals.sql'), 'utf8');
        const statements = require('../../src/db_schema')._internal.splitSqlStatements(migration);
        await db.queryDatabase(statements.find(sql => sql.startsWith('CREATE TABLE')));
        const store = require('../../src/providers/autoWatch/store'), runner = require('../../src/providers/autoWatch/runner')._internal;
        const policy = createPolicy(db), start = Date.now();
        for (const id of [A, B]) await grantTestDonor(db, id);
        await db.queryDatabase('UPDATE users SET additional_auto_extract_slots=9 WHERE user_id=?', [A]);
        const watch = id => store.registerTarget({ providerId: 'youtube', source: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', userId: id, destinationType: 'dm' }, { now: start, initialJitterMs: 0 });
        const first = await watch(A), second = await watch(B);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_sources'))[0].n), 1);
        const run = async (at, ids) => {
            await db.queryDatabase('UPDATE auto_watch_sources SET next_check_at_ms=?,lease_expires_at_ms=0', [at]);
            const [source] = await store.claimDueSources(at, 1);
            return runner.processSource(source, { now: at, store, config: {}, sourceCounts: new Map([['youtube', 1]]),
                fetchSource: async () => ({ items: ids.map(contentId => ({ contentId, url: `https://www.youtube.com/watch?v=${contentId}` })), state: {} }) });
        };
        assert.equal((await run(start, ['old'])).status, 'seeded');
        assert.equal((await policy.get(A)).intervalMinutes, null);
        await policy.set(A, 5, ADMIN, start);
        const rows = await db.queryDatabase('SELECT * FROM users WHERE user_id=?', [A]);
        assert.equal(Number(rows[0].is_donor), 1); assert.equal(Number(rows[0].additional_auto_extract_slots), 9);
        const at5 = start + 300000;
        assert.equal((await run(at5, ['new1', 'old'])).newItemCount, 1);
        const deliveries = await db.queryDatabase('SELECT t.user_id,d.next_attempt_at_ms FROM auto_watch_deliveries d JOIN auto_watch_targets t ON t.id=d.target_id ORDER BY t.user_id');
        assert.deepEqual(deliveries.map(row => [row.user_id, Number(row.next_attempt_at_ms)]), [[A, at5], [B, start + 1800000]]);
        assert.equal(Number((await db.queryDatabase('SELECT next_check_at_ms FROM auto_watch_sources'))[0].next_check_at_ms), start + 600000);
        const before30 = await store.claimDueDeliveries(at5, 32);
        assert.deepEqual(before30.map(row => String(row.target_id)), [first.id]);
        await db.queryDatabase('UPDATE auto_watch_targets SET enabled=0 WHERE id=?', [first.id]);
        await run(start + 900000, ['new1', 'old']);
        assert.equal(Number((await db.queryDatabase('SELECT next_check_at_ms FROM auto_watch_sources'))[0].next_check_at_ms), start + 2700000);
        await db.queryDatabase('UPDATE auto_watch_targets SET last_notification_window_at_ms=? WHERE id=?', [start + 1800000, second.id]);
        await run(start + 2700000, ['new2', 'new1', 'old']);
        const later = await db.queryDatabase("SELECT d.next_attempt_at_ms FROM auto_watch_deliveries d JOIN auto_watch_items i ON i.id=d.item_id WHERE d.target_id=? AND i.content_key='new2'", [second.id]);
        assert.equal(Number(later[0].next_attempt_at_ms), start + 3600000);
        await policy.set(A, null, ADMIN, start + 2700000);
        assert.equal((await policy.get(A)).intervalMinutes, null);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_user_interval_audits'))[0].n), 2);
        const failing = createPolicy({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            if (sql.startsWith('INSERT INTO auto_watch_user_interval_audits')) throw new Error('fixture audit failure');
            return query(sql, params);
        })) });
        await assert.rejects(failing.set(A, 10, ADMIN), /fixture audit failure/);
        assert.equal((await policy.get(A)).intervalMinutes, null);
    } finally { binding.queryDatabase = originalQuery; binding.withDatabaseTransaction = originalTransaction; binding.ensureUserExistsInDatabase = originalEnsureUser; await db.close(); }
});

test('admin interval API rejects ordinary members and cross-origin writes before looking up or changing policies', async () => {
    let administrator = false, reads = 0, writes = 0;
    const route = load('app/api/admin/auto-watch-intervals/route.ts', {
        '@/lib/api': { requireAdminSession: async () => { if (!administrator) throw { status: 403 }; return { user: { id: ADMIN } }; }, json: (body, status = 200) => new Response(JSON.stringify(body), { status }) },
        '@/lib/bot-require': { requireBotModule: () => ({ createPolicy: () => ({ get: async () => { reads++; return {}; }, set: async (_id, minutes, actor) => { writes++; assert.equal(actor, ADMIN); return { intervalMinutes: minutes }; } }) }) },
    });
    const request = (method, body, origin = 'https://local.test') => {
        const req = new Request('https://local.test/api/admin/auto-watch-intervals?userId=' + A, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }); req.nextUrl = new URL(req.url); return req;
    };
    assert.equal((await route.GET(request('GET'))).status, 403);
    assert.equal((await route.PATCH(request('PATCH', { userId: A, intervalMinutes: 5 }))).status, 403);
    assert.equal(reads + writes, 0);
    administrator = true;
    assert.equal((await route.PATCH(request('PATCH', { userId: A, intervalMinutes: 5 }, 'https://other.test'))).status, 403);
    assert.equal((await route.PATCH(request('PATCH', { userId: A, intervalMinutes: 5, is_donor: true }))).status, 400);
    assert.equal(writes, 0);
    const saved = await route.PATCH(request('PATCH', { userId: A, intervalMinutes: 5 }));
    assert.equal(saved.status, 200); assert.equal(writes, 1); assert.equal(saved.headers.get('cache-control'), 'private, no-store');
});
