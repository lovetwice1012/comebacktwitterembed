'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { REST, DefaultRestOptions, Client, Message } = require('discord.js');
const { createSingleAttemptSender } = require('../../src/providers/twitter/singleAttemptSender')._internal;
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const CHANNEL = '333333333333333333', SOURCE = '444444444444444444', SENT = '555555555555555555';

function fixture(makeRequest, configuredRequest = DefaultRestOptions.makeRequest) {
    const optionsSeen = [], client = { token: 'fixture-only', options: { jsonTransformer: value => value, failIfNotExists: true },
        rest: { options: { ...DefaultRestOptions, makeRequest: configuredRequest } } };
    const channel = { id: CHANNEL, client, messages: { cache: new Map(), resolveId: value => value?.id || value,
        _add: value => ({ ...value, channel, client }) } };
    const source = { id: SOURCE, channel, client };
    const sender = createSingleAttemptSender({ restFactory: options => {
        optionsSeen.push(options); return new REST({ ...options, makeRequest });
    } });
    return { client, channel, source, sender, optionsSeen };
}
function jsonResponse(status, value, extra = {}) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } });
}

test('real REST makes only one POST when a received request loses its response', async () => {
    let calls = 0;
    const f = fixture(async () => {
        if (++calls === 1) throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
        return jsonResponse(413, { code: 0, message: 'too large' });
    });
    const send = f.sender.forMessage(f.source, 'channel', null);
    await assert.rejects(send.send({ files: [Buffer.from('a'), Buffer.from('b')] }), { code: 'ECONNRESET' });
    assert.equal(calls, 1); assert.equal(f.optionsSeen[0].retries, 0);
    assert.equal(f.client.rest.options.retries, DefaultRestOptions.retries, 'shared REST options were not changed');
});

test('real REST returns a definite 413 from a single request without an internal retry', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return jsonResponse(413, { code: 0, message: 'too large' }); });
    const send = f.sender.forMessage(f.source, 'channel', null);
    await assert.rejects(send.send({ files: [Buffer.from('a'), Buffer.from('b')] }), error => error.status === 413);
    assert.equal(calls, 1);
});

test('reply source and previous preserve references, allowed mentions and channel message registration', async () => {
    const bodies = [];
    const f = fixture(async (_url, init) => {
        bodies.push(JSON.parse(init.body.get('payload_json')));
        return jsonResponse(200, { id: SENT, channel_id: CHANNEL, content: 'fixture' });
    });
    const previous = { id: '666666666666666666', channel: f.channel, client: f.client };
    for (const [mode, ref] of [['reply-source', SOURCE], ['reply-previous', previous.id]]) {
        const sender = f.sender.forMessage(f.source, mode, previous);
        const message = await sender.send({ content: 'fixture', files: [Buffer.from('a')], allowedMentions: { parse: [], repliedUser: false } });
        assert.equal(message.id, SENT); assert.equal(message.channel, f.channel);
        const body = bodies.at(-1);
        assert.equal(body.message_reference.message_id, ref); assert.equal(body.message_reference.fail_if_not_exists, true);
        assert.equal(body.allowed_mentions.replied_user, false); assert.deepEqual(body.allowed_mentions.parse, []);
    }
});

test('Gateway-first partial cache uses the complete POST receipt without changing the cache', async () => {
    const client = new Client({ intents: [] });
    client.token = 'fixture-only';
    const cachedData = { id: SENT, channel_id: CHANNEL, author: { id: SOURCE, username: 'bot', discriminator: '0' },
        content: '', embeds: [], attachments: [], components: [] };
    const cached = new Message(client, cachedData);
    const raw = { ...cachedData, embeds: [{ title: 'Post', description: 'body' }],
        attachments: [{ id: '777777777777777777', filename: 'photo.jpg', content_type: 'image/jpeg',
            url: `https://cdn.discordapp.com/attachments/${CHANNEL}/777777777777777777/photo.jpg` }],
        components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Combine', custom_id: 'tg:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0:open' }] }] };
    let posts = 0, updates = 0;
    const channel = { id: CHANNEL, client, messages: { cache: new Map([[SENT, cached]]), resolveId: value => value?.id || value,
        _add: value => { updates++; cached._patch(value); return cached; } } };
    client.channels.cache.set(CHANNEL, channel);
    const sender = createSingleAttemptSender({ restFactory: () => ({ setToken() {}, async post() { posts++; return raw; } }) });
    const receipt = await sender.forMessage({ id: SOURCE, channel, client }, 'channel').send({ content: 'fixture' });
    const cards = require('../../src/twitterGridCards');
    assert.equal(posts, 1); assert.equal(updates, 0); assert.notEqual(receipt, cached);
    assert.equal(receipt.channel, channel); assert.equal(receipt.embeds[0].title, 'Post');
    assert.equal(receipt.attachments.first().id, raw.attachments[0].id);
    assert.equal(receipt.components[0].components[0].customId, raw.components[0].components[0].custom_id);
    assert.equal(cached.embeds.length, 0); assert.equal(cached.attachments.size, 0);
    const saved = cards.fingerprint(receipt);
    cached._patch(raw);
    assert.equal(cards.fingerprint(cached), saved, 'a subsequent complete GET matches the saved receipt');
});

test('a later Gateway edit is not overwritten by an older POST acknowledgement', async () => {
    const client = new Client({ intents: [] }); client.token = 'fixture-only';
    const raw = { id: SENT, channel_id: CHANNEL, author: { id: SOURCE, username: 'bot', discriminator: '0' },
        content: 'original', embeds: [], attachments: [], components: [] };
    const newer = new Message(client, { ...raw, content: 'changed later', edited_timestamp: '2026-11-14T00:00:01.000Z' });
    const channel = { id: CHANNEL, client, messages: { cache: new Map([[SENT, newer]]), resolveId: value => value?.id || value,
        _add: value => { newer._patch(value); return newer; } } };
    client.channels.cache.set(CHANNEL, channel);
    let calls = 0;
    const sender = createSingleAttemptSender({ restFactory: () => ({ setToken() {}, async post() { calls++; return raw; } }) });
    const receipt = await sender.forMessage({ id: SOURCE, channel, client }, 'channel').send({ content: 'fixture' });
    assert.equal(calls, 1); assert.equal(receipt.content, 'original'); assert.equal(newer.content, 'changed later');
    const cards = require('../../src/twitterGridCards');
    assert.notEqual(cards.fingerprint(receipt), cards.fingerprint(newer), 'a real later edit is not authorized by the old receipt');
});

test('429 is not automatically resubmitted by the dedicated manager', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return jsonResponse(429, { message: 'rate limited', retry_after: 0.01, global: false }, { 'retry-after': '0.01' }); });
    await assert.rejects(f.sender.forMessage(f.source, 'channel', null).send({ files: [Buffer.from('a'), Buffer.from('b')] }));
    assert.equal(calls, 1);
});

test('unknown custom HTTP adapters and missing credentials fail before any request', () => {
    let calls = 0;
    const f = fixture(async () => { calls++; }, async () => {});
    assert.equal(f.sender.forMessage(f.source, 'channel', null), null); assert.equal(calls, 0);
    f.client.token = null; f.client.rest.options.makeRequest = DefaultRestOptions.makeRequest;
    assert.equal(f.sender.forMessage(f.source, 'channel', null), null); assert.equal(calls, 0);
});

test('the verified Bun HTTP adapter is retained without mutating the shared manager', async () => {
    const adapter = async () => { throw new Error('fixture must use injected REST mock'); };
    Object.defineProperty(adapter, Symbol.for('cbte.discord.singleAttemptFetch'), { value: true });
    const f = fixture(async () => jsonResponse(200, { id: SENT, channel_id: CHANNEL }), adapter);
    const sender = f.sender.forMessage(f.source, 'channel', null);
    const sent = await sender.send({ files: [Buffer.from('a'), Buffer.from('b')] });
    assert.equal(sent.id, SENT); assert.equal(f.optionsSeen[0].makeRequest, adapter); assert.equal(f.optionsSeen[0].retries, 0);
    assert.equal(f.client.rest.options.makeRequest, adapter); assert.equal(f.client.rest.options.retries, DefaultRestOptions.retries);
});

function dispatcherFixture(makeRequest) {
    const f = fixture(makeRequest), filename = require.resolve('../../src/providers/_dispatcher'), actual = createRequire(filename), mod = { exports: {} };
    const post = [];
    f.channel.send = async () => { throw new Error('shared REST must not send X media'); };
    f.source.reply = f.channel.send; f.source.delete = async () => post.push('delete'); f.source.suppressEmbeds = async () => post.push('suppress');
    const mocks = { '../adminSupport/telemetry': { event() {}, errorData: value => value, serializable: value => value },
        '../errorTracking': { recordError() {}, recordMetric() {}, recordAnalyticsEvent() {} }, '../settings': { checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async rows => rows },
        '../state': { incrementProcessedCounters() {} }, '../sharedPostHistory': { run: (_m, steps, _c, send) => send(steps) },
        '../mediaGallery': { prepare: async step => ({ step }), report() {} }, '../personalLinks/cards': { prepare: async step => ({ step }) },
        '../twitterGridCards': { prepare: async step => ({ step }) }, './twitter/singleAttemptSender': f.sender };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename })(
        id => Object.hasOwn(mocks, id) ? mocks[id] : actual(id), mod, mod.exports, { log() {}, warn() {}, error() {} });
    return { ...f, post, run: steps => mod.exports.runSendSteps(f.source, steps, 'twitter', {}) };
}

test('dispatcher never resends after a one-shot X upload whose response is lost', async () => {
    for (const count of [1, 2]) {
        let calls = 0;
        const f = dispatcherFixture(async () => {
            if (++calls === 1) throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
            return jsonResponse(413, { code: 0, message: 'too large' });
        });
        const result = await f.run([{ files: Array.from({ length: count }, () => Buffer.from('fixture')), deleteSource: true }]);
        assert.equal(calls, 1); assert.equal(result.outcome, 'U'); assert.deepEqual(f.post, []);
    }
});

test('dispatcher splits only the definite 413 returned by one-shot REST', async () => {
    const sizes = []; let id = 555555555555555550n;
    const f = dispatcherFixture(async (_url, init) => {
        const count = [...init.body.keys()].filter(key => key.startsWith('files[')).length;
        sizes.push(count);
        if (count > 1) return jsonResponse(413, { code: 0, message: 'too large' });
        return jsonResponse(200, { id: String(++id), channel_id: CHANNEL });
    });
    const result = await f.run([{ files: [Buffer.from('a'), Buffer.from('b')], content: 'fixture', deleteSource: true }]);
    assert.deepEqual(sizes, [2, 1, 1]); assert.equal(result.outcome, 'F'); assert.deepEqual(f.post, ['delete']);
});
