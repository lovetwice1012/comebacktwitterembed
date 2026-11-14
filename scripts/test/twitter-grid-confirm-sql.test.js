'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const gallery = require('../../src/mediaGallery'), cards = require('../../src/twitterGridCards'), confirm = require('../../src/components/twitterGridConfirm');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');
const gid = '333333333333333333', cid = '444444444444444444', mid = '555555555555555555', tail = '666666666666666666';
const uid = '111111111111111111', bot = '222222222222222222';
async function fixture() {
    const db = await createTestDatabase(port);
    const sql = fs.readFileSync(path.join(schema.MIGRATIONS_DIR, '20260922_add_link_presentation.sql'), 'utf8');
    await db.queryDatabase(schema._internal.splitSqlStatements(sql).find(s => /CREATE TABLE IF NOT EXISTS bot_media_galleries/.test(s)));
    const storage = gallery.createStore(db), images = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/p${i}.jpg`);
    const firstPart = { imageUrls: images.slice(0, 10), sequence: 0, totalParts: 2 }, secondPart = { imageUrls: images.slice(10), sequence: 1, totalParts: 2 };
    const input = { guildId: gid, channelId: cid, author: { id: uid } };
    const result = await cards.prepare({ components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Delete', custom_id: 'delete' }] }], twitterGrid: firstPart }, input,
        { providerId: 'twitter', presentationSettings: { enabled: true } }, storage, { twitterGrid: secondPart });
    const [item] = result.grids;
    const first = { id: mid, channelId: cid, guildId: gid, author: { id: bot }, content: 'fixture', embeds: [{ title: 'source' }, { title: 'quote' }],
        attachments: new Map(), components: result.step.components };
    const second = { id: tail, channelId: cid, guildId: gid, author: { id: bot }, content: '', embeds: [], attachments: new Map(), components: [] };
    assert.equal(await cards.bind(item, first, storage, db, firstPart), true);
    assert.equal(await cards.append(item, secondPart, second, db), true);
    assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
    const channel = { id: cid, guildId: gid, messages: { fetch: async ({ message }) => message === mid ? first : second } };
    const client = { user: { id: bot } }, access = { channel, member: { _roles: [] }, permissions: { has: () => true } };
    let view, executed = 0;
    const deps = { db, storage, freshAccess: async () => access, getSettings: async () => ({ enabled: true, button_invisible: {}, button_disabled: {} }),
        handlers: { delete: { handle: async () => { executed++; } } }, buildButtons: () => ({}) };
    const original = { guildId: gid, channelId: cid, user: { id: uid }, client, locale: 'ja', customId: `delete:sl1:${item.id}`, message: first, channel, deferred: true, ephemeral: true,
        editReply: async data => { view = data; } };
    const click = token => { const interaction = { guildId: gid, channelId: cid, user: { id: uid }, client, locale: 'ja', customId: token,
        message: { ephemeral: true }, channel, deferReply: async () => { interaction.deferred = true; interaction.ephemeral = true; } }; return interaction; };
    const offer = async () => { await confirm.offer(original, deps); return view.components[0].components[0].custom_id; };
    return { db, item, first, second, click, offer, deps, get executed() { return executed; } };
}
test('a confirmed split action checks the actual SQL rows and runs once', { timeout: 60000 }, async () => {
    const f = await fixture();
    try { const token = await f.offer(); await confirm.confirm(f.click(token), f.deps); assert.equal(f.executed, 1); }
    finally { await f.db.close(); }
});
test('real SQL unset, NULL and explicit enabled values govern private confirmation', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const { SETTINGS_PATH, TARGET_TABLES, compileSettings } = require('../benchmark_main_settings');
        const { TABLES } = require('../../src/db_schema');
        const provider = require('../../src/providers/twitter');
        const grid = require('../../src/components/twitterGrid');
        await f.db.queryDatabase(`CREATE TABLE ${TABLES.guildProviderSettings} (provider_id VARCHAR(32), guild_id VARCHAR(32), enabled TINYINT NULL, PRIMARY KEY(provider_id,guild_id))`);
        for (const table of new Set(Object.values(TARGET_TABLES))) {
            await f.db.queryDatabase(`CREATE TABLE ${table} (provider_id VARCHAR(32), guild_id VARCHAR(32), target_type VARCHAR(32), target_id VARCHAR(32))`);
        }
        await f.db.queryDatabase(`CREATE TABLE ${TABLES.guildProviderBannedWords} (provider_id VARCHAR(32), guild_id VARCHAR(32), word VARCHAR(255))`);
        await f.db.queryDatabase(`CREATE TABLE ${TABLES.guildProviderButtonVisibility} (provider_id VARCHAR(32), guild_id VARCHAR(32), button_key VARCHAR(32), hidden TINYINT)`);
        const settings = compileSettings(fs.readFileSync(SETTINGS_PATH, 'utf8'), f.db.queryDatabase);
        f.deps.getSettings = async (input, guild) => {
            assert.equal(input, provider, 'security checks must use the registered provider defaults');
            return settings.getFreshProviderSettings(input, guild);
        };
        for (const value of ['absent', null, 0, 1]) {
            await f.db.queryDatabase(`DELETE FROM ${TABLES.guildProviderSettings}`);
            if (value !== 'absent') await f.db.queryDatabase(`INSERT INTO ${TABLES.guildProviderSettings} VALUES (?,?,?)`, ['twitter', gid, value]);
            const actual = await settings.getFreshProviderSettings(provider, gid);
            assert.equal(actual.enabled, value !== 0, `enabled=${value}`);
            const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
            const payload = JSON.parse(rows[0].payload_json);
            payload.settingsHash = cards.safetyHash(actual);
            payload.settingsPolicyHash = cards.safetyPolicyHash(actual);
            await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.item.id]);
            let gridView;
            const gridClick = f.click(`tg:${f.item.id}:0:open`);
            gridClick.message = f.first;
            gridClick.memberPermissions = { has: () => true };
            gridClick.editReply = async result => { gridView = result; };
            await grid.handle(gridClick, { ...f.deps, isAllowed: async () => true });
            assert.equal(Boolean(gridView.components?.length), value !== 0, `grid enabled=${value}`);
            if (value === 0) await assert.rejects(f.offer(), /GRID_SOURCE_CHANGED/);
            else {
                const token = await f.offer(), before = f.executed;
                await confirm.confirm(f.click(token), f.deps);
                assert.equal(f.executed, before + 1, `enabled=${value}`);
            }
        }
    } finally { await f.db.close(); }
});
test('a persisted legacy split survives benign setting changes but not changed image safety', { timeout: 60000 }, async () => {
    const f = await fixture(), grid = require('../../src/components/twitterGrid');
    try {
        const original = { enabled: true, defaultLanguage: 'ja', silent_expansion: false, show_previous_shares: true,
            editOriginalIfTranslate: false, media_display_mode: 'embed', hidden_output_items: [], button_invisible: {},
            button_disabled: { user: [], role: [], channel: [] } };
        let settings = { ...original, defaultLanguage: 'en-US', silent_expansion: true };
        f.deps.getSettings = async () => settings;
        const rows = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        const payload = JSON.parse(rows[0].payload_json);
        payload.settingsHash = cards.safetyHash(original);
        delete payload.settingsPolicyHash; // A gallery created by the deployed legacy version.
        await f.db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), f.item.id]);
        const click = f.click(`tg:${f.item.id}:0:open`);
        click.message = f.first; click.memberPermissions = { has: () => true };
        let view; click.editReply = async result => { view = result; };
        await grid.handle(click, { ...f.deps, isAllowed: async () => true });
        assert.ok(view.components?.length);
        settings = { ...settings, media_display_mode: 'link_only' };
        await grid.handle(click, { ...f.deps, isAllowed: async () => true });
        assert.equal(view.components?.length || 0, 0);
        const [after] = await f.db.queryDatabase('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        assert.equal(JSON.parse(after.payload_json).settingsHash, payload.settingsHash, 'legacy hash is not rewritten');
    } finally { await f.db.close(); }
});
test('a source changed while confirmation waits for the SQL lock is not acted on', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const token = await f.offer(); let release, entered;
        const gate = new Promise(resolve => { release = resolve; }), locked = new Promise(resolve => { entered = resolve; });
        const holder = f.db.withDatabaseTransaction(async query => { await query('SELECT gallery_id FROM bot_media_galleries WHERE gallery_id=? FOR UPDATE', [f.item.id]); entered(); await gate; });
        await locked;
        const action = confirm.confirm(f.click(token), f.deps).then(() => null, error => error);
        await new Promise(resolve => setTimeout(resolve, 100));
        f.first.embeds[1].description = 'changed quote'; release(); await holder;
        assert.match((await action).message, /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
    } finally { await f.db.close(); }
});
test('a continuation changed after the preview is not acted on', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const token = await f.offer(); f.second.content = 'changed continuation';
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED/); assert.equal(f.executed, 0);
    } finally { await f.db.close(); }
});
test('a record removed after the preview cannot authorize the action', { timeout: 60000 }, async () => {
    const f = await fixture();
    try {
        const token = await f.offer(); await f.db.queryDatabase('DELETE FROM bot_media_galleries WHERE gallery_id=?', [f.item.id]);
        await assert.rejects(confirm.confirm(f.click(token), f.deps), /GRID_SOURCE_CHANGED|GRID_LOCK_UNAVAILABLE/); assert.equal(f.executed, 0);
    } finally { await f.db.close(); }
});
