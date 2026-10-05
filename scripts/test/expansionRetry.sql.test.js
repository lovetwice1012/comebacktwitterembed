'use strict';

// Explicit local test DB only; the helper refuses port 3306 and creates/drops
// its own random fixture schema. No Bot, Discord or production DB connection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const { TABLES, SCHEMA_STATEMENTS, MIGRATIONS_DIR, _internal: schemaInternals } = require('../../src/db_schema');

const port = Number(process.env.EXPANSION_TEST_DB_PORT || 0);
test('expansion retry uses real SQL scope locks, atomic reservations and indexed history', { skip: !port }, async t => {
    const db = await createTestDatabase(port);
    const storePath = require.resolve('../../src/expansionTraceStore');
    const dbPath = require.resolve('../../src/db');
    const originals = new Map([storePath, dbPath].map(file => [file, require.cache[file]]));
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    delete require.cache[storePath];
    const store = require(storePath);
    const message = id => ({ id, guildId: 'guild', channelId: 'channel', author: { id: 'author' } });
    const match = id => ({ provider: { id: 'twitter' }, url: `https://x.com/author/status/${id}` });
    async function seed(source, input = {}) {
        const { url = match('1').url, state = 'failed', outcome = 'extract_failed', output = null, delivery = null, at = Date.now() - 60000 } = input;
        await db.queryDatabase(`INSERT INTO ${TABLES.botProviderExpansionTraces}
            (trace_id,boot_id,state,outcome,created_at_ms,updated_at_ms,provider_id,raw_url,guild_id,channel_id,message_id,output_json,delivery_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), 'fixture', state, outcome, at, at, 'twitter', url,
            source.guildId, source.channelId, source.id, output, delivery]);
    }
    try {
        await db.queryDatabase(SCHEMA_STATEMENTS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLES.botProviderExpansionTraces} (`)));
        await t.test('the message index migration upgrades an existing table and is safely skipped afterward', async () => {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '20260922_add_expansion_trace_message_index.sql'), 'utf8').trim();
            await db.queryDatabase(`ALTER TABLE ${TABLES.botProviderExpansionTraces} DROP INDEX idx_expansion_trace_message`);
            assert.equal(await schemaInternals.shouldSkipMigrationStatement(db.queryDatabase, sql), false);
            await db.queryDatabase(sql);
            assert.equal(await schemaInternals.shouldSkipMigrationStatement(db.queryDatabase, sql), true);
        });
        await t.test('concurrent retries reserve only once and preserve the original failed trace', async () => {
            const source = message('concurrent'); await seed(source);
            const results = await Promise.all(Array.from({ length: 8 }, () => store.reserveExpansionRetries(source, [match('1')], 'boot')));
            assert.deepEqual(results.map(result => result.length).sort(), [0, 0, 0, 0, 0, 0, 0, 1]);
            const rows = await store.getMessageExpansionTraces(source);
            assert.equal(rows.length, 2);
            assert.deepEqual(rows.map(row => row.state).sort(), ['failed', 'queued']);
            assert.ok(rows.every(row => row.has_output === 0 && row.has_delivery === 0));
            assert.equal((await store.getMessageExpansionTraces({ ...source, guildId: 'other' })).length, 0);
            assert.equal((await store.getMessageExpansionTraces({ ...source, channelId: 'other' })).length, 0);
            const plan = await db.queryDatabase(`EXPLAIN SELECT trace_id FROM ${TABLES.botProviderExpansionTraces}
                WHERE guild_id=? AND channel_id=? AND message_id=? ORDER BY created_at_ms DESC LIMIT 101`, ['guild', 'channel', source.id]);
            assert.match(String(plan[0].possible_keys), /idx_expansion_trace_message/);
        });
        await t.test('earlier success through an X alias blocks only that content', async () => {
            const source = message('mixed');
            await seed(source, { url: 'https://twitter.com/old/status/1?s=20', state: 'completed', outcome: 'F', delivery: '{"sent":[{"message_id":"sent"}]}' });
            await seed(source); await seed(source, { url: match('2').url });
            const selected = await store.reserveExpansionRetries(source, [match('1'), match('2')], 'boot');
            assert.deepEqual(selected.map(item => item.url), [match('2').url]);
        });
        await t.test('a failed multi-link reservation rolls back every new trace', async () => {
            const source = message('rollback'); await seed(source); await seed(source, { url: match('2').url });
            const transaction = db.withDatabaseTransaction;
            const active = [...store._internal.activeTraceIds];
            let inserts = 0;
            db.withDatabaseTransaction = work => transaction(query => work((sql, ...args) => {
                if (/^INSERT INTO bot_provider_expansion_traces/.test(sql) && ++inserts === 2) throw new Error('synthetic second insert failure');
                return query(sql, ...args);
            }));
            try { await assert.rejects(store.reserveExpansionRetries(source, [match('1'), match('2')], 'boot'), /second insert failure/); }
            finally { db.withDatabaseTransaction = transaction; }
            assert.equal((await store.getMessageExpansionTraces(source)).length, 2);
            assert.deepEqual([...store._internal.activeTraceIds], active);
            assert.equal((await store.reserveExpansionRetries(source, [match('1'), match('2')], 'boot')).length, 2);
        });
        await t.test('history limits, unknown delivery, recent failures and generated output prevent retries', async () => {
            for (const [id, data] of [
                ['recent', { at: Date.now() }], ['interrupted', { state: 'interrupted' }],
                ['generated', { output: '{}' }], ['delivery', { delivery: '{"attempts":[{"outcome":"delivery_unknown"}]}' }],
            ]) {
                const source = message(id); await seed(source, data);
                assert.deepEqual(await store.reserveExpansionRetries(source, [match('1')], 'boot'), []);
            }
            const source = message('many');
            for (let i = 0; i < 102; i++) await seed(source);
            assert.equal((await store.getMessageExpansionTraces(source)).length, 101);
            assert.deepEqual(await store.reserveExpansionRetries(source, [match('1')], 'boot'), []);
        });
        await t.test('each manual action reserves at most five links', async () => {
            const source = message('bounded');
            const matches = Array.from({ length: 7 }, (_, i) => match(String(i + 10)));
            for (const item of matches) await seed(source, { url: item.url });
            assert.equal((await store.reserveExpansionRetries(source, matches, 'boot')).length, 5);
            assert.equal((await store.getMessageExpansionTraces(source)).length, 12);
        });
        await t.test('registered Discord menu retries a silent failure through the normal pipeline exactly once', async () => {
            const { Events, InteractionType } = require('discord.js');
            let failing = true, sends = 0, memberFetches = 0;
            const errors = [], replies = [], deferrals = [], listeners = new Map();
            const provider = { id: 'twitter', extract: async () => {
                if (failing) return require('../../src/providers/_output_controls').buildFailureResponse('twitter', match('99').url,
                    { failure_display_policy: 'silent' }, { status: 503, message: 'fixture upstream failure' });
                return [{ content: 'expanded fixture', allowedMentions: { parse: [] } }];
            } };
            const mocks = {
                '../../src/providers/_loader': { extractAllUrls: () => [{ provider, url: match('99').url }], cleanContent: value => value, loadProviders: () => [], loadProviderCommands: () => [] },
                '../../src/providers/_provider_settings': { ...require('../../src/providers/_provider_settings'), getProviderSettings: async () => ({ enabled: true }) },
                '../../src/providers/_dispatcher': { runSendSteps: async () => { sends++; return { outcome: 'F', sent: [{ stepIndex: 0, messageId: 'delivered', channelId: 'channel' }], attempts: [{ stepIndex: 0, outcome: 'confirmed' }], postprocess: [] }; } },
                '../../src/delegatedAccess': { applyDelegatedEditPermissions: async () => () => {} },
                '../../src/errorTracking': { recordError: error => errors.push(error), recordMetric() {}, recordAnalyticsEvent() {}, recordProviderContentEvent() {} },
                '../../src/adminSupport/inspect': { hash: () => 'fixture-settings-hash' },
            };
            const modules = ['../../src/handlers/messageCreate', '../../src/handlers/applicationCommands', '../../src/commands/handlers/messageExpansion', ...Object.keys(mocks)];
            const saved = new Map(modules.map(name => { const filename = require.resolve(name); return [filename, require.cache[filename]]; }));
            try {
                for (const [name, exports] of Object.entries(mocks)) {
                    const filename = require.resolve(name);
                    require.cache[filename] = { id: filename, filename, loaded: true, exports };
                }
                for (const name of modules.slice(0, 3)) delete require.cache[require.resolve(name)];
                const client = { user: { id: 'bot' }, on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); } };
                const source = { ...message('menu'), content: match('99').url, channel: { id: 'channel' },
                    guild: { id: 'guild', members: { fetch: async () => { memberFetches++; return { roles: { cache: new Map() } }; } } },
                    member: { roles: { cache: new Map() } } };
                require('../../src/handlers/messageCreate').register(client);
                require('../../src/handlers/applicationCommands').register(client);
                for (const listener of listeners.get(Events.MessageCreate)) await listener(source);
                const [failed] = await store.getMessageExpansionTraces(source);
                assert.equal(failed.outcome, 'extract_failed');
                assert.equal(JSON.parse(failed.error_json).status, 503);
                await db.queryDatabase(`UPDATE ${TABLES.botProviderExpansionTraces} SET updated_at_ms=? WHERE trace_id=?`, [Date.now() - 60000, failed.trace_id]);
                failing = false;
                const interaction = { type: InteractionType.ApplicationCommand, commandType: 3, commandName: 'Retry expansion',
                    guildId: 'guild', channelId: 'channel', locale: 'ja', targetId: source.id, user: { id: 'author' },
                    channel: { messages: { fetch: async () => source } }, memberPermissions: { has: () => true },
                    deferReply: async value => deferrals.push(value), editReply: async value => replies.push(value) };
                for (const listener of listeners.get(Events.InteractionCreate)) await listener(interaction);
                assert.equal(sends, 1);
                assert.equal(memberFetches, 1);
                assert.deepEqual(deferrals, [{ ephemeral: true }]);
                assert.match(replies[0].embeds[0].description, /展開済み/);
                for (const listener of listeners.get(Events.InteractionCreate)) await listener(interaction);
                assert.equal(sends, 1, 'A repeated menu action must not resend a confirmed delivery');
                assert.match(replies[1].embeds[0].description, /再試行できるリンクはありません/);
                assert.equal((await store.getMessageExpansionTraces(source)).length, 2);
                assert.deepEqual(errors, []);
            } finally {
                for (const [filename, original] of saved) {
                    if (original) require.cache[filename] = original;
                    else delete require.cache[filename];
                }
            }
        });
    } finally {
        for (const [file, original] of originals) {
            if (original) require.cache[file] = original;
            else delete require.cache[file];
        }
        await db.close();
    }
});
