'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createDestinations, VIEW, SEND, MANAGE_WEBHOOKS } = require('../../src/automation/destinations');
const schema = require('../../src/db_schema');
const root = path.resolve(__dirname, '../..'), port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = '222222222222222222', G = '111111111111111111', C = '333333333333333333', B = '555555555555555555', OTHER = '999999999999999999', M = '888888888888888888';
const actor = { userId: U, guildId: G, canView: true, canEdit: true };
const input = name => ({ name, kind: 'channel', channelId: C, scope: 'private' });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function load(relative, replacements = {}) {
    const filename = path.join(root, relative), native = createRequire(filename), mod = { exports: {} };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => Object.hasOwn(replacements, id) ? replacements[id] : native(id), mod, mod.exports);
    return mod.exports;
}
async function fixture() {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, U);
        for (const sql of schema.SCHEMA_STATEMENTS.filter(sql => /CREATE TABLE IF NOT EXISTS (?:twitter_accounts|auto_extract_targets)\s*\(/.test(sql))) await db.queryDatabase(sql);
        const hooks = new Map(), trace = [], state = { onLookup: null, onCreate: null, metadataStatus: 0, lookupStatus: 0, deny: '', failPostAfterCreate: false };
        let sequence = 0;
        const makeHook = (userId = B) => {
            const id = String(666666666666666666n + BigInt(++sequence)), hook = { id, type: 1, guild_id: G, channel_id: C,
                token: 'synthetic-token-never-submitted', user: { id: userId }, name: 'ComebackTwitterEmbed Auto' };
            hooks.set(id, hook); return hook;
        };
        const rest = async (route, init = {}) => {
            let data;
            if (route === `/guilds/${G}`) data = { id: G, owner_id: OTHER };
            else if (route === `/guilds/${G}/roles`) data = [{ id: G, permissions: String(VIEW | SEND | MANAGE_WEBHOOKS) }];
            else if (route === `/guilds/${G}/members/${U}` || route === `/guilds/${G}/members/${B}`) data = { user: { id: route.endsWith(U) ? U : B }, roles: [] };
            else if (route === '/users/@me') data = { id: B };
            else if (route === `/channels/${C}`) data = { id: C, guild_id: G, type: 0, permission_overwrites: state.deny ? [{ id: state.deny, type: 1, allow: '0', deny: String(SEND | MANAGE_WEBHOOKS) }] : [] };
            else if (route === `/channels/${C}/webhooks` && init.method === 'POST') {
                const hook = makeHook(); trace.push(`create:${hook.id}`); await state.onCreate?.(hook);
                if (state.failPostAfterCreate) throw Object.assign(new Error('Unknown creation outcome with sensitive body'), { status: 503 });
                data = hook;
            } else if (route === `/channels/${C}/webhooks`) {
                if (state.lookupStatus) throw Object.assign(new Error('Sensitive webhook enumeration response'), { status: state.lookupStatus });
                data = [...hooks.values()]; trace.push(`lookup:${data.length}`); await state.onLookup?.();
            } else if (route.startsWith('/webhooks/')) {
                const id = route.split('/')[2];
                if (init.method === 'DELETE') { trace.push(`delete:${id}`); hooks.delete(id); return { data: null }; }
                trace.push(`metadata:${id}`);
                if (state.metadataStatus || !hooks.has(id)) throw Object.assign(new Error('Sensitive webhook token and response'), { status: state.metadataStatus || 404 });
                data = hooks.get(id);
            } else assert.fail(`Unexpected synthetic REST route ${route}`);
            return { data: structuredClone(data) };
        };
        const service = createService(db), api = (options = {}) => createDestinations(options.db || db,
            options.afterSave ? { ...service, saveDestination: async (...args) => { const saved = await service.saveDestination(...args); await options.afterSave(saved); return saved; } } : service, { rest });
        const observed = signal => ({ ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            if (/INSERT IGNORE INTO automation_counters/.test(sql)) signal.resolve(); return query(sql, params);
        })) });
        const endpoint = async hook => {
            const url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
            await db.queryDatabase('INSERT INTO webhook_endpoints (webhook_url_hash,webhook_url) VALUES (?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)', [hash(url), url]);
            return (await db.queryDatabase('SELECT id FROM webhook_endpoints WHERE webhook_url_hash=?', [hash(url)]))[0].id;
        };
        const counts = async () => {
            const row = (await db.queryDatabase('SELECT (SELECT COUNT(*) FROM webhook_endpoints) AS endpoints,(SELECT COUNT(*) FROM automation_destinations) AS resources'))[0];
            return { endpoints: Number(row.endpoints), resources: Number(row.resources) };
        };
        return { db, hooks, trace, state, makeHook, rest, service, api, observed, endpoint, counts };
    } catch (error) { await db.close(); throw error; }
}

test('S8 dashboard: concurrent distinct private resources share one hook and endpoint under the channel SQL lock', { skip: !port }, async () => {
    const f = await fixture(), firstLookup = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
    try {
        f.state.onLookup = async () => { if (!f.trace.some(entry => entry.startsWith('create:'))) { firstLookup.resolve(); await release.promise; } };
        const a = f.api().save(actor, input('First resource')); pending.push(a); await firstLookup.promise;
        const b = f.api({ db: f.observed(secondStarted) }).save(actor, input('Second resource')); pending.push(b); await secondStarted.promise;
        assert.equal(f.trace.filter(entry => entry.startsWith('lookup:')).length, 1); assert.equal(f.hooks.size, 0);
        release.resolve(); const [first, second] = await Promise.all(pending);
        assert.notEqual(first.id, second.id); assert.equal(f.hooks.size, 1);
        assert.deepEqual(await f.counts(), { endpoints: 1, resources: 2 });
        assert.equal(f.trace.filter(entry => entry.startsWith('create:')).length, 1);
        assert.equal(new Set((await f.db.queryDatabase('SELECT webhook_endpoint_id FROM automation_destinations')).map(row => String(row.webhook_endpoint_id))).size, 1);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});

test('S8 dashboard: a creator rollback deletes only its unused hook before a waiting resource chooses a fresh hook', { skip: !port }, async () => {
    const f = await fixture(), saved = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
    try {
        const a = f.api({ afterSave: async () => { saved.resolve(); await release.promise; throw new Error('Synthetic pre-commit canonical result failure'); } }).save(actor, input('Rolled back')).catch(error => error);
        pending.push(a); await saved.promise; const oldId = [...f.hooks.keys()][0];
        const b = f.api({ db: f.observed(secondStarted) }).save(actor, input('Survivor')); pending.push(b); await secondStarted.promise;
        release.resolve(); const [failure, survivor] = await Promise.all(pending);
        assert.match(failure.message, /Synthetic pre-commit/); assert(survivor.id);
        assert.equal(f.hooks.has(oldId), false); assert.equal(f.hooks.size, 1);
        assert.deepEqual(await f.counts(), { endpoints: 1, resources: 1 });
        assert(f.trace.includes(`delete:${oldId}`));
        const endpoint = (await f.db.queryDatabase('SELECT webhook_url FROM webhook_endpoints'))[0]; assert(!endpoint.webhook_url.includes(oldId));
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});

test('S8 dashboard: a raw-URL adopter revalidates after the creator rolls back instead of committing a deleted endpoint', { skip: !port }, async () => {
    const f = await fixture(), saved = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
    try {
        const a = f.api({ afterSave: async () => { saved.resolve(); await release.promise; throw new Error('Synthetic rollback'); } }).save(actor, input('Creator')).catch(error => error);
        pending.push(a); await saved.promise; const hook = [...f.hooks.values()][0];
        const b = f.api({ db: f.observed(secondStarted) }).save(actor, { name: 'Existing URL', kind: 'webhook', scope: 'private', webhookUrl: `https://discord.com/api/webhooks/${hook.id}/${hook.token}` }).catch(error => error);
        pending.push(b); await secondStarted.promise; release.resolve(); const [, failure] = await Promise.all(pending);
        assert.equal(failure.code, 'DISCORD_ACCESS_DENIED'); assert.equal(failure.status, 403);
        assert.doesNotMatch(failure.message, /Sensitive|synthetic-token|https:/);
        assert.deepEqual(await f.counts(), { endpoints: 0, resources: 0 }); assert.equal(f.hooks.size, 0);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});

for (const kind of ['auto', 'price']) test(`S8 dashboard: native ${kind} direct adoption also waits for creator rollback and cannot save its deleted hook`, { skip: !port }, async () => {
    const f = await fixture(), saved = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
    try {
        const a = f.api({ afterSave: async () => { saved.resolve(); await release.promise; throw new Error('Synthetic rollback'); } }).save(actor, input('Creator')).catch(error => error);
        pending.push(a); await saved.promise; const hook = [...f.hooks.values()][0], url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
        const binding = { ...f.observed(secondStarted), ensureUserExistsInDatabase: async () => {} }, ensure = { ...schema, ensureDatabaseSchema: async () => {} };
        const auto = load('src/providers/autoWatch/store.js', { '../../db': binding, '../../db_schema': ensure });
        const validated = { ...auto, validateWebhook: value => auto.validateWebhook(value, { fetch: async () => {
            try { const result = await f.rest(`/webhooks/${hook.id}/${hook.token}`); return { ok: true, status: 200, json: async () => result.data }; }
            catch (error) { return { ok: false, status: error.status, json: async () => ({}) }; }
        } }) };
        const replies = [], channel = { id: C, type: 0, createWebhook: async () => {}, permissionsFor: () => ({ has: () => true }) };
        const interaction = { user: { id: U }, member: { id: U }, guildId: G, channelId: C, locale: 'ja', client: { user: { id: B } },
            guild: { id: G, members: { me: { id: B } }, channels: { cache: new Map([[C, channel]]) } },
            options: { getBoolean: () => true, getString: key => ({ provider: 'github', source: 'octocat', destination: 'webhook', webhook: url })[key] || null },
            customId: `priceWatchModal:change:webhook:s:app:730:ja:${M}`, message: { id: M, embeds: [{ url: 'https://store.steampowered.com/app/730' }] },
            fields: { getTextInputValue: () => url }, deferReply: async () => {}, editReply: async value => replies.push(value) };
        const run = kind === 'auto' ? load('src/commands/handlers/autoextract/watch.js', { '../../../db': binding, '../../../db_schema': ensure, '../../../providers/autoWatch/store': validated, '../../../errorTracking': { recordError: () => {} } })
            : load('src/components/priceWatch.js', { '../db': binding, '../db_schema': ensure, '../providers/autoWatch/store': validated,
                '../providers/priceWatch/store': load('src/providers/priceWatch/store.js', { '../../db': binding, '../../db_schema': ensure }), './_permissionCheck': { isAllowed: async () => true } }).handleModal;
        const b = run(interaction).catch(error => error); pending.push(b); await secondStarted.promise; release.resolve(); await Promise.all(pending);
        assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${kind === 'auto' ? 'auto_watch_targets' : 'price_watch_targets'}`))[0].n), 0);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
        assert.match(JSON.stringify(replies.at(-1)), /Webhook/); assert.doesNotMatch(JSON.stringify(replies), /synthetic-token|Sensitive|https:/);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});

test('S8 dashboard: COMMIT acknowledgement uncertainty and unknown remote creation keep hooks for safe later reuse', { skip: !port }, async () => {
    const f = await fixture();
    try {
        const uncertain = { ...f.db, withDatabaseTransaction: async work => { await f.db.withDatabaseTransaction(work); throw new Error('COMMIT acknowledgement lost'); } };
        await assert.rejects(f.api({ db: uncertain }).save(actor, input('Committed')), /COMMIT acknowledgement lost/);
        assert.deepEqual(await f.counts(), { endpoints: 1, resources: 1 }); assert.equal(f.hooks.size, 1);
        assert.equal(f.trace.filter(entry => entry.startsWith('delete:')).length, 0);
        await f.api().save(actor, input('Another valid resource'));
        assert.deepEqual(await f.counts(), { endpoints: 1, resources: 2 }); assert.equal(f.hooks.size, 1);
    } finally { await f.db.close(); }
    const unknown = await fixture();
    try {
        unknown.state.failPostAfterCreate = true;
        await assert.rejects(unknown.api().save(actor, input('Unknown creation')), { code: 'DISCORD_UNAVAILABLE' });
        assert.equal(unknown.hooks.size, 1); assert.deepEqual(await unknown.counts(), { endpoints: 0, resources: 0 });
        unknown.state.failPostAfterCreate = false; await unknown.api().save(actor, input('Retry'));
        assert.equal(unknown.hooks.size, 1); assert.deepEqual(await unknown.counts(), { endpoints: 1, resources: 1 });
    } finally { await unknown.db.close(); }
});

test('S8 dashboard: cleanup retains an already committed destination which adopted the newly created hook', { skip: !port }, async () => {
    const f = await fixture(), created = deferred(), release = deferred(), pending = [];
    try {
        f.state.onCreate = async hook => { created.resolve(hook); await release.promise; };
        const a = f.api().save(actor, input('Failing creator')).catch(error => error); pending.push(a);
        const hook = await created.promise;
        const endpointId = await f.endpoint(hook);
        const committed = await f.service.saveDestination(actor, { name: 'Already adopted', kind: 'webhook', scope: 'private' },
            { webhookEndpointId: String(endpointId), guildId: G, channelId: C, createdByBot: false });
        f.state.metadataStatus = 503; release.resolve(); const [failure] = await Promise.all(pending);
        assert.equal(failure.code, 'DISCORD_UNAVAILABLE'); assert(f.hooks.has(hook.id));
        assert.deepEqual(await f.counts(), { endpoints: 1, resources: 1 });
        assert.equal((await f.db.queryDatabase('SELECT id FROM automation_destinations'))[0].id, committed.id);
        assert.equal(f.trace.filter(entry => entry.startsWith('delete:')).length, 0);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});

test('S8 dashboard: user/bot permissions and 503/404 failures leave foreign hooks and private resources untouched', { skip: !port }, async () => {
    const f = await fixture();
    try {
        const foreign = f.makeHook(OTHER), endpointId = await f.endpoint(foreign);
        const resource = await f.service.saveDestination({ userId: OTHER, guildId: G }, { name: 'Foreign private resource', kind: 'webhook', scope: 'private' },
            { webhookEndpointId: String(endpointId), guildId: G, channelId: C, createdByBot: false });
        const before = (await f.db.queryDatabase('SELECT * FROM automation_destinations WHERE id=?', [resource.id]))[0];
        for (const principal of [U, B]) {
            f.state.deny = principal;
            await assert.rejects(f.api().save(actor, input('Denied')), { code: principal === U ? 'CHANNEL_PERMISSION' : 'BOT_CHANNEL_PERMISSION' });
        }
        f.state.deny = ''; f.state.lookupStatus = 503;
        await assert.rejects(f.api().save(actor, input('Unavailable')), { code: 'DISCORD_UNAVAILABLE' });
        f.state.lookupStatus = 0; f.state.metadataStatus = 404;
        await assert.rejects(f.api().save(actor, input('Missing after creation')), { code: 'DISCORD_ACCESS_DENIED' });
        assert(f.hooks.has(foreign.id)); assert.equal(f.hooks.size, 1);
        assert.deepEqual(await f.counts(), { endpoints: 1, resources: 1 });
        assert.deepEqual((await f.db.queryDatabase('SELECT * FROM automation_destinations WHERE id=?', [resource.id]))[0], before);
        assert(!f.trace.includes(`delete:${foreign.id}`));
    } finally { await f.db.close(); }
});
