'use strict';
// Real disposable SQL and actual Discord permission evaluation with local REST responses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createDestinations, VIEW, SEND } = require('../../src/automation/destinations');
const { createQueue, targetIdentity } = require('../../src/automation/queue');
const entitlements = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw Error('Destination lifecycle SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const U = '225111111111111111', V = '225222222222222222', G = '115111111111111111', C = '335111111111111111', BOT = '445111111111111111';
const owner = { userId: U }, ownerGuild = { userId: U, guildId: G, canView: true, canEdit: true }, editor = { userId: V, guildId: G, canView: true, canEdit: true };
const ADMIN = { userId: '445222222222222222', isAdmin: true };
const table = kind => kind === 'auto' ? 'auto_watch' : 'price_watch';

test('native monitor destinations preserve ownership, verify both delivery principals and fence passive resumes', { timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase; t.after(() => db.close());
    for (const user of [U, V]) await query('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1)', [user]);
    await db.withDatabaseTransaction(async q => { for (const planId of ['free', 'supporter']) await entitlements.savePlanPolicy(q, ADMIN, { planId, label: planId, slotLimit: 1000, minuteLimit: 5, dayLimit: 100, priority: 1, intervalMinutes: 5 }); });
    const service = createService(db, { rateLimiter: { consumeOperation: async () => {} } });
    const access = new Map([[U, true], [V, true]]), viewDenied = new Set(), calls = []; let hook = null, transient = false;
    const rest = async route => {
        calls.push(route);
        if (transient) throw Object.assign(new Error('synthetic private network details'), { status: 502 });
        if (route === `/guilds/${G}`) return { data: { id: G, owner_id: '995111111111111111' } };
        if (route === `/guilds/${G}/roles`) return { data: [{ id: G, permissions: String(VIEW) }, { id: 'sender', permissions: String(SEND) }] };
        if (route.startsWith(`/guilds/${G}/members/`)) {
            const userId = route.split('/').at(-1); if (hook) { const next = hook; hook = null; await next(userId); }
            return { data: { user: { id: userId }, roles: access.get(userId) ? ['sender'] : [] } };
        }
        if (route === '/users/@me') return { data: { id: BOT } };
        if (route === `/channels/${C}`) return { data: { id: C, guild_id: G, type: 0, permission_overwrites: [...viewDenied].map(id => ({ id, type: 1, deny: String(VIEW), allow: '0' })), nsfw: false } };
        if (route.startsWith('/webhooks/555111111111111111/')) return { data: { id: '555111111111111111', type: 1, guild_id: G, channel_id: C } };
        assert.fail(route);
    };
    const destinations = createDestinations(db, service, { rest }), monitors = createMonitors(db, service, destinations);
    async function destination(scope = 'private', kind = 'webhook', who = ownerGuild) {
        if (kind === 'dm') return (await service.saveDestination(who, { name: 'Synthetic DM', kind, scope: 'private' })).id;
        const url = `https://discord.com/api/webhooks/555111111111111111/synthetic_${randomUUID().replaceAll('-', '')}`;
        const endpoint = await query('INSERT INTO webhook_endpoints (webhook_url_hash,webhook_url) VALUES (?,?)', [hash(url), url]);
        return (await service.saveDestination(who, { name: 'Synthetic channel', kind: 'webhook', scope }, { webhookEndpointId: String(endpoint.insertId), guildId: G, channelId: C })).id;
    }
    async function fixture(kind, scope = 'private', destId = null, who = ownerGuild) {
        const id = destId || await destination(scope), unique = randomUUID().replaceAll('-', '');
        const input = { name: 'Synthetic monitor', scope, destinationId: id, providerId: kind === 'auto' ? 'github' : 'steam', source: kind === 'auto' ? `user${unique.slice(0, 12)}` : `https://store.steampowered.com/app/${100000 + Math.floor(Math.random() * 100000000)}/`, ...(kind === 'price' ? { mode: 'change' } : {}) };
        const saved = await monitors.save(who, kind, input); return { ...saved, kind, destinationId: id, input };
    }
    const state = async f => ({ target: (await query(`SELECT * FROM ${table(f.kind)}_targets WHERE id=?`, [f.id]))[0], monitor: (await query('SELECT * FROM automation_monitors WHERE target_kind=? AND target_id=?', [f.kind, f.id]))[0], slots: await query('SELECT * FROM automation_notification_slots WHERE owner_user_id=? ORDER BY slot_index', [U]) });
    const pause = f => monitors.save(owner, f.kind, { enabled: false, expectedRevision: f.revision }, f.id);
    async function paused(kind, destinationKind = 'webhook') {
        const f = await fixture(kind, 'private', await destination('private', destinationKind)); const saved = await pause(f); return { ...f, revision: saved.revision };
    }
    for (const kind of ['auto', 'price']) {
        await t.test(`${kind} S4-5: owner edits a private channel monitor from the personal page using only the stored guild`, async () => {
            const f = await fixture(kind); calls.length = 0;
            const saved = await monitors.save(owner, kind, { expectedRevision: f.revision, locale: 'en-US', name: 'Edited from personal route', guildId: '999111111111111111' }, f.id);
            assert.equal(saved.revision, 2); const result = await state(f); assert.equal(result.target.guild_id, G); assert.equal(result.monitor.destination_id, f.destinationId);
            assert(calls.includes(`/guilds/${G}/members/${U}`)); assert(calls.every(route => !route.includes('999111111111111111')));
            await assert.rejects(monitors.save({ userId: V, guildId: G, canEdit: true, canView: true }, kind, { expectedRevision: 2, locale: 'ja' }, f.id), { code: 'NOT_FOUND' });
        });
        await t.test(`${kind} S24-1: guild edits validate both editor and original owner with actual role permissions`, async () => {
            const f = await fixture(kind, 'guild'); calls.length = 0; access.set(U, false);
            try {
                await assert.rejects(monitors.save(editor, kind, { expectedRevision: f.revision, locale: 'en-US' }, f.id), { code: 'CHANNEL_PERMISSION', status: 403 });
                assert.equal((await state(f)).monitor.revision, f.revision); assert(calls.includes(`/guilds/${G}/members/${V}`)); assert(calls.includes(`/guilds/${G}/members/${U}`));
            } finally { access.set(U, true); }
            calls.length = 0; const saved = await monitors.save(editor, kind, { expectedRevision: f.revision, locale: 'en-US' }, f.id); assert.equal(saved.revision, 2);
            assert(calls.includes(`/guilds/${G}/members/${V}`)); assert(calls.includes(`/guilds/${G}/members/${U}`)); assert.equal((await state(f)).target.user_id, U);
            await assert.rejects(monitors.save({ ...editor, guildId: '115222222222222222' }, kind, { expectedRevision: 2, locale: 'ja' }, f.id), { code: 'FORBIDDEN' });
        });
        await t.test(`${kind} S24-1: passive guild resume also checks the editor and original owner before changing state`, async () => {
            const f = await fixture(kind, 'guild'); await monitors.save(editor, kind, { enabled: false, expectedRevision: 1 }, f.id);
            const before = await state(f); access.set(U, false);
            try { await assert.rejects(monitors.save(editor, kind, { enabled: true, expectedRevision: 2 }, f.id), { code: 'CHANNEL_PERMISSION' }); } finally { access.set(U, true); }
            assert.deepEqual(await state(f), before); viewDenied.add(U);
            try { await assert.rejects(monitors.save(editor, kind, { enabled: true, expectedRevision: 2 }, f.id), { code: 'CHANNEL_PERMISSION' }); } finally { viewDenied.delete(U); }
            assert.deepEqual(await state(f), before); access.set(V, false);
            try { await assert.rejects(monitors.save(editor, kind, { enabled: true, expectedRevision: 2 }, f.id), { code: 'CHANNEL_PERMISSION' }); } finally { access.set(V, true); }
            assert.deepEqual(await state(f), before); assert.equal((await monitors.save(editor, kind, { enabled: true, expectedRevision: 2 }, f.id)).revision, 3);
            assert.equal((await state(f)).target.user_id, U);
        });
        for (const resourceState of ['disabled', 'deleted', 'foreign']) await t.test(`${kind} S18-1: ${resourceState} destination cannot resume; pause and delete remain available`, async () => {
            const f = await paused(kind); const before = await state(f);
            if (resourceState === 'disabled') await query('UPDATE automation_destinations SET enabled=0,revision=revision+1 WHERE id=?', [f.destinationId]);
            if (resourceState === 'deleted') await query('UPDATE automation_destinations SET deleted_at_ms=1,revision=revision+1 WHERE id=?', [f.destinationId]);
            if (resourceState === 'foreign') await query('UPDATE automation_destinations SET owner_user_id=?,revision=revision+1 WHERE id=?', [V, f.destinationId]);
            await assert.rejects(monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id), error => ['DESTINATION_DISABLED', 'NOT_FOUND'].includes(error.code));
            assert.deepEqual(await state(f), before);
            const stopped = await monitors.save(owner, kind, { enabled: false, expectedRevision: f.revision }, f.id); assert.equal(stopped.revision, 3);
            await monitors.remove(owner, kind, f.id, stopped.revision); assert.equal((await state(f)).target, undefined);
        });
        await t.test(`${kind} S18-1: healthy DM resumes and preserves its destination and owner`, async () => {
            const f = await paused(kind, 'dm'); calls.length = 0;
            const saved = await monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id); const after = await state(f);
            assert.equal(saved.revision, 3); assert.equal(after.target.enabled, 1); assert.equal(after.monitor.destination_id, f.destinationId); assert.equal(after.target.user_id, U); assert.equal(calls.length, 0);
        });
        await t.test(`${kind} S18-1: destination change after remote verification fails before enabled or slots change`, async () => {
            const f = await paused(kind), before = await state(f);
            hook = async () => query('UPDATE automation_destinations SET enabled=0,revision=revision+1 WHERE id=?', [f.destinationId]);
            await assert.rejects(monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id), { code: 'DESTINATION_CHANGED', status: 409 });
            assert.deepEqual(await state(f), before);
        });
        await t.test(`${kind} S18-1: a concurrent monitor revision and unknown Discord failure both retain the paused target`, async () => {
            const f = await paused(kind), before = await state(f); transient = true;
            try { await assert.rejects(monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id), { code: 'DISCORD_UNAVAILABLE', status: 503 }); } finally { transient = false; }
            assert.deepEqual(await state(f), before);
            hook = async () => query('UPDATE automation_monitors SET revision=revision+1 WHERE target_kind=? AND target_id=?', [kind, f.id]);
            await assert.rejects(monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id), { code: 'REVISION_CONFLICT', status: 409 });
            assert.equal((await state(f)).target.enabled, 0); assert.deepEqual((await state(f)).slots, before.slots);
        });
        await t.test(`${kind} S18-1: audit failure rolls the destination-validated resume back atomically`, async () => {
            const f = await paused(kind, 'dm'), before = await state(f), original = db.withDatabaseTransaction;
            db.withDatabaseTransaction = work => original(q => work((sql, params) => { if (sql.startsWith('INSERT INTO automation_audit')) throw Error('Synthetic resume audit failure'); return q(sql, params); }));
            try { await assert.rejects(monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id), /Synthetic resume audit failure/); } finally { db.withDatabaseTransaction = original; }
            assert.deepEqual(await state(f), before);
        });
        await t.test(`${kind} legacy DM and webhook targets resume without fabricating resources; a missing endpoint blocks the webhook`, async () => {
            for (const destinationKind of ['dm', 'webhook']) {
                const f = await paused(kind, destinationKind); await query('UPDATE automation_monitors SET destination_id=NULL WHERE target_kind=? AND target_id=?', [kind, f.id]);
                const saved = await monitors.save(owner, kind, { enabled: true, expectedRevision: f.revision }, f.id); assert.equal(saved.revision, 3); assert.equal((await state(f)).monitor.destination_id, null);
                if (destinationKind === 'webhook') {
                    await monitors.save(owner, kind, { enabled: false, expectedRevision: 3 }, f.id); await query(`UPDATE ${table(kind)}_targets SET webhook_endpoint_id=NULL WHERE id=?`, [f.id]);
                    const before = await state(f); await assert.rejects(monitors.save(owner, kind, { enabled: true, expectedRevision: 4 }, f.id), { code: 'DESTINATION_DELETED' }); assert.deepEqual(await state(f), before);
                }
            }
        });
        await t.test(`${kind} S4-5: personal edits and resume reuse only the owned monitor's unchanged shared destination`, async () => {
            const shared = await destination('guild'), f = await fixture(kind, 'private', shared);
            const another = await destination('guild'); calls.length = 0;
            const saved = await monitors.save(owner, kind, { expectedRevision: 1, locale: 'en-US' }, f.id);
            assert.equal(saved.revision, 2); assert.equal((await state(f)).monitor.destination_id, shared); assert(calls.includes(`/guilds/${G}/members/${U}`));
            await assert.rejects(monitors.save(owner, kind, { expectedRevision: 2, destinationId: another }, f.id), { code: 'FORBIDDEN' });
            await assert.rejects(monitors.save({ userId: V }, kind, { expectedRevision: 2, locale: 'ja' }, f.id), { code: 'NOT_FOUND' });
            // The use-only exception must not authorize editing the shared resource itself.
            await assert.rejects(service.saveDestination(owner, { name: 'Unauthorized resource rename', kind: 'webhook', scope: 'guild', expectedRevision: 1 }, { webhookEndpointId: '1', guildId: G, channelId: C }, shared), { code: 'FORBIDDEN' });
            await monitors.save(owner, kind, { expectedRevision: 2, enabled: false }, f.id); const before = await state(f);
            access.set(U, false);
            try { await assert.rejects(monitors.save(owner, kind, { expectedRevision: 3, enabled: true }, f.id), { code: 'CHANNEL_PERMISSION' }); } finally { access.set(U, true); }
            assert.deepEqual(await state(f), before);
            hook = () => query('UPDATE automation_destinations SET enabled=0,revision=revision+1 WHERE id=?', [shared]);
            await assert.rejects(monitors.save(owner, kind, { expectedRevision: 3, enabled: true }, f.id), { code: 'DESTINATION_CHANGED' }); assert.deepEqual(await state(f), before);
            await query('UPDATE automation_destinations SET enabled=1,revision=revision+1 WHERE id=?', [shared]);
            assert.equal((await monitors.save(owner, kind, { expectedRevision: 3, enabled: true }, f.id)).revision, 4); assert.equal((await state(f)).target.enabled, 1);
        });
        await t.test(`${kind}: working private monitors using a shared same-guild destination retain truthful active readiness and queue permission`, async () => {
            const f = await fixture(kind, 'private', await destination('guild'));
            const row = (await monitors.list(owner, kind)).items.find(item => item.id === f.id); assert.equal(row.destinationStatus, 'active');
            assert((await monitors.list(owner, kind, '0', { state: 'active' })).items.some(item => item.id === f.id));
            const runId = randomUUID(), id = randomUUID(), now = Date.now(), raw = (await state(f)).target;
            await query("INSERT INTO automation_runs(id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,'private',?,?,'{}','[]','queued',?)", [runId, hash(runId), U, kind, f.id, now]);
            const plan = { monitorRevision: 1, targetIdentity: targetIdentity(raw), context: { userId: U }, schedules: [], dictionaryRefs: {}, event: {}, text: 'Synthetic shared destination' };
            const lease = randomUUID(); await query("INSERT INTO automation_jobs(id,run_id,destination_id,plan_json,due_at_ms,state,lease_token,lease_until_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'leased',?,?,?,?)", [id, runId, f.destinationId, JSON.stringify(plan), now, lease, now + 120000, now, now]);
            const job = { id, run_id: runId, destination_id: f.destinationId, owner_user_id: U, scope: 'private', guild_id: G, target_kind: kind, target_id: f.id, plan, due_at_ms: now, lease_token: lease };
            assert.equal((await createQueue(db, {}, { clock: () => now }).check(job, now)).state, 'ready');
        });
    }
});
