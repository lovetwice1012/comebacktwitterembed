'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module'), { compileFunction } = require('node:vm');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createDestinations, VIEW, SEND } = require('../../src/automation/destinations');
const schema = require('../../src/db_schema');
const root = path.resolve(__dirname, '../..'), port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = '222222222222222222', E = '222222222222222223', G = '111111111111111111';
const O = '333333333333333333', C = '444444444444444444', B = '555555555555555555', H = '666666666666666666';
const URL = `https://discord.com/api/webhooks/${H}/synthetic-token-never-submitted`;
const actor = userId => ({ userId, guildId: G, canView: true, canEdit: true });
function load(relative, replacements) {
    const filename = path.join(root, relative), native = createRequire(filename), mod = { exports: {} };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => Object.hasOwn(replacements, id) ? replacements[id] : native(id), mod, mod.exports);
    return mod.exports;
}
async function fixture(kind) {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, U); await grantTestDonor(db, E);
        const calls = [], denied = new Map(), state = { metadataStatus: 0, channelStatus: 0, onMetadata: null, onChannel: null,
            webhook: { id: H, type: 1, guild_id: G, channel_id: C } };
        const rest = async route => {
            calls.push(route); let data;
            if (route.startsWith('/webhooks/')) {
                if (state.metadataStatus) throw Object.assign(new Error('Sensitive webhook and upstream body'), { status: state.metadataStatus });
                data = structuredClone(state.webhook); const work = state.onMetadata; state.onMetadata = null; await work?.();
            } else if (route === `/guilds/${G}`) data = { id: G, owner_id: '999999999999999999' };
            else if (route === `/guilds/${G}/roles`) data = [{ id: G, permissions: String(VIEW | SEND) }];
            else if (route.startsWith(`/guilds/${G}/members/`)) data = { user: { id: route.split('/').at(-1) }, roles: [] };
            else if (route === '/users/@me') data = { id: B };
            else if ([`/channels/${O}`, `/channels/${C}`].includes(route)) {
                if (state.channelStatus) throw Object.assign(new Error('Sensitive recipient channel failure'), { status: state.channelStatus });
                const channelId = route.split('/').at(-1), work = state.onChannel; state.onChannel = null; await work?.();
                data = { id: channelId, guild_id: G, type: 0, permission_overwrites: channelId === C ? [...denied].map(([id, flag]) => ({ id, type: 1, deny: String(flag), allow: '0' })) : [] };
            } else assert.fail(`Unexpected mock Discord route ${route}`);
            return { data };
        };
        const service = createService(db, { rateLimiter: { consumeOperation: async () => {} } });
        const destinations = createDestinations(db, service, { rest }), monitors = createMonitors(db, service, destinations);
        const binding = { ...db, ensureUserExistsInDatabase: async () => {} };
        const native = load(`src/providers/${kind === 'auto' ? 'autoWatch' : 'priceWatch'}/store.js`, { '../../db': binding, '../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} } });
        const register = index => native.registerTarget({ userId: U, providerId: kind === 'auto' ? 'github' : 'steam',
            source: `native-user-${index}`, productUrl: `https://store.steampowered.com/app/${730 + index}`, locale: 'ja',
            destinationType: index ? 'dm' : 'webhook', webhookUrl: index ? '' : URL, guildId: G, channelId: O, destinationChannelId: index ? undefined : C, mode: 'change' },
        { operationRateLimiter: { consumeOperation: async () => {} }, service });
        const target = await register(0), fillers = [];
        for (let index = 1; index < 5; index++) fillers.push(await register(index));
        const paused = await monitors.save(actor(U), kind, { expectedRevision: 1, enabled: false }, target.id);
        const table = kind === 'auto' ? 'auto_watch' : 'price_watch', runId = randomUUID(), jobId = randomUUID(), now = Date.now();
        await db.queryDatabase("INSERT INTO automation_runs(id,dedupe_key,owner_user_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES(?,?,?,'guild',?,?,'{}','[]','queued',?)", [runId, hash(runId), U, kind, target.id, now]);
        await db.queryDatabase("INSERT INTO automation_jobs(id,run_id,plan_json,due_at_ms,state,created_at_ms,updated_at_ms) VALUES(?,?,'{}',?,'pending',?,?)", [jobId, runId, now, now, now]);
        const snapshot = async () => ({ targets: await db.queryDatabase(`SELECT * FROM ${table}_targets ORDER BY id`),
            monitors: await db.queryDatabase('SELECT * FROM automation_monitors ORDER BY target_kind,target_id'),
            slots: await db.queryDatabase('SELECT * FROM automation_notification_slots ORDER BY owner_user_id,slot_index'),
            jobs: await db.queryDatabase('SELECT * FROM automation_jobs ORDER BY id'), audit: await db.queryDatabase('SELECT * FROM automation_audit ORDER BY id') });
        const resume = (who = U, revision = paused.revision) => monitors.save(actor(who), kind, { expectedRevision: revision, enabled: true }, target.id);
        return { db, table, native, target, fillers, paused, service, monitors, destinations, rest, calls, state, denied, snapshot, resume };
    } catch (error) { await db.close(); throw error; }
}

for (const kind of ['auto', 'price']) test(`S18/S24 unmanaged ${kind}: actual native recipient, endpoint CAS and owner/editor permissions at full capacity`, { skip: !port, timeout: 120000 }, async t => {
    const f = await fixture(kind);
    try {
        const before = await f.snapshot(), endpointId = before.targets.find(row => String(row.id) === String(f.target.id)).webhook_endpoint_id;
        assert.equal(before.slots.filter(row => row.target_kind).length, 5);
        assert.equal(before.targets.find(row => String(row.id) === String(f.target.id)).origin_channel_id, O);
        assert.equal(before.targets.find(row => String(row.id) === String(f.target.id)).destination_key, `channel:${G}:${C}`);
        await t.test('denied SEND/VIEW in the actual recipient blocks both owner and editor without checking invocation channel', async () => {
            for (const principal of [U, E]) for (const flag of [VIEW, SEND]) {
                f.denied.set(principal, flag); f.calls.length = 0;
                await assert.rejects(f.resume(E), { code: 'CHANNEL_PERMISSION', status: 403 });
                assert.deepEqual(await f.snapshot(), before); assert(f.calls.includes(`/channels/${C}`));
                assert(!f.calls.includes(`/channels/${O}`)); assert(f.calls.some(route => route.startsWith('/webhooks/')));
                f.denied.clear();
            }
        });
        await t.test('404/410 missing webhook, 403 access, 503 outage and 429 retry remain distinct safe failures', async () => {
            for (const [status, code, http] of [[404, 'DESTINATION_DELETED', 404], [410, 'DESTINATION_DELETED', 404], [403, 'DISCORD_ACCESS_DENIED', 403], [503, 'DISCORD_UNAVAILABLE', 503], [429, 'DISCORD_RATE_LIMITED', 503]]) {
                f.state.metadataStatus = status;
                await assert.rejects(f.resume(), error => error.code === code && error.status === http && !/Sensitive|synthetic-token|https:/.test(error.message));
                assert.deepEqual(await f.snapshot(), before);
            }
            f.state.metadataStatus = 0; f.state.channelStatus = 404;
            await assert.rejects(f.resume(), { code: 'DISCORD_ACCESS_DENIED', status: 403 }); assert.deepEqual(await f.snapshot(), before); f.state.channelStatus = 0;
        });
        await t.test('foreign guild/type/id/channel metadata cannot establish a new binding', async () => {
            const original = structuredClone(f.state.webhook);
            for (const patch of [{ guild_id: '111111111111111112' }, { type: 2 }, { id: '666666666666666667' }, { channel_id: O }]) {
                f.state.webhook = { ...original, ...patch };
                await assert.rejects(f.resume(), error => ['WEBHOOK_DESTINATION_CHANGED', 'DESTINATION_CHANGED'].includes(error.code) && error.status === 409);
                assert.deepEqual(await f.snapshot(), before);
            }
            f.state.webhook = original;
        });
        await t.test('missing stored endpoint, URL mutation and target revision changes are fenced before resume', async () => {
            const original = (await f.db.queryDatabase('SELECT * FROM webhook_endpoints WHERE id=?', [endpointId]))[0];
            // The real FK cascades endpoint deletion into target deletion;
            // model an intact legacy target with its allowed NULL reference.
            await f.db.queryDatabase(`UPDATE ${f.table}_targets SET webhook_endpoint_id=NULL,updated_at=updated_at WHERE id=?`, [f.target.id]);
            const missingReference = await f.snapshot();
            await assert.rejects(f.resume(), { code: 'DESTINATION_DELETED' }); assert.deepEqual(await f.snapshot(), missingReference);
            await f.db.queryDatabase(`UPDATE ${f.table}_targets SET webhook_endpoint_id=?,updated_at=updated_at WHERE id=?`, [endpointId, f.target.id]);
            const replacement = URL.replace(H, '666666666666666667');
            f.state.onMetadata = () => f.db.queryDatabase('UPDATE webhook_endpoints SET webhook_url=?,webhook_url_hash=? WHERE id=?', [replacement, hash(replacement), endpointId]);
            await assert.rejects(f.resume(), { code: 'DESTINATION_CHANGED', status: 409 }); assert.deepEqual(await f.snapshot(), before);
            await f.db.queryDatabase('UPDATE webhook_endpoints SET webhook_url=?,webhook_url_hash=? WHERE id=?', [original.webhook_url, original.webhook_url_hash, endpointId]);
            const inserted = await f.db.queryDatabase('INSERT INTO webhook_endpoints (webhook_url,webhook_url_hash) VALUES (?,?)', [replacement, hash(replacement)]);
            f.state.onMetadata = () => f.db.queryDatabase(`UPDATE ${f.table}_targets SET webhook_endpoint_id=?,updated_at=updated_at WHERE id=?`, [inserted.insertId, f.target.id]);
            await assert.rejects(f.resume(), { code: 'REVISION_CONFLICT', status: 409 });
            assert.equal((await f.snapshot()).targets.find(row => String(row.id) === String(f.target.id)).enabled, 0);
            await f.db.queryDatabase(`UPDATE ${f.table}_targets SET webhook_endpoint_id=?,updated_at=updated_at WHERE id=?`, [endpointId, f.target.id]);
            await f.db.queryDatabase('DELETE FROM webhook_endpoints WHERE id=?', [inserted.insertId]);
            assert.deepEqual(await f.snapshot(), before);
            f.state.onChannel = () => f.db.queryDatabase('UPDATE automation_monitors SET revision=revision+1 WHERE target_kind=? AND target_id=?', [kind, f.target.id]);
            await assert.rejects(f.resume(), { code: 'REVISION_CONFLICT', status: 409 });
            assert.equal((await f.snapshot()).targets.find(row => String(row.id) === String(f.target.id)).enabled, 0);
            await f.db.queryDatabase('UPDATE automation_monitors SET revision=? WHERE target_kind=? AND target_id=?', [f.paused.revision, kind, f.target.id]);
            assert.deepEqual(await f.snapshot(), before);
        });
        await t.test('audit/SQL failure rolls back enabled, baselines, slots, queued jobs, revision and audit', async () => {
            const transaction = f.db.withDatabaseTransaction;
            f.db.withDatabaseTransaction = work => transaction(query => work((sql, params) => {
                if (sql.startsWith('INSERT INTO automation_audit')) throw new Error('Synthetic post-resume audit failure');
                return query(sql, params);
            }));
            try { await assert.rejects(f.resume(), /Synthetic post-resume audit failure/); } finally { f.db.withDatabaseTransaction = transaction; }
            assert.deepEqual(await f.snapshot(), before);
        });
        await t.test('healthy owner/editor resume reuses the existing slot and preserves recipient identity at the cap', async () => {
            f.calls.length = 0; const result = await f.resume(E), after = await f.snapshot();
            assert.equal(result.revision, f.paused.revision + 1); assert.deepEqual(after.slots, before.slots);
            const target = after.targets.find(row => String(row.id) === String(f.target.id)); assert.equal(target.enabled, 1);
            assert.equal(String(target.webhook_endpoint_id), String(endpointId)); assert.equal(target.origin_channel_id, O);
            assert.equal(target.destination_key, `channel:${G}:${C}`); assert.equal(target.user_id, U);
            assert(f.calls.includes(`/guilds/${G}/members/${U}`)); assert(f.calls.includes(`/guilds/${G}/members/${E}`));
            assert(!f.calls.includes(`/channels/${O}`));
        });
        await t.test('unchanged enabled save rechecks actual destination; disabled edits and removal need no REST', async () => {
            const active = await f.snapshot(); f.state.metadataStatus = 404;
            await assert.rejects(f.resume(U, 3), { code: 'DESTINATION_DELETED' }); assert.deepEqual(await f.snapshot(), active);
            f.calls.length = 0; const paused = await f.monitors.save(actor(U), kind, { expectedRevision: 3, enabled: false }, f.target.id);
            const renamed = await f.monitors.save(actor(U), kind, { expectedRevision: paused.revision, name: 'Stopped native monitor' }, f.target.id);
            const stopped = await f.monitors.save(actor(U), kind, { expectedRevision: renamed.revision, enabled: false, name: 'Still stopped' }, f.target.id);
            assert.equal(f.calls.length, 0); await f.monitors.remove(actor(U), kind, f.target.id, stopped.revision); assert.equal(f.calls.length, 0);
            assert.equal((await f.snapshot()).slots.filter(row => row.target_kind).length, 4);
        });
        await t.test('own native DM resume makes zero REST requests and rejects a forged recipient key', async () => {
            const dm = f.fillers[0], paused = await f.monitors.save(actor(U), kind, { expectedRevision: 1, enabled: false }, dm.id); f.calls.length = 0;
            const result = await f.monitors.save({ userId: U }, kind, { expectedRevision: paused.revision, enabled: true }, dm.id);
            assert.equal(result.revision, 3); assert.equal(f.calls.length, 0);
            const stopped = await f.monitors.save({ userId: U }, kind, { expectedRevision: 3, enabled: false }, dm.id);
            await f.db.queryDatabase(`UPDATE ${f.table}_targets SET destination_key=? WHERE id=?`, [`dm:${E}`, dm.id]); const beforeForgery = await f.snapshot();
            await assert.rejects(f.monitors.save({ userId: U }, kind, { expectedRevision: stopped.revision, enabled: true }, dm.id), { code: 'DM_OWNER' });
            assert.equal(f.calls.length, 0); assert.deepEqual(await f.snapshot(), beforeForgery);
        });
    } finally { await f.db.close(); }
});
