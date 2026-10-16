'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const { createQueue } = require('../../src/automation/queue');
const { createRunner } = require('../../src/automation/runtime');
const { createTransport } = require('../../src/automation/transport');
const { resolveNotificationEntitlement } = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), U = '222222222222222222', C = '333333333333333333', G = '111111111111111111', M = '444444444444444444';
const client = { options: { jsonTransformer: value => value } };
async function fixture(work, webhook = false) {
    const db = await createTestDatabase(port);
    try {
        let now = Date.now(); const query = db.queryDatabase;
        await query('INSERT INTO users (user_id,registered_at_ms) VALUES (?,0)', [U]);
        let endpoint = null;
        if (webhook) { const url = `https://discord.com/api/webhooks/${M}/${'a'.repeat(60)}`; endpoint = (await query('INSERT INTO webhook_endpoints (webhook_url,webhook_url_hash) VALUES (?,?)', [url, createHash('sha256').update(url).digest('hex')])).insertId; }
        const source = await query('INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES (?,?,?,?,?,?,?)', ['steam', '730', 'https://store.steampowered.com/app/730', 'ja', 60000, now, now]);
        const target = await query('INSERT INTO price_watch_targets (source_id,user_id,destination_type,destination_key,webhook_endpoint_id,guild_id,origin_channel_id,watch_mode,rule_key,enabled,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,1,?)', [source.insertId, U, webhook ? 'webhook' : 'dm', webhook ? `webhook:${endpoint}` : `dm:${U}`, endpoint, webhook ? G : null, webhook ? C : null, 'change', 'a'.repeat(64), now]);
        const token = randomUUID(), event = { providerId: 'steam', kind: 'price', title: 'observed price', url: 'https://store.steampowered.com/app/730', observedAtMs: now };
        const delivery = await query("INSERT INTO price_watch_deliveries (target_id,event_key,message_text,event_json,status,next_attempt_at_ms,lease_token,lease_expires_at_ms) VALUES (?,?,?,?,'pending',?,?,?)", [target.insertId, 'b'.repeat(64), 'price fixture', JSON.stringify(event), now, token, now + 60000]);
        const queue = createQueue(db, {}, { clock: () => now });
        await queue.route('price', { id: String(delivery.insertId), target_id: String(target.insertId), lease_token: token, event_json: JSON.stringify(event), message_text: 'price fixture' }, now);
        const row = (await query('SELECT id,plan_json FROM automation_jobs'))[0], plan = JSON.parse(row.plan_json);
        plan.defaultPriceText = null; plan.text = 'x'.repeat(3801); plan.display = { format: 'text', media: 'inherit' };
        await query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(plan), row.id]);
        await work({ db, query, queue, targetId: String(target.insertId), get now() { return now; }, set now(value) { now = value; } });
    } finally { await db.close(); }
}
test('N5 per-part permission revocation preserves partial ACK and refunds only unsent parts', { skip: !port }, async () => fixture(async f => {
    let messages = 0, verifications = 0;
    const destinations = { verifyChannel: async () => { verifications++; if (messages) throw Object.assign(new Error('private permission detail'), { status: 403 }); return { channel: { id: C, nsfw: false }, member: { roles: [] } }; } };
    const rest = { get: async () => ({ channel_id: C, guild_id: G, type: 1 }), post: async () => { messages++; return { id: M, channel_id: C }; } };
    const transport = createTransport(f.db, destinations, client, { rest, clock: () => f.now });
    const result = await createRunner(f.db, f.queue, transport, { clock: () => f.now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { f.now += ms; } }).tick();
    assert.equal(result.state, 'partial'); assert.equal(messages, 1); assert.equal(verifications, 3);
    const job = (await f.query('SELECT state,sent_steps FROM automation_jobs'))[0]; assert.equal(job.state, 'partial'); assert.equal(Number(job.sent_steps), 1);
    const usage = await createRateLimiter(f.db, { clock: () => f.now }).getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 0);
}, true));
test('N5 transient authorization read before the first wire submission returns pending with no false unknown', { skip: !port }, async () => fixture(async f => {
    let verified = 0, sent = 0;
    const destinations = { verifyChannel: async () => { if (++verified > 1) throw Object.assign(new Error('private upstream detail'), { status: 503 }); return { channel: { id: C }, member: { roles: [] } }; } };
    const rest = { get: async () => ({ channel_id: C, guild_id: G, type: 1 }), post: async () => { sent++; return { id: M, channel_id: C }; } };
    const transport = createTransport(f.db, destinations, client, { rest, clock: () => f.now });
    const result = await createRunner(f.db, f.queue, transport, { clock: () => f.now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { f.now += ms; } }).tick();
    assert.equal(result.state, 'pending'); assert.equal(result.code, 'AUTOMATION_PERMISSION_CHECK_UNAVAILABLE'); assert.equal(sent, 0);
    assert.equal((await createRateLimiter(f.db, { clock: () => f.now }).getSlotUsage(`${U}:1`)).todayReserved, 0);
}, true));
test('N5 direct transport callers also recheck permission before every physical part', { skip: !port }, async () => fixture(async f => {
    let sent = 0;
    const destinations = { verifyChannel: async () => { if (sent) throw Object.assign(new Error('revoked'), { status: 403 }); return { channel: { id: C }, member: { roles: [] } }; } };
    const rest = { get: async () => ({ channel_id: C, guild_id: G, type: 1 }), post: async () => { sent++; return { id: M, channel_id: C }; } };
    const transport = createTransport(f.db, destinations, client, { rest, clock: () => f.now }), job = await f.queue.claim(f.now);
    const prepared = await transport.prepare(job, (await f.queue.check(job, f.now)).destination);
    await transport.sendStep(prepared, job, 0);
    await assert.rejects(transport.sendStep(prepared, job, 1), { code: 'SAFETY_DESTINATION_PERMISSION_DENIED' });
    assert.equal(sent, 1);
    const usage = await createRateLimiter(f.db, { clock: () => f.now }).getSlotUsage(`${U}:1`); assert.equal(usage.todayUsed, 1); assert.equal(usage.todayReserved, 0);
}, true));
test('N5 fresh NSFW status is inspected before each part and valid unchanged permission sends all parts', { skip: !port }, async () => {
    for (const change of [true, false]) await fixture(async f => {
        let sent = 0, checks = 0;
        const destinations = { verifyChannel: async () => ({ channel: { id: C, nsfw: change && sent > 0 }, member: { roles: [] } }) };
        const rest = { get: async () => ({ channel_id: C, guild_id: G, type: 1 }), post: async () => { sent++; return { id: M, channel_id: C }; } };
        const transport = createTransport(f.db, destinations, client, { rest, clock: () => f.now, safety: { assertNotification: async prepared => { checks++; if (prepared.channelNsfw) throw new (require('../../src/automation/safety').SafetyError)('SAFETY_NSFW_CHANNEL'); } } });
        const result = await createRunner(f.db, f.queue, transport, { clock: () => f.now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { f.now += ms; } }).tick();
        assert.equal(result.state, change ? 'partial' : 'sent'); assert.equal(sent, change ? 1 : 3); assert.equal(checks, change ? 2 : 3);
    }, true);
});
test('N7 observed normal price notification reaches the ordinary expansion handler once while direct output is guarded', { skip: !port }, async () => {
    for (const format of ['normal', 'text']) await fixture(async f => {
        const saved = (await f.query('SELECT id,plan_json FROM automation_jobs'))[0], plan = JSON.parse(saved.plan_json);
        plan.display.format = format; plan.defaultPriceText = '観測価格 900円\nhttps://store.steampowered.com/app/730';
        await f.query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(plan), saved.id]);
        let body, sent = 0;
        const destinations = { verifyChannel: async () => ({ channel: { id: C }, member: { roles: [] } }) };
        const rest = { get: async () => ({ channel_id: C, guild_id: G, type: 1 }), post: async (_route, payload) => { body = payload.body; sent++; return { id: M, channel_id: C }; } };
        const transport = createTransport(f.db, destinations, client, { rest, clock: () => f.now });
        assert.equal((await createRunner(f.db, f.queue, transport, { clock: () => f.now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { f.now += ms; } }).tick()).state, 'sent');
        assert.equal(sent, 1); assert.equal(body.content, plan.defaultPriceText);
        assert.equal(await require('../../src/automation/outbound-guard').shouldIgnore({ id: M, webhookId: M, channelId: C, content: body.content }), format !== 'normal');
    }, true);
});
test('N4 durable reservation recovery refunds only reserved parts of expired attempt generations', { skip: !port }, async () => fixture(async f => {
    const job = await f.queue.claim(f.now), principal = { ...await resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'price', targetId: f.targetId }), ownerUserId: U };
    const quota = createRateLimiter(f.db, { clock: () => f.now }), reservation = await quota.reserveNotifications(principal, 4, job);
    await quota.beginNotification(reservation, 0); await quota.commitNotification(reservation, 0);
    await quota.beginNotification(reservation, 1); await quota.retainUnknownNotification(reservation, 1);
    await quota.beginNotification(reservation, 2);
    assert.equal(await quota.recoverOrphanedReservations(), 0);
    f.now = Number(job.lease_until_ms) + 1;
    await Promise.all([quota.recoverOrphanedReservations(), createRateLimiter(f.db, { clock: () => f.now }).recoverOrphanedReservations()]);
    const parts = JSON.parse((await f.query('SELECT parts_json FROM automation_rate_reservations WHERE id=?', [reservation.id]))[0].parts_json);
    assert.deepEqual(parts, ['committed', 'unknown', 'submitting', 'released']);
    assert.deepEqual((await f.query('SELECT used_count FROM automation_counters WHERE counter_key IN (?)', [JSON.parse((await f.query('SELECT counters_json FROM automation_rate_reservations WHERE id=?', [reservation.id]))[0].counters_json).map(item => item.key)])).map(row => Number(row.used_count)), [3, 3]);
    await assert.rejects(quota.beginNotification(reservation, 3), { code: 'AUTOMATION_RATE_LIMIT_UNAVAILABLE' });
}));
test('N4 recovery rollback, live lease fencing, legacy holds and repeated migration preserve accounting', { skip: !port }, async () => fixture(async f => {
    const fs = require('node:fs'), path = require('node:path');
    const { splitSqlStatements, shouldSkipMigrationStatement } = require('../../src/db_schema')._internal;
    const statements = splitSqlStatements(fs.readFileSync(path.join(__dirname, '../../migrations/20261016_bind_automation_rate_reservations.sql'), 'utf8'));
    assert.equal(statements.length, 2);
    for (let pass = 0; pass < 2; pass++) for (const sql of statements) if (!await shouldSkipMigrationStatement(f.query, sql)) await f.query(sql);
    const job = await f.queue.claim(f.now), principal = { ...await resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'price', targetId: f.targetId }), ownerUserId: U };
    const quota = createRateLimiter(f.db, { clock: () => f.now });
    const legacy = await quota.reserveNotifications(principal, 1), linked = await quota.reserveNotifications(principal, 1, job);
    assert.equal(await quota.recoverOrphanedReservations(), 0);
    f.now = Number(job.lease_until_ms) + 1;
    const broken = { ...f.db, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => { if (sql.startsWith('UPDATE automation_rate_reservations SET parts_json')) throw new Error('private SQL failure'); return query(sql, params); })) };
    await assert.rejects(createRateLimiter(broken, { clock: () => f.now }).recoverOrphanedReservations(), { code: 'AUTOMATION_RATE_LIMIT_UNAVAILABLE' });
    assert.equal(JSON.parse((await f.query('SELECT parts_json FROM automation_rate_reservations WHERE id=?', [linked.id]))[0].parts_json)[0], 'reserved');
    await quota.recoverOrphanedReservations(); await quota.recoverOrphanedReservations();
    assert.equal(JSON.parse((await f.query('SELECT parts_json FROM automation_rate_reservations WHERE id=?', [legacy.id]))[0].parts_json)[0], 'reserved');
    assert.equal(JSON.parse((await f.query('SELECT parts_json FROM automation_rate_reservations WHERE id=?', [linked.id]))[0].parts_json)[0], 'released');
}));
test('T4 authoritative frozen dictionaries cover existing empty plans and preserve valid native controls', async () => {
    const { assertPackageSafety } = require('../../src/automation/package-safety');
    let revoked = false, revisionReads = 0;
    const query = async (sql, params) => {
        if (sql.includes('SELECT bindings_json FROM automation_revisions')) { revisionReads++; return [{ bindings_json: JSON.stringify({ dictionaries: { words: { id: 'pinned-dictionary', revision: 3 } } }) }]; }
        if (sql.includes('automation_dictionary_revisions')) { assert.deepEqual(params, ['pinned-dictionary', 3]); return revoked ? [{}] : []; }
        return [];
    };
    for (const dictionaryRefs of [{}, undefined, { words: { id: 'pinned-dictionary', revision: 3 } }]) {
        const job = { workflow_id: 'workflow', revision: 2, plan: { dictionaryRefs } };
        revoked = false; await assertPackageSafety(query, job); revoked = true;
        await assert.rejects(assertPackageSafety(query, job), { code: 'SAFETY_DICTIONARY_REVOKED' });
    }
    assert.equal(revisionReads, 6);
    await assertPackageSafety(async () => [], { workflow_id: null, plan: { dictionaryRefs: {} } });
    await assertPackageSafety(async sql => sql.includes('SELECT bindings_json') ? [{ bindings_json: '{}' }] : [], { workflow_id: 'no-dictionaries', revision: 1, plan: { dictionaryRefs: {} } });
});
// This child receives only a disposable test schema and a clock. It exits at
// the real runner's post-reservation/pre-beginSend boundary, without sending.
const crashChild = String.raw`
const mysql=require('mysql'),{AsyncLocalStorage}=require('node:async_hooks');
const schema=process.argv[1],now=Number(process.argv[2]); if(!/^cbte_automation_test_[0-9a-f]{20}$/.test(schema)) throw Error('Unsafe schema');
const connection=mysql.createConnection({host:'127.0.0.1',port:Number(process.env.AUTOMATION_TEST_DB_PORT),user:'root',password:process.env.AUTOMATION_TEST_DB_PASSWORD||'',database:schema,supportBigNumbers:true,bigNumberStrings:true});
const ctx=new AsyncLocalStorage(),q=(sql,p=[])=>new Promise((yes,no)=>connection.query(sql,p,(e,r)=>e?no(e):yes(r)));
const db={queryDatabase:q,withDatabaseTransaction:async work=>{if(ctx.getStore())return work(q);await q('START TRANSACTION');try{const result=await ctx.run(true,()=>work(q));await q('COMMIT');return result;}catch(e){await q('ROLLBACK');throw e;}}};
const queue=require('./src/automation/queue').createQueue(db,{}, {clock:()=>now});
const transport=require('./src/automation/transport').createTransport(db,{}, {options:{jsonTransformer:x=>x}}, {clock:()=>now,rest:{post:async route=>{if(route==='/users/@me/channels')return{id:'333333333333333333'};throw Error('Must not submit');}}});
const reserve=transport.reserve;transport.reserve=async(p,j)=>{await reserve(p,j);process.exit(41);};
require('./src/automation/runtime').createRunner(db,queue,transport,{clock:()=>now,assertAllowed:()=>{},notificationAllowed:()=>true}).tick().catch(()=>process.exit(42));
`;
test('N4 actual process exit after quota reservation recovers last daily slot after restart', { skip: !port }, async () => fixture(async f => {
    const principal = { ...await resolveNotificationEntitlement(f.db, { ownerUserId: U, targetKind: 'price', targetId: f.targetId }), ownerUserId: U };
    let seedAt = f.now - 20 * 60000; const seed = createRateLimiter(f.db, { clock: () => seedAt });
    for (let used = 0; used < principal.dayLimit - 1;) { const count = Math.min(principal.minuteLimit, principal.dayLimit - 1 - used), hold = await seed.reserveNotifications(principal, count); for (let part = 0; part < count; part++) await seed.commitNotification(hold, part); used += count; seedAt += 60001; }
    const job = (await f.query('SELECT id,plan_json FROM automation_jobs'))[0], plan = JSON.parse(job.plan_json); plan.text = 'single remaining part'; await f.query('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(plan), job.id]);
    const child = spawnSync(process.execPath, ['-e', crashChild, f.db.schema, String(f.now)], { cwd: require('node:path').resolve(__dirname, '../..'), encoding: 'utf8', timeout: 20000 }); assert.equal(child.status, 41, child.stderr);
    const stopped = (await f.query('SELECT state,lease_until_ms,sent_steps FROM automation_jobs WHERE id=?', [job.id]))[0]; assert.equal(stopped.state, 'leased'); assert.equal(Number(stopped.sent_steps), 0); f.now = Number(stopped.lease_until_ms) + 1;
    let sends = 0; const transport = createTransport(f.db, {}, client, { clock: () => f.now, rest: { post: async route => route === '/users/@me/channels' ? { id: C } : (sends++, { id: M, channel_id: C }) } });
    const result = await createRunner(f.db, f.queue, transport, { clock: () => f.now, assertAllowed: () => {}, notificationAllowed: () => true, sleep: async ms => { f.now += ms; } }).tick();
    assert.equal(result.state, 'sent'); assert.equal(sends, 1); assert.equal((await createRateLimiter(f.db, { clock: () => f.now }).getSlotUsage(principal.slotId)).todayUsed, principal.dayLimit);
}));
