'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { PermissionsBitField } = require('discord.js');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const schema = require('../../src/db_schema');
const { fetchPrice } = require('../../src/providers/priceWatch');
const priceRunner = require('../../src/providers/priceWatch/runner');
const { normalizeRule } = require('../../src/providers/priceWatch/store');
const { fetchSource } = require('../../src/providers/autoWatch');
const root = path.resolve(__dirname, '../..');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const { _internal: runner } = load('src/providers/autoWatch/runner.js', { '../../errorTracking': { recordError: () => {} } });

function load(relative, replacements = {}) {
    const filename = path.join(root, relative), native = createRequire(filename), mod = { exports: {} };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
        id => Object.hasOwn(replacements, id) ? replacements[id] : native(id), mod, mod.exports);
    return mod.exports;
}

function memorySource() {
    return { id: '1', provider_id: 'github', source_key: 'octocat', initialized_at_ms: 1,
        cursor_json: '{"seenContentIds":[],"admissionVersion":1}', failure_count: 0 };
}

test('T1 rolling observations drain complete durable payloads with immutable timestamps and no duplicate IDs', async () => {
    let saved = memorySource(), items = [], savedItems = [], failure;
    const store = { computedPollInterval: () => 30000, policyFor: () => ({}), reserveProviderRequest: async () => ({ allowed: true }),
        recordProviderRateLimit: async () => {}, atomicSourceCompletion: true,
        completeSource: async (_source, result) => { savedItems.push(...result.items || []); saved = { ...saved, cursor_json: JSON.stringify(result.cursor) }; },
        failSource: async (_source, result) => { failure = result; } };
    const run = now => runner.processSource(structuredClone(saved), { now, store, config: {}, sourceCounts: new Map(), fetchSource: async () => ({ items, state: {} }) });
    const page = prefix => Array.from({ length: 100 }, (_, i) => ({ contentId: `${prefix}-${i}`, title: `title ${prefix}-${i}`,
        url: `https://github.com/octocat/repo/commit/${prefix}-${i}`, publishedAtMs: 1000, metadata: { retained: true } }));
    items = page('old');
    assert.equal((await run(100000)).deferredItemCount, 80);
    assert.equal(JSON.parse(saved.cursor_json).deferredItems[0].title, 'title old-20');
    items = page('new');
    for (let i = 0; i < 9; i++) assert.equal((await run(200000 + i * 30000)).status, 'processed');
    assert.equal(savedItems.length, 200);
    assert.equal(new Set(savedItems.map(item => item.contentId)).size, 200);
    assert(savedItems.filter(item => item.contentId.startsWith('old-')).every(item => item.discoveredAtMs === 100000 && item.metadata.retained));
    assert(savedItems.filter(item => item.contentId.startsWith('new-')).every(item => item.discoveredAtMs === 200000));
    assert.equal(JSON.parse(saved.cursor_json).deferredItems, undefined);
    assert.equal((await run(900000)).newItemCount, 0);
    assert.equal(failure, undefined);
});

test('T1 backlog limits fail atomically and a damaged durable backlog never resets to an empty baseline', async () => {
    let completed = false, failure;
    const source = memorySource();
    const items = Array.from({ length: 5021 }, (_, i) => ({ contentId: String(i), url: `https://example.test/${i}` }));
    const store = { computedPollInterval: () => 30000, policyFor: () => ({}), reserveProviderRequest: async () => ({ allowed: true }),
        recordProviderRateLimit: async () => {}, completeSource: async () => { completed = true; }, failSource: async (_s, result) => { failure = result; } };
    const result = await runner.processSource(source, { now: 100000, store, config: {}, sourceCounts: new Map(), fetchSource: async () => ({ items }) });
    assert.equal(result.errorCode, 'AUTO_WATCH_BACKLOG_LIMIT'); assert.equal(completed, false); assert(failure);
    const oversized = [...items.slice(0, 20), { contentId: 'huge', url: 'https://example.test/huge', title: 'x'.repeat(13 * 1024 * 1024) }];
    const bytesResult = await runner.processSource(source, { now: 100000, store, config: {}, sourceCounts: new Map(), fetchSource: async () => ({ items: oversized }) });
    assert.equal(bytesResult.errorCode, 'AUTO_WATCH_BACKLOG_LIMIT'); assert.equal(completed, false);
    assert.throws(() => runner.parseCursor('{"deferredItems":[{"contentId":"pending"}]}'), { code: 'AUTO_WATCH_INVALID_BACKLOG' });
});

const steamSource = { provider_id: 'steam', product_url: 'https://store.steampowered.com/app/730', source_locale: 'ja' };
function steamHtml(discount = true) {
    return `<meta property="og:title" content="Steam：Fixture"><div itemprop="offers"><meta itemprop="price" content="500"><meta itemprop="priceCurrency" content="JPY"></div>
        <div class="game_purchase_action_bg"><div class="discount_block" data-price-final="50000" ${discount ? 'data-discount="50"' : ''}>
        ${discount ? '<div class="discount_original_price">¥1,000</div>' : ''}<div class="discount_final_price">¥500</div></div></div>`;
}
function response(body, url) { return { ok: true, status: 200, url, text: async () => body, json: async () => body }; }
async function steamObservation(kind) {
    return fetchPrice(steamSource, { fetch: async url => {
        if (String(url).includes('/api/appdetails')) return kind === 'api'
            ? response({ 730: { success: true, data: { name: 'Fixture', price_overview: { final: 50000, initial: 100000, currency: 'JPY', discount_percent: 50 } } } }, url)
            : { ok: false, status: 503 };
        return response(steamHtml(kind !== 'unknown'), url);
    } });
}

test('T7 Steam API and matching HTML fallback preserve discount/reference price; missing metadata remains unknown', async () => {
    for (const kind of ['api', 'html']) {
        const result = await steamObservation(kind);
        assert.equal(result.priceAmount, 500); assert.equal(result.referencePriceAmount, 1000); assert.equal(result.discountPercent, 50);
    }
    const unknown = await steamObservation('unknown');
    assert.equal(unknown.discountPercent, null); assert.equal(unknown.referencePriceAmount, null);
    const { parseSteamPrice } = require('../../src/providers/steam/steamSourceParser');
    const unrelated = `<div itemprop="offers"><meta itemprop="price" content="500"><meta itemprop="priceCurrency" content="JPY"></div>
        <section><div class="game_purchase_action_bg"><div class="discount_block" data-price-final="50000" data-discount="90"><div class="discount_original_price">¥5,000</div><div class="discount_final_price">¥500</div></div><a href="javascript:addBundleToCart(1)">Other bundle</a></div></section>`;
    assert.deepEqual(parseSteamPrice(unrelated, steamSource.product_url, { country: 'jp' }), { final: 50000, currency: 'JPY' });
});

test('T7 API→unknown HTML→API does not reset a live sale, but a real sale ending and returning alerts again', async () => {
    let saved = { ...steamSource, id: '1', initialized_at_ms: 1, state_json: '{}', failure_count: 0 };
    let condition = 0, snapshot, alerts = 0;
    const store = { claimDueSources: async () => [saved], claimDueDeliveries: async () => [], reserveProvider: async () => ({ allowed: true }),
        sourceTargets: async () => [{ id: '1', watch_mode: 'threshold', min_discount_percent: 50, max_price_amount: null, condition_active: condition, baseline_at_ms: 1 }],
        completeSource: async (_s, after, events, states) => { saved = { ...saved, state_json: JSON.stringify(after) }; condition = Number(states[0].conditionActive); alerts += events.length; },
        failSource: async () => assert.fail('Valid price observations must complete') };
    const observe = async next => { snapshot = next; await priceRunner.tick({ now: 100000, store, fetchPrice: async () => snapshot }); };
    await observe(await steamObservation('api')); assert.equal(alerts, 1); assert.equal(condition, 1);
    await observe(await steamObservation('unknown')); assert.equal(alerts, 1); assert.equal(condition, 1);
    await observe(await steamObservation('api')); assert.equal(alerts, 1);
    await observe({ ...snapshot, discountPercent: 0, referencePriceAmount: 500 }); assert.equal(condition, 0);
    await observe(await steamObservation('api')); assert.equal(alerts, 2);
    const threshold = { min_discount_percent: 50, max_price_amount: 100 };
    assert.equal(priceRunner._internal.thresholdActive(threshold, { priceAmount: 500, discountPercent: null }), null);
    assert.equal(priceRunner._internal.thresholdActive(threshold, { priceAmount: 50, discountPercent: null }), true, 'Existing OR semantics remain valid');
});

test('T8 every supplied threshold is validated, including an invalid secondary condition', () => {
    for (const value of [150, -1, 0, 'bad', Infinity, NaN, true, [], {}, '0x10']) {
        assert.throws(() => normalizeRule({ mode: 'threshold', maxPriceAmount: 1000, minDiscountPercent: value }), error => error.code === 'PRICE_WATCH_INVALID_THRESHOLD' && error.field === 'minDiscountPercent');
    }
    for (const value of [-1, 'bad', Infinity, true, [], {}]) {
        assert.throws(() => normalizeRule({ mode: 'threshold', maxPriceAmount: value, minDiscountPercent: 50 }), error => error.code === 'PRICE_WATCH_INVALID_THRESHOLD' && error.field === 'maxPriceAmount');
    }
    assert.equal(normalizeRule({ mode: 'threshold', maxPriceAmount: '0', minDiscountPercent: ' ' }).maxPriceAmount, 0);
    assert.equal(normalizeRule({ mode: 'threshold', minDiscountPercent: '.01' }).minDiscountPercent, 0.01);
});

test('S14-1 BOOTH rejects unrecognized HTTP200 pages and accepts an explicit empty shop index', async () => {
    for (const html of ['<h1>Temporarily unavailable</h1>Please try again later', '<form>Login</form>', '<div data-items="not-json"></div>', '<div data-items="{}"></div>']) {
        await assert.rejects(fetchSource({ provider_id: 'booth', source_key: 'sample' }, { config: {}, fetch: async url => response(html, url) }), { code: 'AUTO_WATCH_INVALID_RESPONSE' });
    }
    const empty = await fetchSource({ provider_id: 'booth', source_key: 'sample' }, { config: {}, fetch: async url => response('<div data-items="[]"></div>', url) });
    assert.deepEqual(empty.items, []);
});

const U = '222222222222222222', G = '111111111111111111', C = '333333333333333333', SELECTED = '444444444444444444', B = '555555555555555555', M = '888888888888888888';
async function commandFixture() {
    const db = await createTestDatabase(port);
    try {
        await grantTestDonor(db, U);
        const binding = { ...db, ensureUserExistsInDatabase: userId => db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [userId]) };
        const replacements = { '../../db': binding, '../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} } };
        const nativeAuto = load('src/providers/autoWatch/store.js', replacements), nativePrice = load('src/providers/priceWatch/store.js', replacements);
        let seq = 0, elapsed = 0, failReply = false, deniedSubject = null, deniedPermission = 0n;
        const hooks = new Map(), deleted = [], trace = [], replies = [];
        const remote = async action => { trace.push({ action, elapsed }); await Promise.resolve(); elapsed += 3100; };
        const selected = { id: SELECTED, name: 'alerts', type: 0, permissionsFor: subject => new PermissionsBitField([
            PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageWebhooks,
        ].filter(permission => subject?.id !== deniedSubject || permission !== deniedPermission)),
        fetchWebhooks: async () => { await remote('fetchWebhooks'); return hooks; },
        createWebhook: async ({ name }) => {
            await remote('createWebhook');
            const id = String(666666666666666666n + BigInt(++seq)), token = 'synthetic-token-never-submitted';
            const hook = { id, type: 1, owner: { id: B }, name, token, url: `https://discord.com/api/webhooks/${id}/${token}`, delete: async () => { deleted.push(id); hooks.delete(id); } };
            hooks.set(id, hook); return hook;
        } };
        const auto = { ...nativeAuto, validateWebhook: async value => { await remote('validateWebhook'); return { id: value.match(/webhooks\/(\d+)/)[1], guildId: G, channelId: SELECTED }; } };
        const watch = load('src/commands/handlers/autoextract/watch.js', { '../../../providers/autoWatch/store': auto, '../../../db': binding,
            '../../../db_schema': { ...schema, ensureDatabaseSchema: async () => {} }, '../../../errorTracking': { recordError: () => {} } });
        const price = load('src/components/priceWatch.js', { '../providers/priceWatch/store': nativePrice,
            '../providers/autoWatch/store': auto, './_permissionCheck': { isAllowed: async () => true } });
        const interaction = () => {
            let attempts = 0;
            const value = { locale: 'ja', user: { id: U }, guildId: G, channelId: C, member: { id: U }, client: { user: { id: B } },
                guild: { id: G, channels: { cache: new Map([[SELECTED, selected]]) }, members: { me: { id: B } } },
                channel: { id: C, nsfw: false, messages: { fetch: async () => { await remote('originalMessage'); return { id: M, embeds: [{ url: steamSource.product_url, title: 'Fixture' }] }; } } },
                options: { getBoolean: () => true, getString: key => ({ provider: 'github', source: 'octocat', destination: 'channel' })[key] || null, getChannel: () => selected },
                deferred: false, replied: false,
                deferUpdate: async () => { assert.equal(elapsed, 0); value.deferred = true; trace.push({ action: 'deferUpdate', elapsed }); },
                deferReply: async payload => { assert.equal(elapsed, 0); assert.equal(payload.ephemeral, true); value.deferred = true; trace.push({ action: 'deferReply', elapsed }); },
                editReply: async payload => { replies.push(payload); if (failReply && attempts++ === 0) throw Object.assign(new Error('Synthetic reply timeout'), { code: 'ETIMEDOUT' }); return payload; },
            };
            return value;
        };
        return { db, nativeAuto, nativePrice, watch, price, interaction, deleted, hooks, trace, replies,
            reset: () => { elapsed = 0; trace.length = 0; failReply = false; }, failReply: () => { failReply = true; },
            deny: (subject, permission) => { deniedSubject = subject; deniedPermission = permission; } };
    } catch (error) { await db.close(); throw error; }
}

test('S8-1/2 committed Discord watch keeps its webhook after reply failure and repeated/concurrent channel choices use one slot', { skip: !port }, async () => {
    const f = await commandFixture();
    try {
        f.failReply(); await f.watch(f.interaction());
        assert.equal(f.deleted.length, 0); assert.match(f.replies.at(-1).content, /登録しました.*ID:/);
        f.reset(); await Promise.all([f.watch(f.interaction()), f.watch(f.interaction())]);
        const rows = await f.db.queryDatabase('SELECT id,destination_key FROM auto_watch_targets');
        assert.equal(rows.length, 1); assert.equal(rows[0].destination_key, `channel:${G}:${SELECTED}`);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 1);
        assert.equal(f.hooks.size, 1);
        // Low-level native admission also deduplicates the selected channel when
        // separate workers obtained different hook tokens before either commit.
        const input = { userId: U, guildId: G, providerId: 'github', source: 'octocat', destinationType: 'webhook',
            destinationChannelId: SELECTED, webhookUrl: 'https://discord.com/api/webhooks/666666666666666667/different-synthetic-token' };
        assert.equal((await f.nativeAuto.registerTarget(input)).id, String(rows[0].id));
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_targets'))[0].n), 1);
        const legacyInput = { ...input, source: 'legacy-source', webhookUrl: [...f.hooks.values()][0].url, destinationChannelId: undefined };
        const legacy = await f.nativeAuto.registerTarget(legacyInput);
        assert.equal((await f.nativeAuto.registerTarget({ ...legacyInput, destinationChannelId: SELECTED })).id, legacy.id);
        assert.match((await f.db.queryDatabase('SELECT destination_key FROM auto_watch_targets WHERE id=?', [legacy.id]))[0].destination_key, /^webhook:/);
        const legacyPriceInput = { userId: U, guildId: G, providerId: 'steam', productUrl: steamSource.product_url, destinationType: 'webhook', webhookUrl: legacyInput.webhookUrl, mode: 'change', locale: 'ja' };
        const legacyPrice = await f.nativePrice.registerTarget(legacyPriceInput);
        assert.equal((await f.nativePrice.registerTarget({ ...legacyPriceInput, destinationChannelId: SELECTED })).id, legacyPrice.id);
        assert.match((await f.db.queryDatabase('SELECT destination_key FROM price_watch_targets WHERE id=?', [legacyPrice.id]))[0].destination_key, /^webhook:/);
    } finally { await f.db.close(); }
});

test('S12-1 view/send/manage permissions for both owner and bot reject before webhook or slot commit', { skip: !port }, async () => {
    const f = await commandFixture();
    try {
        for (const subject of [U, B]) for (const permission of [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageWebhooks]) {
            f.reset(); f.deny(subject, permission); await f.watch(f.interaction());
            assert.equal(f.hooks.size, 0); assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_targets'))[0].n), 0);
            assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
            assert.match(f.replies.at(-1).embeds[0].description, /閲覧・送信権限/);
        }
        f.reset(); f.deny(U, PermissionsBitField.Flags.SendMessages);
        const priceInteraction = f.interaction();
        priceInteraction.customId = `priceWatchChannel:s:app:730:ja:${M}:change`; priceInteraction.values = [SELECTED];
        await f.price.handle(priceInteraction);
        assert.match(f.replies.at(-1).content, /閲覧・送信権限/);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM price_watch_targets'))[0].n), 0);
        f.deny(null, 0n); f.reset(); await f.watch(f.interaction());
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM auto_watch_targets'))[0].n), 1);
    } finally { await f.db.close(); }
});

test('S12-2 all price registration paths defer privately before slow source/webhook/SQL work; modal-opening actions remain undeferred', { skip: !port }, async () => {
    const f = await commandFixture();
    try {
        for (const kind of ['dm-change', 'channel-change', 'modal-dm', 'modal-webhook']) {
            f.reset(); const interaction = f.interaction();
            if (kind === 'dm-change') { interaction.customId = `priceWatchDestination:s:app:730:ja:${M}`; interaction.values = ['change:dm']; }
            else if (kind === 'channel-change') { interaction.customId = `priceWatchChannel:s:app:730:ja:${M}:change`; interaction.values = [SELECTED]; }
            else {
                interaction.customId = `priceWatchModal:threshold:${kind === 'modal-webhook' ? 'webhook' : 'dm'}:s:app:730:ja:${M}`;
                interaction.fields = { getTextInputValue: id => ({ maxPrice: '1000', minDiscount: '50', webhook: 'https://discord.com/api/webhooks/666666666666666666/synthetic-token-never-submitted' })[id] || '' };
            }
            await (kind.startsWith('modal-') ? f.price.handleModal(interaction) : f.price.handle(interaction));
            assert.equal(f.trace[0].action, kind.startsWith('modal-') ? 'deferReply' : 'deferUpdate');
            assert.match(f.replies.at(-1).content, /価格通知を登録しました/);
            if (kind.startsWith('modal-')) { assert.match(f.replies.at(-1).content, /上限価格: 1000/); assert.match(f.replies.at(-1).content, /最低割引率: 50%/); }
        }
        f.reset(); const interaction = f.interaction();
        interaction.customId = `priceWatchDestination:s:app:730:ja:${M}`; interaction.values = ['threshold:dm'];
        interaction.showModal = async () => { assert.equal(interaction.deferred, false); f.trace.push({ action: 'showModal' }); };
        await f.price.handle(interaction); assert.equal(f.trace[0].action, 'showModal');
        // The same channel price registration remains idempotent on retry.
        f.reset(); const repeated = f.interaction(); repeated.customId = `priceWatchChannel:s:app:730:ja:${M}:change`; repeated.values = [SELECTED];
        await f.price.handle(repeated);
        assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM price_watch_targets WHERE destination_key=? AND watch_mode='change'", [`channel:${G}:${SELECTED}`]))[0].n), 1);
    } finally { await f.db.close(); }
});

test('T8 invalid Discord secondary condition has field guidance and creates no target, slot or webhook', { skip: !port }, async () => {
    const f = await commandFixture();
    try {
        const interaction = f.interaction();
        interaction.customId = `priceWatchModal:threshold:channel:s:app:730:ja:${M}:${SELECTED}`;
        interaction.fields = { getTextInputValue: id => ({ maxPrice: '1000', minDiscount: '150' })[id] || '' };
        await f.price.handleModal(interaction);
        assert.match(f.replies.at(-1).content, /最低割引率は0.01〜100/);
        assert.deepEqual(f.trace.map(entry => entry.action), ['deferReply']);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM price_watch_targets'))[0].n), 0);
        assert.equal(Number((await f.db.queryDatabase('SELECT COUNT(*) n FROM automation_notification_slots'))[0].n), 0);
        assert.equal(f.hooks.size, 0);
    } finally { await f.db.close(); }
});
