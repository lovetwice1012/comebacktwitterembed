'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const handlerPath = require.resolve('../../src/commands/handlers/autoextract/checkfreeslot');
const dbPath = require.resolve('../../src/db');
const squarePath = require.resolve('../../src/automation/square-billing');
const donationsPath = require.resolve('../../src/automation/square-donations');
const U = '222222222222222222';

async function run({ tier = 'free', used = 0, limit = 5, locale = 'ja', manualDonor = false, ownRow = true, permanentSlots = 0 } = {}) {
    const paths = [dbPath, squarePath, handlerPath, donationsPath], originals = paths.map(path => require.cache[path]), calls = [];
    const policy = { plan_id: tier === 'paid' ? 'pro' : tier, label: { free: '無料', supporter: '支援者', paid: 'Pro' }[tier], slot_limit: limit, minute_limit: tier === 'free' ? 5 : 12, day_limit: tier === 'free' ? 24 : 100, priority: tier === 'free' ? 0 : 3, enabled: 1, updated_at_ms: 1 };
    const slots = Array.from({ length: used }, (_, i) => ({ slot_index: i + 1, target_kind: i % 2 ? 'price' : 'auto', target_id: String(i + 1) }));
    const queryDatabase = async (sql, params) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT is_donor,additional_auto_extract_slots')) return ownRow ? [{ is_donor: manualDonor ? 1 : 0, additional_auto_extract_slots: 0 }] : [];
        if (sql.includes('FROM automation_notification_entitlements e')) return tier === 'paid' ? [policy] : [];
        if (sql.includes('FROM automation_square_subscriptions s')) return [];
        if (sql.includes('FROM automation_square_donation_policy p')) return [{ currency: 'JPY', supporter_threshold: 1000, validity_days: null, unit_amount: null, slots_per_unit: null, updated_at_ms: 1 }];
        if (sql.includes('FROM automation_square_donation_attempts')) return tier === 'supporter' && !manualDonor ? [{ amount: 1000, refunded_amount: 0, completed_at_ms: 1 }] : [];
        if (sql.includes('FROM automation_push_support_scope_snapshots') || sql.includes('FROM automation_square_donation_unit_grants')
            || sql.includes('FROM automation_push_support_owner_snapshots')) return [];
        if (sql.includes('FROM automation_push_support_grants')) {
            assert.equal(params[0], U);
            return sql.startsWith('SELECT COALESCE(SUM(') ? [{ new_paid_slots: permanentSlots, historical_slots: 0 }] : [];
        }
        if (sql.includes('FROM automation_notification_boost_slots')) return [];
        if (sql.startsWith('SELECT * FROM automation_notification_plans')) return tier === 'paid' ? [] : [policy];
        if (sql.startsWith('SELECT * FROM automation_notification_slots')) return slots.map(slot => ({ ...slot }));
        if (sql.startsWith("SELECT 'auto' AS target_kind")) {
            assert.doesNotMatch(sql, /enabled\s*=\s*1/);
            return slots.map(slot => ({ target_kind: slot.target_kind, target_id: slot.target_id, created_at_ms: 0, enabled: 0 }));
        }
        if (sql.startsWith("SELECT 'x' AS target_kind")) return [];
        if (sql.startsWith('INSERT INTO users')) return { affectedRows: 1 };
        if (sql.startsWith('SELECT user_id')) return [{ user_id: U }];
        throw new Error(`Unexpected command SQL: ${sql}`);
    };
    const db = { queryDatabase, withDatabaseTransaction: async work => { calls.push({ transaction: true }); return work(queryDatabase); } };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    require.cache[squarePath] = { id: squarePath, filename: squarePath, loaded: true, exports: { getSquareScope: () => ({ configured: true, environment: 'sandbox', merchantId: 'MERCHANT' }) } };
    delete require.cache[handlerPath];
    delete require.cache[donationsPath];
    let reply;
    try {
        await require(handlerPath)({ user: { id: U }, locale, editReply: async payload => { reply = payload; } });
        return { reply, calls };
    } finally {
        paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; });
    }
}

test('checkfreeslot admits a missing users record as free and reports personal default capacity and physical-message limits', async () => {
    const { reply, calls } = await run({ ownRow: false });
    assert.equal(reply.embeds[0].title, '通知枠の利用状況');
    assert.match(reply.embeds[0].description, /利用プラン: 無料/); assert.match(reply.embeds[0].description, /0\/5枠（空き 5枠）/);
    assert.match(reply.embeds[0].description, /1日24通・1分5通/); assert.match(reply.embeds[0].description, /1メッセージ/); assert.match(reply.embeds[0].description, /日本時間0時/);
    assert.doesNotMatch(reply.embeds[0].description, /寄付者限定|登録が必要|175/); assert.ok(calls.some(call => call.transaction));
});
test('checkfreeslot counts both auto and price paused registrations in one free allowance', async () => {
    const { reply } = await run({ used: 5 });
    assert.match(reply.embeds[0].description, /5\/5枠（空き 0枠）/); assert.match(reply.embeds[0].description, /新着 3件・価格 2件/); assert.match(reply.embeds[0].description, /一時停止中の登録も/);
});
test('checkfreeslot recognizes a verified Square donation supporter without changing the manual donor flag', async () => {
    const { reply, calls } = await run({ tier: 'supporter', used: 6, limit: 8, manualDonor: false });
    assert.match(reply.embeds[0].description, /利用プラン: 支援者/); assert.match(reply.embeds[0].description, /6\/8枠（空き 2枠）/); assert.match(reply.embeds[0].description, /1日100通・1分12通/); assert.match(reply.embeds[0].description, /優先度: 3/);
    assert.match(reply.embeds[0].description, /決済1回・0口・追加0枠/);
    assert.ok(calls.some(call => call.sql?.includes('FROM automation_square_donation_attempts'))); assert.ok(!calls.some(call => call.sql?.startsWith('UPDATE users')));
});
test('checkfreeslot uses the effective paid policy and gives safe downgrade guidance in English', async () => {
    const { reply } = await run({ tier: 'paid', used: 4, limit: 3, locale: 'en' });
    assert.equal(reply.embeds[0].title, 'Notification slot usage'); assert.match(reply.embeds[0].description, /Your plan: Pro/);
    assert.match(reply.embeds[0].description, /4\/3 \(0 available\)/); assert.match(reply.embeds[0].description, /100 messages\/day; 12 messages\/minute/);
    assert.match(reply.embeds[0].description, /1 registration above your allowance cannot send or resume/); assert.match(reply.embeds[0].description, /pause or delete/); assert.doesNotMatch(reply.embeds[0].description, /donors only|175/);
});

test('checkfreeslot includes permanent supporter grants in the shared personal allowance', async () => {
    const { reply, calls } = await run({ used: 5, permanentSlots: 3 });
    assert.match(reply.embeds[0].description, /5\/8枠（空き 3枠）/);
    assert.ok(calls.some(call => call.sql?.includes('FROM automation_push_support_grants')));
    assert.ok(!calls.some(call => /^(?:UPDATE|DELETE|INSERT INTO automation_push_support)/.test(call.sql || '')));
});
