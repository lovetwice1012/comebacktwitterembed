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
        const service = createService(db, { rateLimiter: { consumeOperation: async () => {} },
            verifyChannel: (principal, guild, channel) => destinations.verifyChannel(principal, guild, channel), verifyWebhook: (guild, url) => destinations.verifyWebhook(guild, url) });
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

for (const kind of ['auto', 'price']) test(`S18/S24 managed ${kind}: native recipient resources are checked remotely on registration, resume and active binding save`, { skip: !port, timeout: 120000 }, async t => {
    const f = await fixture(kind);
    try {
        const resource = await f.destinations.save(actor(U), { name: 'Managed native recipient', kind: 'webhook', scope: 'guild', webhookUrl: URL });
        const edited = await f.monitors.save(actor(U), kind, { expectedRevision: f.paused.revision, destinationId: resource.id, enabled: false }, f.target.id);
        const before = await f.snapshot(); assert.equal(before.slots.filter(row => row.target_kind).length, 5);
        const registration = { name: 'Another managed monitor', scope: 'guild', providerId: kind === 'auto' ? 'github' : 'steam',
            source: kind === 'auto' ? 'managedcandidate' : 'https://store.steampowered.com/app/440', destinationId: resource.id, ...(kind === 'price' ? { mode: 'change' } : {}) };
        const fullSave = () => f.monitors.save(actor(E), kind, { expectedRevision: edited.revision, enabled: true, destinationId: resource.id }, f.target.id);
        await t.test('missing/access/rate/outage failures reject both passive resume and full save without mutating slots or jobs', async () => {
            for (const [status, code] of [[404, 'DESTINATION_DELETED'], [410, 'DESTINATION_DELETED'], [403, 'DISCORD_ACCESS_DENIED'], [503, 'DISCORD_UNAVAILABLE'], [429, 'DISCORD_RATE_LIMITED']]) {
                f.state.metadataStatus = status;
                for (const run of [() => f.resume(E, edited.revision), fullSave, () => f.monitors.save(actor(U), kind, registration)]) {
                    await assert.rejects(run(), error => error.code === code && !/Sensitive|synthetic-token|https:/.test(error.message));
                    assert.deepEqual(await f.snapshot(), before);
                }
            }
            f.state.metadataStatus = 0;
        });
        await t.test('a remotely moved hook never changes the saved recipient; the physical transport also rejects it', async () => {
            f.state.webhook.channel_id = O;
            for (const run of [() => f.resume(E, edited.revision), fullSave, () => f.monitors.save(actor(U), kind, registration)]) {
                await assert.rejects(run(), { code: 'WEBHOOK_DESTINATION_CHANGED', status: 409 }); assert.deepEqual(await f.snapshot(), before);
            }
            let sends = 0;
            const transport = require('../../src/automation/transport').createTransport(f.db, f.destinations, {}, { rest: {
                get: async () => structuredClone(f.state.webhook), post: async () => { sends++; assert.fail('No physical Discord send is permitted'); },
            } });
            const destination = (await f.db.queryDatabase('SELECT * FROM automation_destinations WHERE id=?', [resource.id]))[0];
            await assert.rejects(transport.prepare({ id: 'synthetic', owner_user_id: U, target_kind: kind, target_id: f.target.id, destination_id: resource.id, plan: {} }, destination), { code: 'WEBHOOK_MOVED', status: 403 });
            assert.equal(sends, 0); f.state.webhook.channel_id = C;
        });
        await t.test('endpoint and resource identity swaps after remote checks fail CAS before target mutation', async () => {
            const endpoint = (await f.db.queryDatabase('SELECT e.* FROM webhook_endpoints e JOIN automation_destinations d ON d.webhook_endpoint_id=e.id WHERE d.id=?', [resource.id]))[0];
            const replacement = URL.replace(H, '666666666666666667');
            f.state.onMetadata = () => f.db.queryDatabase('UPDATE webhook_endpoints SET webhook_url=?,webhook_url_hash=? WHERE id=?', [replacement, hash(replacement), endpoint.id]);
            await assert.rejects(fullSave(), { code: 'DESTINATION_CHANGED', status: 409 }); assert.deepEqual(await f.snapshot(), before);
            await f.db.queryDatabase('UPDATE webhook_endpoints SET webhook_url=?,webhook_url_hash=? WHERE id=?', [endpoint.webhook_url, endpoint.webhook_url_hash, endpoint.id]);
            f.state.onMetadata = () => f.db.queryDatabase('UPDATE automation_destinations SET channel_id=? WHERE id=?', [O, resource.id]);
            await assert.rejects(f.resume(E, edited.revision), { code: 'DESTINATION_CHANGED', status: 409 }); assert.deepEqual(await f.snapshot(), before);
            await f.db.queryDatabase('UPDATE automation_destinations SET channel_id=? WHERE id=?', [C, resource.id]);
        });
        await t.test('healthy resume/save verifies both principals, retains five slots, and active no-op saves recheck deletion', async () => {
            for (const principal of [U, E]) {
                f.denied.set(principal, SEND); await assert.rejects(f.resume(E, edited.revision), { code: 'CHANNEL_PERMISSION' }); f.denied.clear();
            }
            const transaction = f.db.withDatabaseTransaction;
            f.db.withDatabaseTransaction = work => transaction(query => work((sql, params) => {
                if (sql.startsWith('INSERT INTO automation_audit')) throw new Error('Synthetic managed audit failure'); return query(sql, params);
            }));
            try { await assert.rejects(fullSave(), /Synthetic managed audit failure/); } finally { f.db.withDatabaseTransaction = transaction; }
            assert.deepEqual(await f.snapshot(), before); f.calls.length = 0;
            const resumed = await f.resume(E, edited.revision);
            assert.equal(resumed.revision, edited.revision + 1); assert.deepEqual((await f.snapshot()).slots, before.slots);
            assert(f.calls.some(route => route.startsWith('/webhooks/'))); assert(f.calls.includes(`/guilds/${G}/members/${U}`)); assert(f.calls.includes(`/guilds/${G}/members/${E}`));
            const saved = await f.monitors.save(actor(E), kind, { expectedRevision: resumed.revision, enabled: true, destinationId: resource.id, name: 'Active managed save' }, f.target.id);
            const active = await f.snapshot(); f.state.metadataStatus = 404;
            await assert.rejects(f.monitors.save(actor(U), kind, { expectedRevision: saved.revision, enabled: true }, f.target.id), { code: 'DESTINATION_DELETED' }); assert.deepEqual(await f.snapshot(), active);
            f.calls.length = 0;
            const paused = await f.monitors.save(actor(U), kind, { expectedRevision: saved.revision, enabled: false }, f.target.id);
            await f.monitors.remove(actor(U), kind, f.target.id, paused.revision); assert.equal(f.calls.length, 0);
        });
    } finally { await f.db.close(); }
});

function nativeCommand(f, kind, type, index) {
    const binding = { ...f.db, ensureUserExistsInDatabase: async () => {} }, ensure = { ...schema, ensureDatabaseSchema: async () => {} };
    binding.withDatabaseTransaction = work => f.db.withDatabaseTransaction(work);
    const limiter = require('../../src/automation/rate-limits').createRateLimiter(binding, { policy: { operations: { monitor: { minute: 1000, hour: 1000 } } } });
    const auto = load('src/providers/autoWatch/store.js', { '../../db': binding, '../../db_schema': ensure });
    const store = kind === 'auto' ? auto : load('src/providers/priceWatch/store.js', { '../../db': binding, '../../db_schema': ensure });
    const register = input => store.registerTarget(input, { service: f.service, operationRateLimiter: limiter, initialJitterMs: 0 });
    const validated = { ...auto, validateWebhook: url => auto.validateWebhook(url, { fetch: async () => {
        try { const result = await f.rest(`/webhooks/${H}/synthetic-token-never-submitted`); return { ok: true, status: 200, json: async () => result.data }; }
        catch (error) { return { ok: false, status: error.status, json: async () => ({}) }; }
    } }), registerTarget: register };
    const purpose = kind === 'auto' ? 'ComebackTwitterEmbed auto watch' : 'ComebackTwitterEmbed price alerts';
    const hook = { id: H, type: 1, name: purpose, owner: { id: B }, token: 'synthetic-token-never-submitted', url: URL };
    const channel = { id: C, type: 0, name: 'recipient', permissionsFor: () => ({ has: () => true }),
        fetchWebhooks: async () => new Map([[H, hook]]), createWebhook: async () => assert.fail('The existing hook must be reused') };
    const replies = [], source = `native-user-${index}`, product = String(730 + index), messageId = '888888888888888888';
    const interaction = locale => ({ user: { id: U }, member: { id: U }, guildId: G, channelId: O, channel: { id: O }, locale, client: { user: { id: B } },
        guild: { id: G, members: { me: { id: B } }, channels: { cache: new Map([[C, channel], [O, { ...channel, id: O }]]) } },
        options: { getBoolean: () => true, getString: key => ({ provider: 'github', source, destination: type, webhook: URL })[key] || null, getChannel: () => channel },
        customId: type === 'channel' ? `priceWatchChannel:s:app:${product}:ja:${messageId}:change`
            : type === 'dm' ? `priceWatchDestination:s:app:${product}:ja:${messageId}` : `priceWatchModal:change:webhook:s:app:${product}:ja:${messageId}`,
        values: type === 'channel' ? [C] : ['change:dm'], message: { id: messageId, embeds: [{ url: `https://store.steampowered.com/app/${product}` }] },
        fields: { getTextInputValue: () => URL }, deferReply: async () => {}, deferUpdate: async () => {}, editReply: async value => replies.push(value) });
    const command = kind === 'auto' ? load('src/commands/handlers/autoextract/watch.js', { '../../../db': binding, '../../../db_schema': ensure,
        '../../../providers/autoWatch/store': validated, '../../../errorTracking': { recordError: () => {} },
        '../../../automation/rate-operation': { withRateOperation: (db, who, group, work) => require('../../src/automation/rate-operation').withRateOperation(db, who, group, work, { rateLimiter: limiter }) } })
        : (() => { const component = load('src/components/priceWatch.js', { '../db': binding, '../db_schema': ensure, '../providers/autoWatch/store': validated,
            '../providers/priceWatch/store': { ...store, registerTarget: register }, './_permissionCheck': { isAllowed: async () => true } });
        return type === 'webhook' ? component.handleModal : component.handle; })();
    const input = { userId: U, providerId: kind === 'auto' ? 'github' : 'steam', source, productUrl: `https://store.steampowered.com/app/${product}`, locale: 'ja', mode: 'change',
        destinationType: type === 'dm' ? 'dm' : 'webhook', webhookUrl: type === 'dm' ? '' : URL, guildId: G, channelId: O, destinationChannelId: type === 'channel' ? C : undefined };
    return { run: async (locale = 'ja') => { replies.length = 0; await command(interaction(locale)); return JSON.stringify(replies.at(-1)); }, register: () => register(input) };
}

for (const kind of ['auto', 'price']) for (const type of ['dm', 'webhook', 'channel']) test(`S18/S24 native ${kind}/${type}: every existing registration validates its bound default at full capacity`, { skip: !port, timeout: 120000 }, async t => {
    const f = await fixture(kind), index = type === 'dm' ? 1 : 0, target = index ? f.fillers[0] : f.target;
    try {
        const resource = type === 'dm' ? await f.service.saveDestination({ userId: U }, { name: 'Owned native DM', kind: 'dm' })
            : await f.destinations.save(actor(U), { name: 'Existing default', kind: 'webhook', scope: 'guild', webhookUrl: URL });
        const edited = await f.monitors.save(actor(U), kind, { expectedRevision: index ? 1 : f.paused.revision, destinationId: resource.id, enabled: false }, target.id);
        const harness = nativeCommand(f, kind, type, index); let before = await f.snapshot();
        assert.equal(before.slots.filter(row => row.target_kind).length, 5);
        const resourceRow = (await f.db.queryDatabase('SELECT * FROM automation_destinations WHERE id=?', [resource.id]))[0];
        await t.test('disabled, deleted and foreign defaults reject actual Japanese/English commands with actionable safe replies', async () => {
            for (const state of ['disabled', 'deleted', 'foreign']) {
                if (state === 'disabled') await f.service.saveDestination(actor(U), { name: 'Stopped default', kind: type === 'dm' ? 'dm' : 'webhook', scope: resourceRow.scope, expectedRevision: 1, enabled: false },
                    type === 'dm' ? {} : { webhookEndpointId: String(resourceRow.webhook_endpoint_id), guildId: G, channelId: C }, resource.id);
                if (state === 'deleted') await f.service.remove('destination', actor(U), resource.id, 1);
                if (state === 'foreign') await f.db.queryDatabase("UPDATE automation_destinations SET scope='private',owner_user_id=? WHERE id=?", [E, resource.id]);
                const adverse = await f.snapshot();
                f.calls.length = 0;
                for (const locale of ['ja', 'en-US']) {
                    const reply = await harness.run(locale);
                    assert.doesNotMatch(reply, /登録しました|registered\./i); assert.match(reply, locale === 'ja' ? /通知一覧/ : /notification list/i);
                    assert.doesNotMatch(reply, /Sensitive|synthetic-token|https:|999999|222222222222222223/); assert.deepEqual(await f.snapshot(), adverse);
                }
                if (type === 'dm') assert.equal(f.calls.length, 0);
                await f.db.queryDatabase('UPDATE automation_destinations SET name=?,scope=?,owner_user_id=?,enabled=1,deleted_at_ms=NULL,revision=1,updated_at_ms=? WHERE id=?', [resourceRow.name, resourceRow.scope, resourceRow.owner_user_id, resourceRow.updated_at_ms, resource.id]);
                before = await f.snapshot();
            }
        });
        await t.test('actual store guards default recipient identity, outage and DM ownership without assignment shortcuts', async () => {
            if (type !== 'dm') {
                for (const [status, code] of [[404, 'DESTINATION_DELETED'], [503, 'DISCORD_UNAVAILABLE'], [429, 'DISCORD_RATE_LIMITED']]) {
                    f.state.metadataStatus = status; await assert.rejects(harness.register(), { code }); assert.deepEqual(await f.snapshot(), before);
                }
                f.state.metadataStatus = 0; f.state.webhook.channel_id = O;
                await assert.rejects(harness.register(), { code: 'WEBHOOK_DESTINATION_CHANGED' }); assert.deepEqual(await f.snapshot(), before); f.state.webhook.channel_id = C;
                f.denied.set(U, SEND); await assert.rejects(harness.register(), { code: 'CHANNEL_PERMISSION' }); assert.deepEqual(await f.snapshot(), before); f.denied.clear();
                f.state.onMetadata = () => f.db.queryDatabase('UPDATE automation_destinations SET enabled=0 WHERE id=?', [resource.id]);
                await assert.rejects(harness.register(), { code: 'DESTINATION_CHANGED' }); assert.deepEqual(await f.snapshot(), before);
                assert.equal((await f.db.queryDatabase('SELECT enabled FROM automation_destinations WHERE id=?', [resource.id]))[0].enabled, 1, 'In-transaction resource mutation rolls back with failed admission');
            } else {
                f.calls.length = 0; await f.db.queryDatabase('UPDATE automation_destinations SET dm_user_id=? WHERE id=?', [E, resource.id]);
                await assert.rejects(harness.register(), { code: 'DM_OWNER_MISMATCH' }); assert.deepEqual(await f.snapshot(), before); assert.equal(f.calls.length, 0);
                await f.db.queryDatabase('UPDATE automation_destinations SET dm_user_id=? WHERE id=?', [U, resource.id]);
                const transaction = f.db.withDatabaseTransaction; let changed = false;
                f.db.withDatabaseTransaction = work => transaction(query => work(async (sql, params) => {
                    const result = await query(sql, params);
                    if (!changed && sql === 'SELECT * FROM automation_destinations WHERE id=? FOR UPDATE' && params[0] === resource.id) {
                        changed = true; await query('UPDATE automation_destinations SET enabled=0 WHERE id=?', [resource.id]);
                    }
                    return result;
                }));
                try { await assert.rejects(harness.register(), { code: 'DESTINATION_CHANGED' }); } finally { f.db.withDatabaseTransaction = transaction; }
                assert.deepEqual(await f.snapshot(), before); assert.equal(f.calls.length, 0);
                assert.equal((await f.db.queryDatabase('SELECT enabled FROM automation_destinations WHERE id=?', [resource.id]))[0].enabled, 1);
            }
        });
        await t.test('healthy command reuses the same target/slot/default; enabled-target retries also recheck default state', async () => {
            f.calls.length = 0; const reply = await harness.run(); assert.match(reply, /登録しました/);
            const active = await f.snapshot(), actual = active.targets.find(row => String(row.id) === String(target.id)); assert.equal(actual.enabled, 1);
            assert.equal(active.targets.length, 5); assert.deepEqual(active.slots, before.slots);
            assert.equal(active.monitors.find(row => String(row.target_id) === String(target.id)).destination_id, resource.id);
            assert.equal(active.monitors.find(row => String(row.target_id) === String(target.id)).revision, edited.revision);
            if (type === 'dm') assert.equal(f.calls.length, 0);
            await f.db.queryDatabase('UPDATE automation_destinations SET enabled=0 WHERE id=?', [resource.id]);
            assert.match(await harness.run(), /通知一覧/); assert.deepEqual(await f.snapshot(), active);
            await f.db.queryDatabase('UPDATE automation_destinations SET enabled=1 WHERE id=?', [resource.id]);
        });
        await t.test('owned private use of a bound shared resource needs recipient access only; SQL failure preserves assignment, audit, jobs and slots', async () => {
            if (type !== 'dm') {
                await f.db.queryDatabase("UPDATE automation_monitors SET scope='private' WHERE target_kind=? AND target_id=?", [kind, target.id]);
                await f.db.queryDatabase('UPDATE automation_destinations SET owner_user_id=? WHERE id=?', [E, resource.id]);
                await harness.register();
            }
            const who = { userId: U }, workflow = await f.service.createWorkflow(who, { name: 'Existing assignment' });
            await f.service.activateWorkflow(who, workflow.id, { expectedRevision: 1 }); await f.service.attach(who, workflow.id, kind, target.id);
            const record = (await f.db.queryDatabase('SELECT revision FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, target.id]))[0];
            await f.monitors.save(who, kind, { expectedRevision: Number(record.revision), enabled: false }, target.id);
            const paused = await f.snapshot(), assignments = await f.db.queryDatabase('SELECT * FROM automation_assignments ORDER BY target_kind,target_id'), transaction = f.db.withDatabaseTransaction;
            f.db.withDatabaseTransaction = work => transaction(query => work(async (sql, params) => {
                const result = await query(sql, params);
                if (sql.includes(`INSERT INTO ${f.table}_targets`)) throw new Error('Synthetic native post-upsert SQL failure'); return result;
            }));
            try { await assert.rejects(harness.register(), /Synthetic native post-upsert SQL failure/); } finally { f.db.withDatabaseTransaction = transaction; }
            assert.deepEqual(await f.snapshot(), paused); assert.deepEqual(await f.db.queryDatabase('SELECT * FROM automation_assignments ORDER BY target_kind,target_id'), assignments);
            await harness.register(); assert.deepEqual((await f.snapshot()).slots, paused.slots); assert.deepEqual(await f.db.queryDatabase('SELECT * FROM automation_assignments ORDER BY target_kind,target_id'), assignments);
            if (type === 'dm') assert.equal(f.calls.length, 0);
            const counters = await f.db.queryDatabase('SELECT used_count FROM automation_counters WHERE used_count>0'); assert(counters.length > 0, 'Actual command/store operation budgets remain durable');
        });
    } finally { await f.db.close(); }
});
