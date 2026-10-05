'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InteractionType } = require('discord.js');
const model = require('../../src/personalLinks/model');
const { parseStock, restockOptions } = require('../../src/providers/booth/boothSourceParser/stock');
const { createRunner, createTransport, messageFor, fetchStock } = require('../../src/personalLinks/runner');
const ui = require('../../src/personalLinks/ui');

test('personal links accept supported services without accepting credentials or lookalike hosts', () => {
    for (const url of ['https://x.com/a/status/123', 'https://www.pixiv.net/artworks/123', 'https://booth.pm/ja/items/123', 'https://www.youtube.com/watch?v=abcdefghijk']) assert.ok(model.link(url).providerId);
    for (const url of ['https://x.com.evil.test/a/status/123', 'http://127.0.0.1/a', 'https://u:p@x.com/a/status/123', 'https://example.com']) assert.throws(() => model.link(url));
    assert.equal(model.link('https://x.com/a/status/123?s=20').contentKey, model.link('https://twitter.com/b/status/123').contentKey);
    assert.equal(model.boothItem('https://shop.booth.pm/items/123').url, 'https://booth.pm/ja/items/123');
    assert.throws(() => model.boothItem('https://notbooth.pm/items/123'));
});

test('reminder time honors the chosen zone, rejects past dates and ambiguous or nonexistent local times', () => {
    const now = Date.parse('2026-09-22T10:00:00Z');
    assert.equal(model.dueAt('1h', 'Asia/Tokyo', now), now + 3600000);
    assert.equal(model.dueAt('today21', 'Asia/Tokyo', now), Date.parse('2026-09-22T12:00:00Z'));
    assert.equal(model.dueAt('2026-09-23 21:00', 'Asia/Tokyo', now), Date.parse('2026-09-23T12:00:00Z'));
    assert.throws(() => model.dueAt('today21', 'Asia/Tokyo', now + 3 * 3600000), /TIME_OUT_OF_RANGE/);
    assert.throws(() => model.dueAt('1h', 'No/Such_Zone', now), /INVALID_TIME_ZONE/);
    assert.throws(() => model.dueAt('2027-03-14 02:30', 'America/New_York', now), /INVALID_TIME/);
    assert.throws(() => model.dueAt('2026-11-01 01:30', 'America/New_York', now), /INVALID_TIME/);
    assert.equal(model.dueAt('2026-11-01T01:30:00-04:00', 'America/New_York', now), Date.parse('2026-11-01T05:30:00Z'));
});

test('BOOTH stock differentiates unknown, sold out, sale period and available variants', () => {
    assert.equal(parseStock({ is_sold_out: false }).state, 'unknown');
    assert.equal(parseStock({ variations: [{ id: 1, status: 'out_of_sale_period', is_empty_stock: true }] }).state, 'unavailable');
    assert.deepEqual(restockOptions({ variations: [{ id: 1, status: 'out_of_sale_period', is_empty_stock: true }] }), []);
    const mixed = { variations: [{ id: 1, name: 'A', status: 'available' }, { id: 2, name: 'B', status: 'sold_out' }] };
    assert.equal(parseStock(mixed).state, 'available');
    assert.deepEqual(restockOptions(mixed), [{ id: '2', name: 'B' }]);
    assert.equal(restockOptions({ is_sold_out: true })[0].id, '*');
    assert.deepEqual(restockOptions({ status: 'out_of_sale_period', is_sold_out: true }), []);
});

test('stock fetch uses public item JSON and treats malformed/unknown data as a failed observation', async () => {
    let called;
    const source = { item_id: '123', url: 'https://booth.pm/ja/items/123' };
    const fetch = async (url, opts) => { called = { url, opts }; return { ok: true, status: 200, text: async () => JSON.stringify({ variations: [{ id: 7, status: 'sold_out' }] }) }; };
    assert.equal((await fetchStock(source, fetch)).variations[0].state, 'sold_out');
    assert.equal(called.url, 'https://booth.pm/ja/items/123.json');
    assert.equal(called.opts.headers.Authorization, undefined);
    await assert.rejects(fetchStock(source, async () => ({ ok: true, status: 200, text: async () => '{}' })), /UNKNOWN_STOCK/);
});

function runnerFixture(overrides = {}) {
    const job = { id: 'a'.repeat(32), user_id: '111111111111111111', created_at_ms: 1, attempts: 0, kind: 'reminder', title: '@everyone', url: 'https://x.com/a/status/123', locale: 'ja' };
    const calls = [];
    const store = { claim: async () => job, beginSend: async () => true, finish: async (_job, status, detail) => calls.push({ status, detail }) };
    const transport = { prepare: async () => '222222222222222222', send: async () => { calls.push({ sent: true }); return '333333333333333333'; } };
    return { job, calls, store, transport, runner: () => createRunner({ store, transport, clock: () => 100000, assertAllowed: () => {}, notificationAllowed: () => true, ...overrides }) };
}

test('reminders only send to their owner with disabled mentions and bounded content', async () => {
    const f = runnerFixture();
    assert.equal(await f.runner().deliver(), 'sent');
    assert.equal(f.calls.at(-1).status, 'sent');
    const requests = [];
    const transport = createTransport(null, { post: async (route, options) => { requests.push({ route, options }); return { id: '222222222222222222' }; } });
    const channel = await transport.prepare(f.job); await transport.send(channel, f.job);
    assert.equal(requests[0].options.body.recipient_id, f.job.user_id);
    assert.deepEqual(requests[1].options.body.allowed_mentions, { parse: [] });
    assert.equal(requests[1].options.body.enforce_nonce, true);
    assert.equal(messageFor({ ...f.job, url: 'https://x.com/a/status/123?' + 'x'.repeat(1900) }).embeds[0].url.length > 1900, true);
});

test('uncertain sends and failed receipt persistence do not automatically resubmit', async () => {
    for (const failure of ['send', 'receipt']) {
        const f = runnerFixture();
        if (failure === 'send') f.transport.send = async () => { throw { code: 'ECONNRESET' }; };
        else f.store.finish = async (_job, status, details) => { if (status === 'sent') throw new Error('receipt failed'); f.calls.push({ status, details }); };
        assert.equal(await f.runner().deliver(), 'unknown');
        assert.equal(f.calls.at(-1).status, 'unknown');
    }
});

test('definite rejection, rate limits, cancellation and recovery have distinct delivery outcomes', async () => {
    for (const [status, expected] of [[403, 'failed'], [429, 'pending'], [503, 'unknown']]) {
        const f = runnerFixture(); f.transport.send = async () => { throw { status }; };
        assert.equal(await f.runner().deliver(), expected);
    }
    const cancelled = runnerFixture(); cancelled.store.beginSend = async () => false;
    assert.equal(await cancelled.runner().deliver(), 'cancelled');
    assert.equal(cancelled.calls.length, 0);
    const recovered = runnerFixture({ notificationAllowed: () => false });
    assert.equal(await recovered.runner().deliver(), 'quarantined');
    assert.ok(!recovered.calls.some(c => c.sent));
});

test('fleet lease is rechecked after DM creation and before message submission', async () => {
    let checks = 0;
    const f = runnerFixture({ assertAllowed: () => { if (++checks >= 2) throw new Error('lease expired'); } });
    assert.equal(await f.runner().deliver(), 'pending');
    assert.ok(!f.calls.some(c => c.sent));
});

test('restock polling shares provider pacing and cooldown; failed requests never update stock', async () => {
    const postponed = [], cooldowns = [], observed = [];
    const source = { item_id: '123', url: 'https://booth.pm/ja/items/123' };
    const store = { claimSource: async () => source, observe: async (_source, stock) => { observed.push(stock); return true; },
        postponeSource: async (_source, at, code) => postponed.push({ at, code }) };
    const options = { store, clock: () => 10000, assertAllowed: () => {}, transport: {},
        reserveProvider: async () => ({ allowed: false, nextCheckAtMs: 20000 }),
        fetchStock: async () => { throw new Error('must not fetch'); } };
    assert.equal(await createRunner(options).pollStock(), 'paced');
    assert.equal(postponed[0].at, 20000);
    assert.equal(observed.length, 0);
    options.reserveProvider = async () => ({ allowed: true });
    options.fetchStock = async () => { throw { status: 429, retryAfterMs: 120000 }; };
    options.cooldownProvider = async at => cooldowns.push(at);
    assert.equal(await createRunner(options).pollStock(), 'failed');
    assert.equal(cooldowns[0], 130000);
    assert.equal(observed.length, 0);
    options.fetchStock = async () => ({ state: 'sold_out', variations: [] });
    assert.equal(await createRunner(options).pollStock(), 'observed');
    assert.equal(observed.length, 1);
});

test('reminder menu presets, datetime modal and restock variant selection register the intended private action', async () => {
    const { handle } = require('../../src/components/personalLinks');
    const owner = '111111111111111111', bot = '222222222222222222', id = 'a'.repeat(32);
    const card = { id, messageId: 'public', entry: model.link('https://booth.pm/ja/items/123'), providerId: 'booth', restockOptions: [{ id: '7', name: 'Red' }] };
    const registrations = [];
    const store = { getCard: async () => card, createNotification: async (user, entry, options) => {
        registrations.push({ user, entry, options }); return { id: 'b'.repeat(32), due_at_ms: options.dueAtMs || 0 };
    } };
    function interaction(customId, type = InteractionType.MessageComponent) {
        const calls = [];
        const i = { customId, type, id: model.id(), user: { id: owner }, client: { user: { id: bot } },
            guildId: 'g', channelId: 'c', message: { id: 'public', author: { id: bot } }, locale: 'ja',
            memberPermissions: { has: () => true }, channel: { messages: { fetch: async () => ({ author: { id: bot } }) } },
            deferReply: async () => { i.deferred = true; }, editReply: async p => calls.push(p), reply: async p => calls.push(p),
            showModal: async p => calls.push(p) };
        return { i, calls };
    }
    const preset = interaction(`personal:time:${id}:${owner}:1h`);
    await handle(preset.i, store);
    assert.equal(registrations[0].options.kind, 'reminder');
    assert.ok(Math.abs(registrations[0].options.dueAtMs - Date.now() - 3600000) < 2000);
    const custom = interaction(`personal:time:${id}:${owner}:custom`);
    await handle(custom.i, store);
    assert.equal(custom.i.deferred, undefined);
    assert.equal(custom.calls[0].custom_id, `personal:when:${id}:${owner}`);
    const modal = interaction(`personal:when:${id}:${owner}`, InteractionType.ModalSubmit);
    modal.i.fields = { getTextInputValue: key => key === 'when' ? '2h' : 'Asia/Tokyo' };
    await handle(modal.i, store);
    assert.ok(Math.abs(registrations[1].options.dueAtMs - Date.now() - 7200000) < 2000);
    const stock = interaction(`personal:stock:${id}:${owner}`);
    stock.i.values = ['7']; await handle(stock.i, store);
    assert.equal(registrations[2].options.variationId, '7');
    assert.equal(registrations[2].options.variationName, 'Red');
    stock.i.values = ['8']; await handle(stock.i, store);
    assert.equal(registrations.length, 3);
});

test('private command registration and card buttons cover saving, reminders, and restock', async () => {
    const { buildSlashCommands } = require('../../src/commands');
    const { shouldDeferEphemeral } = require('../../src/handlers/applicationCommands')._internal;
    const commands = buildSlashCommands();
    for (const name of ['saved', 'remind', 'restock']) {
        assert.ok(commands.some(c => c.name === name));
        assert.equal(shouldDeferEphemeral({ commandName: name }), true);
    }
    const cards = require('../../src/personalLinks/cards');
    let card;
    const prepared = await cards.prepare({ embeds: [{ title: 'Item' }], restockOptions: [{ id: '7', name: 'Red' }] },
        { guildId: 'g', channelId: 'c' }, { providerId: 'booth', url: 'https://booth.pm/ja/items/123', personalActions: true, presentationSettings: { defaultLanguage: 'ja' } },
        { saveCard: async saved => { card = saved; } });
    assert.equal(prepared.step.components[0].components.length, 3);
    assert.deepEqual(card.restockOptions, [{ id: '7', name: 'Red' }]);
    assert.equal(card.entry.providerId, 'booth');
});

test('personal list uses private scoped results without exceeding embed text budgets', () => {
    const rows = Array.from({ length: 10 }, () => ({ id: 'a'.repeat(32), title: 'x'.repeat(512), url: 'https://x.com/a/status/123', tags_json: '["tag"]', note: 'n'.repeat(1000) }));
    const payload = ui.listing(rows, 'ja', 'saved');
    assert.ok(payload.embeds.reduce((n, e) => n + e.title.length + e.description.length + e.footer.text.length, 0) < 6000);
});

test('card save and reminder selection never act as another user; note editing is owner scoped', async () => {
    const { handle } = require('../../src/components/personalLinks');
    const userId = '111111111111111111', botId = '222222222222222222', id = 'a'.repeat(32);
    const calls = [];
    const interaction = { type: InteractionType.MessageComponent, customId: `personal:save:${id}`, user: { id: userId }, id: 'interaction',
        guildId: 'g', channelId: 'c', locale: 'ja', client: { user: { id: botId } }, message: { id: 'm', author: { id: botId } },
        deferReply: async () => { interaction.deferred = true; }, editReply: async p => calls.push(p), reply: async p => calls.push(p) };
    const store = { getCard: async () => ({ id, messageId: 'm', providerId: 'booth', entry: model.link('https://booth.pm/ja/items/123') }),
        save: async (owner, entry) => { assert.equal(owner, userId); return { id, ...entry }; } };
    await handle(interaction, store);
    assert.match(calls[0].content, /保存しました/);
    calls.length = 0;
    interaction.customId = `personal:time:${id}:999999999999999999:1h`;
    await handle(interaction, store);
    assert.match(calls[0].content, /見つかりません/);
    interaction.customId = `personal:edit:${id}`;
    await handle(interaction, { getSaved: async (owner, key) => { assert.equal(owner, userId); assert.equal(key, id); return null; } });
    assert.match(calls.at(-1).content, /見つかりません/);
});
