'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const { createQueue } = require('../../src/automation/queue');
const { createService, hash } = require('../../src/automation/service');
const { createDestinations } = require('../../src/automation/destinations');
const { createMonitors } = require('../../src/automation/monitors');
const root = path.resolve(__dirname, '../..'), port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = '222222222222222222', G = '111111111111111111', C = '333333333333333333', B = '555555555555555555', M = '888888888888888888';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function load(relative, replacements = {}) {
    const filename = path.join(root, relative), native = createRequire(filename), mod = { exports: {} };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => Object.hasOwn(replacements, id) ? replacements[id] : native(id), mod, mod.exports);
    return mod.exports;
}
async function fixture(kind) {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, U);
        for (const sql of schema.SCHEMA_STATEMENTS.filter(sql => /CREATE TABLE IF NOT EXISTS (?:twitter_accounts|auto_extract_targets)\s*\(/.test(sql))) await db.queryDatabase(sql);
        const binding = { ...db, ensureUserExistsInDatabase: id => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [id]) };
        const replacements = { '../../db': binding, '../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} } };
        const auto = load('src/providers/autoWatch/store.js', replacements), price = load('src/providers/priceWatch/store.js', replacements);
        const native = kind === 'auto' ? auto : price, table = kind === 'auto' ? 'auto_watch_targets' : 'price_watch_targets';
        const purpose = kind === 'auto' ? 'ComebackTwitterEmbed auto watch' : 'ComebackTwitterEmbed price alerts';
        const hooks = new Map(), trace = [], deleted = [], replies = []; let sequence = 0;
        const channel = { id: C, name: 'alerts', type: 0, permissionsFor: () => ({ has: () => true }),
            fetchWebhooks: async () => { trace.push('lookup'); return new Map(hooks); },
            createWebhook: async ({ name }) => {
                const id = String(666666666666666666n + BigInt(++sequence)), token = 'synthetic-token-never-submitted';
                const hook = { id, type: 1, name, owner: { id: B }, token, url: `https://discord.com/api/webhooks/${id}/${token}`,
                    delete: async () => { trace.push(`delete:${id}`); deleted.push(id); hooks.delete(id); } };
                hooks.set(id, hook); trace.push(`create:${id}`); return hook;
            } };
        const interaction = (failReply = false) => {
            let attempts = 0;
            return { user: { id: U }, member: { id: U }, client: { user: { id: B } }, guildId: G, channelId: C, channel, locale: 'ja',
                guild: { id: G, members: { me: { id: B } }, channels: { cache: new Map([[C, channel]]) } },
                options: { getBoolean: () => true, getString: key => ({ provider: 'github', source: 'octocat', destination: 'channel' })[key] || null, getChannel: () => channel },
                customId: `priceWatchChannel:s:app:730:ja:${M}:change`, values: [C],
                message: { id: M, embeds: [{ url: 'https://store.steampowered.com/app/730', title: 'Fixture' }] },
                deferUpdate: async () => { trace.push('defer'); },
                editReply: async payload => { replies.push(payload); if (failReply && attempts++ === 0) throw Object.assign(new Error('Synthetic confirmation failure'), { code: 'ETIMEDOUT' }); },
            };
        };
        // Compile separate helper instances, as separate resident processes do.
        // Their module-local creation maps cannot provide the tested exclusion.
        const helperA = load('src/components/_webhookDestination.js'), helperB = load('src/components/_webhookDestination.js');
        const handler = (helper, beforeRegister = async () => {}, observedDb = binding, options = {}) => {
            const validate = async url => {
                await beforeRegister(url);
                if (options.checkRemote && ![...hooks.values()].some(hook => hook.url === url)) throw Object.assign(new Error('Synthetic remote HTTP404'), { code: 'AUTO_WATCH_INVALID_WEBHOOK', status: 404 });
                return { id: /webhooks\/(\d+)/.exec(url)?.[1], guildId: G, channelId: C };
            };
            const registerTarget = async input => {
                const result = await native.registerTarget(input, { validateWebhook: options.legacyVerifier || validate });
                await options.afterRegister?.(input, result);
                return result;
            };
            if (kind === 'auto') {
                const validated = { ...auto, validateWebhook: validate, registerTarget };
                return load('src/commands/handlers/autoextract/watch.js', { '../../../db': observedDb,
                    '../../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} }, '../../../providers/autoWatch/store': validated,
                    '../../../components/_webhookDestination': helper, '../../../errorTracking': { recordError: () => {} } });
            }
            const wrappedPrice = { ...price, registerTarget: async input => { if (input.destinationChannelId) await beforeRegister(input.webhookUrl); return registerTarget(input); } };
            const component = load('src/components/priceWatch.js', { '../db': observedDb, '../db_schema': { ...schema, ensureDatabaseSchema: async () => {} },
                '../providers/priceWatch/store': wrappedPrice, '../providers/autoWatch/store': { ...auto, validateWebhook: validate }, './_webhookDestination': helper, './_permissionCheck': { isAllowed: async () => true } });
            return Object.assign(component.handle, { modal: component.handleModal });
        };
        const input = webhookUrl => kind === 'auto'
            ? { userId: U, providerId: 'github', source: 'octocat', destinationType: 'webhook', webhookUrl, guildId: G, channelId: C, destinationChannelId: C }
            : { userId: U, providerId: 'steam', productUrl: 'https://store.steampowered.com/app/730', locale: 'ja', mode: 'change', destinationType: 'webhook', webhookUrl, guildId: G, channelId: C, destinationChannelId: C };
        return { db, binding, native, table, helperA, helperB, purpose, interaction, handler, input, hooks, trace, deleted, replies };
    } catch (error) { await db.close(); throw error; }
}

async function pendingNativeJob(f, kind, targetId) {
    const now = Date.now() + 1000, target = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [targetId]))[0];
    await f.db.queryDatabase(`UPDATE ${f.table} SET baseline_at_ms=?,created_at_ms=? WHERE id=?`, [now - 5000, now - 10000, targetId]);
    if (kind === 'auto') {
        await f.db.queryDatabase('UPDATE auto_watch_targets SET last_polled_at_ms=?,next_poll_at_ms=0,last_notification_window_at_ms=? WHERE id=?', [now - 86400000, now - 86400000, targetId]);
        const source = (await f.db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [target.source_id]))[0];
        await f.native.createItemsAndDeliveries(source, [{ contentId: 'legacy-pending-item', url: 'https://github.com/octocat/repo/commit/fixture', title: 'Keep this legacy notification', discoveredAtMs: now }], now);
    } else {
        await f.db.queryDatabase('UPDATE price_watch_sources SET lease_token=\'legacy-fixture\',lease_expires_at_ms=? WHERE id=?', [Date.now() + 60000, target.source_id]);
        const source = (await f.db.queryDatabase('SELECT * FROM price_watch_sources WHERE id=?', [target.source_id]))[0];
        await f.native.completeSource(source, { productName: 'Fixture', priceAmount: 500, currency: 'JPY' },
            [{ targetId, eventKey: 'legacy-pending-event', messageText: 'Keep this legacy price notification', event: { providerId: 'steam', kind: 'price', url: source.product_url, observedAtMs: now, priceAmount: 500, currency: 'JPY' } }],
            [{ targetId, ruleKey: target.rule_key, destinationKey: target.destination_key, configurationRevision: 7, conditionActive: true }], now, now + 60000);
    }
    const delivery = (await f.native.claimDueDeliveries(now, 1))[0]; assert(delivery);
    const queue = createQueue(f.db, {}, { clock: () => now }); assert.equal((await queue.route(kind, delivery, now)).state, 'routed');
    const job = (await f.db.queryDatabase('SELECT * FROM automation_jobs'))[0]; assert(job);
    return { queue, job, now };
}

for (const kind of ['auto', 'price']) {
    test(`S8 legacy ${kind}: an unknown deleted pre-change endpoint fails closed at capacity and explicit UI target-ID repair keeps the existing slot`, { skip: !port }, async () => {
        const f = await fixture(kind);
        try {
            const channel = f.interaction().channel, oldHook = await channel.createWebhook({ name: f.purpose });
            const legacy = await f.native.registerTarget({ ...f.input(oldHook.url), destinationChannelId: undefined });
            const original = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [legacy.id]))[0];
            assert.match(original.destination_key, /^webhook:/);
            for (let index = 0; index < 4; index++) await f.native.registerTarget({ ...f.input(null), destinationChannelId: undefined, destinationType: 'dm',
                ...(kind === 'auto' ? { source: `filler-${index}` } : { productUrl: `https://store.steampowered.com/app/${740 + index}` }) });
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 5);
            f.hooks.delete(oldHook.id);
            await f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true })(f.interaction());
            const feedback = JSON.stringify(f.replies.at(-1));
            assert(feedback.includes(`ID ${legacy.id}`)); assert.match(feedback, /既存の登録枠/); assert.doesNotMatch(feedback, /synthetic-token|https:|HTTP404/);
            const english = f.interaction(); english.locale = 'en-US';
            await f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true })(english);
            const englishFeedback = JSON.stringify(f.replies.at(-1));
            assert(englishFeedback.includes(`notification ID ${legacy.id}`)); assert.match(englishFeedback, /existing slot/); assert.doesNotMatch(englishFeedback, /synthetic-token|https:|HTTP404/);
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 5);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 5);
            assert.equal(String((await f.db.queryDatabase(`SELECT webhook_endpoint_id FROM ${f.table} WHERE id=?`, [legacy.id]))[0].webhook_endpoint_id), String(original.webhook_endpoint_id));
            // The notification UI explicitly edits the existing target ID and
            // chooses a newly verified resource; no former channel is inferred.
            const fresh = await channel.createWebhook({ name: 'ComebackTwitterEmbed Auto' }), service = createService(f.db);
            const actor = { userId: U, guildId: G, canView: true, canEdit: true };
            await f.db.queryDatabase('INSERT INTO webhook_endpoints (webhook_url_hash,webhook_url) VALUES (?,?)', [hash(fresh.url), fresh.url]);
            const endpoint = (await f.db.queryDatabase('SELECT id FROM webhook_endpoints WHERE webhook_url_hash=?', [hash(fresh.url)]))[0];
            const destination = await service.saveDestination(actor, { name: 'Replacement channel', kind: 'channel', scope: 'guild' },
                { webhookEndpointId: String(endpoint.id), guildId: G, channelId: C, createdByBot: true });
            const monitors = createMonitors(f.db, service, { verifyChannel: async (_actor, guildId, channelId) => {
                assert.equal(guildId, G); assert.equal(channelId, C); return { channel: { id: C, nsfw: false } };
            } });
            const repaired = await monitors.save(actor, kind, { expectedRevision: 1, name: 'Explicit repair', providerId: kind === 'auto' ? 'github' : 'steam',
                source: kind === 'auto' ? 'octocat' : 'https://store.steampowered.com/app/730', destinationId: destination.id, ...(kind === 'price' ? { mode: 'change' } : {}) }, legacy.id);
            assert.equal(repaired.id, legacy.id);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 5);
            assert.equal(String((await f.db.queryDatabase(`SELECT webhook_endpoint_id FROM ${f.table} WHERE id=?`, [legacy.id]))[0].webhook_endpoint_id), String(endpoint.id));
        } finally { await f.db.close(); }
    });

    test(`S8 legacy ${kind}: owned managed same-channel metadata repairs the old target/resource atomically without changing its legacy key or revision`, { skip: !port }, async () => {
        const f = await fixture(kind);
        try {
            const oldHook = await f.interaction().channel.createWebhook({ name: f.purpose });
            const legacy = await f.native.registerTarget({ ...f.input(oldHook.url), destinationChannelId: undefined });
            const original = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [legacy.id]))[0], service = createService(f.db);
            const destination = await service.saveDestination({ userId: U, guildId: G }, { name: 'Owned legacy destination', kind: 'webhook', scope: 'private' },
                { webhookEndpointId: String(original.webhook_endpoint_id), guildId: G, channelId: C, createdByBot: true });
            await f.db.queryDatabase('INSERT INTO automation_monitors (target_kind,target_id,name,scope,destination_id,revision) VALUES (?,?,?,\'private\',?,7)', [kind, legacy.id, 'Keep legacy title', destination.id]);
            for (let index = 0; index < 4; index++) await f.native.registerTarget({ ...f.input(null), destinationChannelId: undefined, destinationType: 'dm',
                ...(kind === 'auto' ? { source: `managed-filler-${index}` } : { productUrl: `https://store.steampowered.com/app/${750 + index}` }) });
            const pending = await pendingNativeJob(f, kind, legacy.id);
            f.hooks.delete(oldHook.id);
            const beforeResource = (await f.db.queryDatabase('SELECT webhook_endpoint_id,created_by_bot,revision,updated_at_ms FROM automation_destinations WHERE id=?', [destination.id]))[0];
            const transaction = f.binding.withDatabaseTransaction;
            f.binding.withDatabaseTransaction = work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (/INSERT INTO automation_audit/.test(sql) && params[3] === 'destination.channel-repair') throw new Error('Synthetic managed repair audit failure');
                return query(sql, params);
            }));
            await f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true })(f.interaction()).catch(error => { assert.match(error.message, /Synthetic managed repair audit failure/); });
            f.binding.withDatabaseTransaction = transaction;
            assert.deepEqual((await f.db.queryDatabase('SELECT webhook_endpoint_id,created_by_bot,revision,updated_at_ms FROM automation_destinations WHERE id=?', [destination.id]))[0], beforeResource);
            assert.equal(String((await f.db.queryDatabase(`SELECT webhook_endpoint_id FROM ${f.table} WHERE id=?`, [legacy.id]))[0].webhook_endpoint_id), String(original.webhook_endpoint_id));
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 5);
            await f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true })(f.interaction());
            const target = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [legacy.id]))[0], fresh = [...f.hooks.values()][0]; assert(fresh);
            assert.equal(target.destination_key, original.destination_key); assert.notEqual(String(target.webhook_endpoint_id), String(original.webhook_endpoint_id));
            const resource = (await f.db.queryDatabase('SELECT * FROM automation_destinations WHERE id=?', [destination.id]))[0];
            assert.equal(String(resource.webhook_endpoint_id), String(target.webhook_endpoint_id)); assert.equal(Number(resource.revision), 2);
            assert.equal(resource.owner_user_id, U); assert.equal(resource.guild_id, G); assert.equal(resource.channel_id, C);
            assert.equal(Number((await f.db.queryDatabase('SELECT revision FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, legacy.id]))[0].revision), 7);
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 5);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 5);
            assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE action='destination.channel-repair'"))[0].n), 1);
            assert.doesNotMatch(JSON.stringify(await f.db.queryDatabase('SELECT detail_json FROM automation_audit')), /synthetic-token/);
            const job = (await f.db.queryDatabase('SELECT state,plan_json FROM automation_jobs WHERE id=?', [pending.job.id]))[0];
            assert.equal(job.state, pending.job.state); assert.equal(job.plan_json, pending.job.plan_json);
            const claimed = await pending.queue.claim(pending.now), checked = await pending.queue.check(claimed, pending.now);
            assert.equal(checked.state, 'ready'); assert.equal(String(checked.destination.webhook_endpoint_id), String(target.webhook_endpoint_id));
        } finally { await f.db.close(); }
    });

    test(`S8 legacy ${kind}: healthy different-channel endpoints allow a new channel; dead endpoints and temporary verification failures remain distinct`, { skip: !port }, async () => {
        const f = await fixture(kind);
        try {
            const oldHook = await f.interaction().channel.createWebhook({ name: 'Different-channel legacy hook' });
            const legacy = await f.native.registerTarget({ ...f.input(oldHook.url), destinationChannelId: undefined });
            // This hook belongs to another channel and is therefore absent from
            // the selected channel's webhook enumeration, but its GET is valid.
            f.hooks.delete(oldHook.id);
            for (const status of [404, 503, 403, 429, undefined]) {
                await assert.rejects(f.native.registerTarget(f.input('https://discord.com/api/webhooks/777777777777777777/synthetic-new-token'), {
                    validateWebhook: async () => { throw Object.assign(new Error('Sensitive URL/token transport details'), { status, code: status ? 'AUTO_WATCH_INVALID_WEBHOOK' : 'ECONNRESET' }); },
                }), error => error.targetId === legacy.id && error.code === (status === 404 ? 'NATIVE_CHANNEL_REPAIR_REQUIRED' : 'NATIVE_CHANNEL_VERIFICATION_UNAVAILABLE') && !/Sensitive|token/.test(error.message));
            }
            for (const locale of ['ja', 'en-US']) {
                const interaction = f.interaction(); interaction.locale = locale;
                await f.handler(f.helperA, async () => {}, f.binding, { legacyVerifier: async () => { throw Object.assign(new Error('Sensitive transport details and token'), { status: 503 }); } })(interaction);
                const feedback = JSON.stringify(f.replies.at(-1));
                assert(feedback.includes(`ID ${legacy.id}`)); assert.match(feedback, locale === 'ja' ? /再試行/ : /Retry/); assert.doesNotMatch(feedback, /Sensitive|synthetic-token|https:/);
            }
            await f.handler(f.helperA, async () => {}, f.binding, { legacyVerifier: async () => ({ guildId: G, channelId: '999999999999999999' }) })(f.interaction());
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 2);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 2);
            assert.equal((await f.db.queryDatabase(`SELECT webhook_endpoint_id FROM ${f.table} WHERE id=?`, [legacy.id]))[0].webhook_endpoint_id, '1');
        } finally { await f.db.close(); }
    });

    test(`S8 legacy ${kind}: foreign or other-guild managed resources cannot prove an owned channel or be repointed`, { skip: !port }, async () => {
        const f = await fixture(kind);
        try {
            const oldHook = await f.interaction().channel.createWebhook({ name: f.purpose }), legacy = await f.native.registerTarget({ ...f.input(oldHook.url), destinationChannelId: undefined });
            const target = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [legacy.id]))[0], service = createService(f.db);
            const foreign = await service.saveDestination({ userId: '888888888888888888', guildId: G }, { name: 'Foreign destination', kind: 'webhook', scope: 'private' },
                { webhookEndpointId: String(target.webhook_endpoint_id), guildId: G, channelId: C, createdByBot: true });
            await f.db.queryDatabase('INSERT INTO automation_monitors (target_kind,target_id,name,scope,destination_id,revision) VALUES (?,?,?,\'private\',?,1)', [kind, legacy.id, 'Legacy destination', foreign.id]);
            f.hooks.delete(oldHook.id);
            for (const metadata of [{ owner: '888888888888888888', guild: G }, { owner: U, guild: '999999999999999999' }]) {
                await f.db.queryDatabase('UPDATE automation_destinations SET owner_user_id=?,guild_id=? WHERE id=?', [metadata.owner, metadata.guild, foreign.id]);
                await f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true })(f.interaction());
                assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 1);
                const row = (await f.db.queryDatabase('SELECT webhook_endpoint_id,revision FROM automation_destinations WHERE id=?', [foreign.id]))[0];
                assert.equal(String(row.webhook_endpoint_id), String(target.webhook_endpoint_id)); assert.equal(Number(row.revision), 1);
            }
        } finally { await f.db.close(); }
    });

    test(`ROUND1 ${kind}: an existing-URL adopter revalidates after a failed creator's partial SQL rollback instead of committing its deleted hook`, { skip: !port }, async () => {
        const f = await fixture(kind), registered = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
        try {
            const creator = f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true, afterRegister: async () => {
                registered.resolve(); await release.promise; throw Object.assign(new Error('Failure after partial native SQL before outer COMMIT'), { code: 'AUTOMATION_SLOT_LIMIT' });
            } });
            const a = creator(f.interaction()).catch(error => error); pending.push(a); await registered.promise;
            const hook = [...f.hooks.values()][0];
            const observedDb = { ...f.binding, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (/INSERT IGNORE INTO automation_counters/.test(sql)) secondStarted.resolve();
                return query(sql, params);
            })) };
            const direct = f.handler(f.helperB, async () => {}, observedDb, { checkRemote: true }), interaction = f.interaction();
            interaction.options.getString = key => ({ provider: 'github', source: 'octocat', destination: 'webhook', webhook: hook.url })[key] || null;
            interaction.customId = `priceWatchModal:change:webhook:s:app:730:ja:${M}`;
            interaction.deferReply = async () => {}; interaction.fields = { getTextInputValue: () => hook.url };
            const directReplies = []; interaction.editReply = async payload => { directReplies.push(payload); };
            const b = (kind === 'price' ? direct.modal(interaction) : direct(interaction)).catch(error => error); pending.push(b);
            await secondStarted.promise; release.resolve(); await Promise.all(pending);
            assert(f.deleted.includes(hook.id)); assert.equal(f.hooks.has(hook.id), false);
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 0);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
            assert.match(JSON.stringify(directReplies.at(-1)), /Webhook/);
            assert.doesNotMatch(JSON.stringify(directReplies.at(-1)), /synthetic-token|HTTP404/);
        } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
    });

    test(`ROUND1 ${kind}: full channel lifecycle serializes across helper instances and failed creators cannot delete the later registration`, { skip: !port }, async () => {
        const f = await fixture(kind), entered = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
        try {
            const first = f.handler(f.helperA, async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('Fixture admission failed'), { code: 'AUTOMATION_SLOT_LIMIT' }); });
            const a = first(f.interaction()).catch(error => error);
            pending.push(a);
            await entered.promise;
            const initialHook = [...f.hooks.values()][0];
            const observedDb = { ...f.binding, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
                if (/INSERT IGNORE INTO automation_counters/.test(sql)) secondStarted.resolve();
                return query(sql, params);
            })) };
            const second = f.handler(f.helperB, async () => {}, observedDb), b = second(f.interaction());
            pending.push(b);
            await secondStarted.promise;
            assert.equal(f.trace.filter(action => action === 'lookup').length, 1, 'B has entered real SQL but cannot fetch/adopt A before its transaction ends');
            release.resolve(); await Promise.all([a, b]);
            assert.deepEqual(f.deleted, [initialHook.id]);
            const rows = await f.db.queryDatabase(`SELECT t.id,t.enabled,w.webhook_url FROM ${f.table} t JOIN webhook_endpoints w ON w.id=t.webhook_endpoint_id`);
            assert.equal(rows.length, 1); assert.equal(Number(rows[0].enabled), 1);
            const surviving = [...f.hooks.values()][0]; assert(surviving); assert.notEqual(surviving.id, initialHook.id); assert.equal(rows[0].webhook_url, surviving.url);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 1);
        } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
    });

    test(`ROUND1 ${kind}: a concurrently committed direct registration preserves the shared hook when its creator fails`, { skip: !port }, async () => {
        const f = await fixture(kind), entered = deferred(), release = deferred(), pending = [];
        try {
            const first = f.handler(f.helperA, async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('Fixture validation failure'), { code: 'AUTOMATION_SLOT_LIMIT' }); });
            const a = first(f.interaction()).catch(error => error); pending.push(a); await entered.promise;
            const hook = [...f.hooks.values()][0];
            const committed = await f.native.registerTarget(f.input(hook.url));
            release.resolve(); await a;
            assert.deepEqual(f.deleted, []); assert.equal(f.hooks.get(hook.id), hook);
            assert.equal(String((await f.db.queryDatabase(`SELECT id FROM ${f.table}`))[0].id), committed.id);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 1);
        } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
    });

    test(`ROUND1 ${kind}: unused hook cleanup rolls back partial registration, while COMMIT acknowledgement uncertainty retains a committed hook`, { skip: !port }, async () => {
        const f = await fixture(kind);
        try {
            await assert.rejects(f.helperA.withWebhookForChannel(f.interaction(), C, f.purpose, async created => {
                await f.native.registerTarget(f.input(created.webhookUrl)); throw new Error('Failure before outer commit');
            }, { db: f.binding }), /Failure before outer commit/);
            assert.equal(f.hooks.size, 0); assert.equal(f.deleted.length, 1);
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 0);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
            const uncertain = { ...f.binding, withDatabaseTransaction: async work => { await f.db.withDatabaseTransaction(work); throw new Error('COMMIT acknowledgement lost'); } };
            await assert.rejects(f.helperB.withWebhookForChannel(f.interaction(), C, f.purpose, created => f.native.registerTarget(f.input(created.webhookUrl)), { db: uncertain }), /COMMIT acknowledgement lost/);
            assert.equal(f.hooks.size, 1); assert.equal(f.deleted.length, 1);
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 1);
        } finally { await f.db.close(); }
    });

    test(`ROUND1 ${kind}: replacing a deleted channel hook preserves target/settings/slot/revision and pending jobs use the repaired endpoint`, { skip: !port }, async () => {
        const f = await fixture(kind);
        try {
            const run = f.handler(f.helperA); await run(f.interaction());
            const oldHook = [...f.hooks.values()][0], now = Date.now() + 1000;
            const target = (await f.db.queryDatabase(`SELECT * FROM ${f.table}`))[0];
            await f.db.queryDatabase('INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,\'private\',7)', [kind, target.id, 'Keep my name']);
            await f.db.queryDatabase(`UPDATE ${f.table} SET baseline_at_ms=?,created_at_ms=? WHERE id=?`, [now - 5000, now - 10000, target.id]);
            if (kind === 'auto') {
                await f.db.queryDatabase('UPDATE auto_watch_targets SET last_polled_at_ms=?,next_poll_at_ms=0,last_notification_window_at_ms=? WHERE id=?', [now - 86400000, now - 86400000, target.id]);
                const source = (await f.db.queryDatabase('SELECT * FROM auto_watch_sources WHERE id=?', [target.source_id]))[0];
                await f.native.createItemsAndDeliveries(source, [{ contentId: 'retained-discovery', url: 'https://github.com/octocat/repo/commit/fixture', title: 'Keep this pending event', discoveredAtMs: now }], now);
            } else {
                await f.db.queryDatabase('UPDATE price_watch_sources SET lease_token=\'fixture\',lease_expires_at_ms=? WHERE id=?', [Date.now() + 60000, target.source_id]);
                const source = (await f.db.queryDatabase('SELECT * FROM price_watch_sources WHERE id=?', [target.source_id]))[0];
                await f.native.completeSource(source, { productName: 'Fixture', priceAmount: 500, currency: 'JPY' },
                    [{ targetId: target.id, eventKey: 'retained-price-event', messageText: 'Keep this pending price event', event: { providerId: 'steam', kind: 'price', url: source.product_url, observedAtMs: now, priceAmount: 500, currency: 'JPY' } }],
                    [{ targetId: target.id, ruleKey: target.rule_key, destinationKey: target.destination_key, configurationRevision: 7, conditionActive: true }], now, now + 60000);
            }
            const delivery = (await f.native.claimDueDeliveries(now, 1))[0]; assert(delivery);
            const queue = createQueue(f.db, {}, { clock: () => now });
            assert.equal((await queue.route(kind, delivery, now)).state, 'routed');
            const pending = (await f.db.queryDatabase('SELECT * FROM automation_jobs'))[0]; assert(pending);
            const before = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [target.id]))[0];
            const beforeSlot = await f.db.queryDatabase('SELECT * FROM automation_notification_slots');
            // Simulate an administrator removing the remote hook. No Discord
            // request is made; the following actual helper must create a new one.
            f.hooks.delete(oldHook.id);
            await run(f.interaction());
            const fresh = [...f.hooks.values()][0], after = (await f.db.queryDatabase(`SELECT * FROM ${f.table} WHERE id=?`, [target.id]))[0];
            assert(fresh); assert.notEqual(fresh.id, oldHook.id); assert.notEqual(String(after.webhook_endpoint_id), String(before.webhook_endpoint_id));
            for (const key of ['id', 'source_id', 'destination_key', 'baseline_at_ms', 'created_at_ms', 'enabled', ...(kind === 'auto' ? ['last_polled_at_ms', 'next_poll_at_ms', 'last_notification_window_at_ms'] : ['watch_mode', 'rule_key', 'max_price_amount', 'min_discount_percent', 'condition_active'])]) assert.equal(after[key], before[key], key);
            assert.deepEqual(await f.db.queryDatabase('SELECT * FROM automation_notification_slots'), beforeSlot);
            const metadata = (await f.db.queryDatabase('SELECT name,revision FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, target.id]))[0];
            assert.equal(metadata.name, 'Keep my name'); assert.equal(Number(metadata.revision), 7);
            assert.equal(Number((await f.db.queryDatabase(`SELECT COUNT(*) n FROM ${f.table}`))[0].n), 1);
            const job = (await f.db.queryDatabase('SELECT * FROM automation_jobs WHERE id=?', [pending.id]))[0];
            assert.equal(job.state, pending.state); assert.equal(job.plan_json, pending.plan_json);
            const claimed = await queue.claim(now); assert.equal(claimed.id, pending.id);
            const checked = await queue.check(claimed, now);
            assert.equal(checked.state, 'ready'); assert.equal(String(checked.destination.webhook_endpoint_id), String(after.webhook_endpoint_id));
            assert.equal((await f.db.queryDatabase('SELECT webhook_url FROM webhook_endpoints WHERE id=?', [checked.destination.webhook_endpoint_id]))[0].webhook_url, fresh.url);
            // Confirmation failures occur only after the surrounding transaction
            // commits, so they retain the repaired endpoint and its active row.
            await run(f.interaction(true)).catch(error => { assert.equal(error.code, 'ETIMEDOUT'); });
            assert.equal(f.hooks.get(fresh.id), fresh);
        } finally { await f.db.close(); }
    });
}

test('ROUND1 dashboard: an existing-URL destination waits for channel creation and rejects a hook deleted by partial native SQL rollback', { skip: !port }, async () => {
    const f = await fixture('auto'), registered = deferred(), release = deferred(), secondStarted = deferred(), pending = [];
    try {
        const creator = f.handler(f.helperA, async () => {}, f.binding, { checkRemote: true, afterRegister: async () => {
            registered.resolve(); await release.promise; throw Object.assign(new Error('Creator failed after native SQL'), { code: 'AUTOMATION_SLOT_LIMIT' });
        } });
        const a = creator(f.interaction()).catch(error => error); pending.push(a); await registered.promise;
        const hook = [...f.hooks.values()][0], observedDb = { ...f.binding, withDatabaseTransaction: work => f.db.withDatabaseTransaction(query => work(async (sql, params) => {
            if (/INSERT IGNORE INTO automation_counters/.test(sql)) secondStarted.resolve();
            return query(sql, params);
        })) };
        const destinations = createDestinations(observedDb, createService(f.db), { rest: async route => {
            if (route.startsWith('/webhooks/')) {
                if (!f.hooks.has(hook.id)) throw Object.assign(new Error('Synthetic missing webhook URL must not leak'), { status: 404 });
                return { data: { id: hook.id, type: 1, guild_id: G, channel_id: C } };
            }
            if (route === `/guilds/${G}`) return { data: { id: G, owner_id: U } };
            if (route === `/guilds/${G}/roles`) return { data: [{ id: G, permissions: '536873984' }] };
            if (route === `/guilds/${G}/members/${U}`) return { data: { user: { id: U }, roles: [] } };
            if (route === '/users/@me') return { data: { id: B } };
            if (route === `/channels/${C}`) return { data: { id: C, guild_id: G, type: 0, permission_overwrites: [] } };
            assert.fail(`Unexpected synthetic Discord request: ${route}`);
        } });
        const b = destinations.save({ userId: U, guildId: G, canView: true, canEdit: true }, { name: 'Direct webhook', kind: 'webhook', webhookUrl: hook.url, scope: 'private' }).catch(error => error);
        pending.push(b); await secondStarted.promise; release.resolve(); const [, failure] = await Promise.all(pending);
        assert.equal(failure.code, 'DISCORD_ACCESS_DENIED'); assert.equal(failure.status, 403);
        assert.doesNotMatch(failure.message, /synthetic-token|Synthetic|URL/);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_destinations'))[0].n), 0);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_targets'))[0].n), 0);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});

test('ROUND1 cleanup preserves an already committed managed destination reference', { skip: !port }, async () => {
    const f = await fixture('auto'), entered = deferred(), release = deferred(), pending = [];
    try {
        const creator = f.handler(f.helperA, async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('Creator validation failed'), { code: 'AUTOMATION_SLOT_LIMIT' }); });
        const a = creator(f.interaction()).catch(error => error); pending.push(a); await entered.promise;
        const hook = [...f.hooks.values()][0], service = createService(f.db);
        // A trusted, separately committed destination is authoritative even
        // though this unrelated creator has not completed its own registration.
        const saved = await f.db.withDatabaseTransaction(async query => {
            await query('INSERT INTO webhook_endpoints (webhook_url_hash,webhook_url) VALUES (?,?)', [hash(hook.url), hook.url]);
            const endpoint = (await query('SELECT id FROM webhook_endpoints WHERE webhook_url_hash=?', [hash(hook.url)]))[0];
            return service.saveDestination({ userId: U, guildId: G }, { name: 'Retained destination', kind: 'webhook', scope: 'private' },
                { webhookEndpointId: String(endpoint.id), guildId: G, channelId: C, createdByBot: false });
        });
        release.resolve(); await a;
        assert.equal(f.hooks.get(hook.id), hook); assert.deepEqual(f.deleted, []);
        assert.equal((await f.db.queryDatabase('SELECT id FROM automation_destinations'))[0].id, saved.id);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.db.close(); }
});
