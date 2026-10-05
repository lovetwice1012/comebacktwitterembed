'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');

function dispatcher() {
    const filename = require.resolve('../../src/providers/_dispatcher');
    const actualRequire = createRequire(filename), mod = { exports: {} };
    const mocks = {
        '../adminSupport/telemetry': { event() {}, errorData: value => value, serializable: value => value },
        '../errorTracking': { recordError() {}, recordMetric() {}, recordAnalyticsEvent() {} },
        '../state': { incrementProcessedCounters() {} },
        '../settings': { checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async rows => rows },
        '../sharedPostHistory': { run: (_message, steps, _context, send) => send(steps) },
        '../mediaGallery': { prepare: async step => ({ step }) },
        '../personalLinks/cards': { prepare: async step => ({ step }) },
    };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'console'], { filename })(
        id => mocks[id] || actualRequire(id), mod, mod.exports, { warn() {}, log() {} });
    return mod.exports;
}

function source(send) {
    const postprocess = [];
    return { postprocess, guildId: 'guild', channelId: 'channel',
        channel: { send }, reply: send,
        suppressEmbeds: async () => postprocess.push('suppress'), delete: async () => postprocess.push('delete') };
}

test('silent expansion applies to channel sends, source replies, subsequent replies and file fallback when enabled', async () => {
    const payloads = [];
    let failedFile = false;
    const send = async payload => {
        payloads.push(structuredClone(payload));
        if (payload.files && !failedFile) { failedFile = true; throw { status: 413 }; }
        return { id: String(payloads.length), reply: send };
    };
    await dispatcher().runSendSteps(source(send), [
        { content: 'first', send: 'channel' },
        { content: 'second', send: 'reply-source' },
        { content: 'third', send: 'reply-previous', files: [{ attachment: 'https://example.test/movie.mp4' }] },
    ], 'instagram', { presentationSettings: { silent_expansion: true } });
    assert.equal(payloads.length, 4);
    for (const payload of payloads) assert.equal(payload.flags, 4096);
});

test('an explicit Web setting to disable silent expansion permits ordinary notifications', async () => {
    const payloads = [];
    await dispatcher().runSendSteps(source(async payload => { payloads.push(payload); return { id: 'sent' }; }),
        [{ content: 'ordinary' }], 'instagram', { presentationSettings: { silent_expansion: false } });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].flags, undefined);
});

test('ordinary notifications remain the default before any Web setting is saved', async () => {
    let payload;
    await dispatcher().runSendSteps(source(async value => { payload = value; return { id: 'sent' }; }), [{ content: 'ordinary' }]);
    assert.equal(payload.flags, undefined);
    assert.equal(require('../../src/providers/_provider_settings').PROVIDER_DEFAULTS.silent_expansion, false);
});

test('failed or uncertain deliveries preserve the original message and embeds', async () => {
    for (const error of [
        { status: 503 }, { statusCode: 502 }, { response: { status: 504 } },
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
        { code: 'UND_ERR_SOCKET' }, { name: 'TimeoutError' }, { code: 50013, status: 403 },
    ]) {
        const message = source(async () => { throw error; });
        const result = await dispatcher().runSendSteps(message, [{ content: 'replacement', deleteSource: true, suppressSourceEmbeds: true }]);
        assert.deepEqual(message.postprocess, [], JSON.stringify(error));
        assert.equal(result.outcome, error.status === 403 ? 'E' : 'U', JSON.stringify(error));
    }
});

test('a response without a message ID is uncertain and never permits source cleanup or retry', async () => {
    let calls = 0;
    const message = source(async () => { calls++; return {}; });
    const result = await dispatcher().runSendSteps(message, [{ content: 'replacement', files: ['https://media.example/a.jpg'], deleteSource: true, suppressSourceEmbeds: true }]);
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'U');
    assert.deepEqual(result.sent, []);
    assert.deepEqual(message.postprocess, []);
});

test('source cleanup waits for all source replies and runs each operation only once', async () => {
    const calls = [];
    let deleted = false;
    const message = source(async () => {
        assert.equal(deleted, false, 'Source was deleted before a later reply');
        calls.push('reply'); return { id: String(calls.length) };
    });
    message.delete = async () => { deleted = true; calls.push('delete'); };
    message.suppressEmbeds = async () => calls.push('suppress');
    const steps = ['first', 'second'].map(content => ({ content, send: 'reply-source', deleteSource: true, suppressSourceEmbeds: true }));
    const result = await dispatcher().runSendSteps(message, steps);
    assert.deepEqual(calls, ['reply', 'reply', 'suppress', 'delete']);
    assert.equal(result.outcome, 'F');
    assert.equal(result.postprocess.length, 2);
});

test('partial output preserves the source even when successful and empty steps request cleanup', async () => {
    let attempts = 0;
    const message = source(async () => {
        if (++attempts === 2) throw { status: 400 };
        return { id: 'first' };
    });
    const result = await dispatcher().runSendSteps(message, [
        { content: 'first', send: 'channel', deleteSource: true },
        { content: 'second', send: 'channel' }, { deleteSource: true, suppressSourceEmbeds: true },
    ]);
    assert.equal(result.outcome, 'P');
    assert.deepEqual(message.postprocess, []);
});

test('explicit policy-only suppression and deletion still work without sending content', async () => {
    const message = source(async () => assert.fail('Policy-only step must not send'));
    const result = await dispatcher().runSendSteps(message, [{ suppressSourceEmbeds: true, deleteSource: true }]);
    assert.deepEqual(message.postprocess, ['suppress', 'delete']);
    assert.equal(result.outcome, 'F');
});

test('file fallback prefers a public source URL over a local attachment path', async () => {
    const payloads = [];
    const message = source(async payload => {
        payloads.push(structuredClone(payload));
        if (payloads.length === 1) throw { status: 413 };
        return { id: 'fallback' };
    });
    const result = await dispatcher().runSendSteps(message, [{
        files: [{ attachment: 'C:\\private\\cache\\video.mp4', fallbackUrl: 'https://media.example/video.mp4' }], deleteSource: true,
    }]);
    assert.equal(payloads[1].content, 'https://media.example/video.mp4');
    assert.doesNotMatch(JSON.stringify(payloads[1]), /private|cache/);
    assert.equal(result.outcome, 'D');
    assert.deepEqual(message.postprocess, ['delete']);
});

test('local files and spoiler files without a safe fallback do not leak paths or uncover media', async () => {
    for (const file of ['C:\\private\\cache\\video.mp4', '/tmp/private/image.png',
        { attachment: 'https://media.example/sensitive.jpg', name: 'SPOILER_photo.jpg' }]) {
        const payloads = [];
        const message = source(async payload => {
            payloads.push(structuredClone(payload));
            if (payloads.length === 1) throw { status: 413 };
            return { id: 'leaked' };
        });
        const result = await dispatcher().runSendSteps(message, [{ files: [file], deleteSource: true }]);
        assert.equal(payloads.length, 1, JSON.stringify(file));
        assert.deepEqual(message.postprocess, []);
        assert.equal(result.outcome, 'E');
    }
});

test('metadata-only fallback keeps the source when an attachment has no public replacement', async () => {
    const payloads = [];
    const message = source(async payload => {
        payloads.push(structuredClone(payload));
        if (payloads.length === 1) throw { status: 413 };
        return { id: 'metadata' };
    });
    const result = await dispatcher().runSendSteps(message, [{
        embeds: [{ title: 'Metadata', url: 'https://example.test/original' }],
        files: [{ attachment: 'https://media.example/hidden.jpg', name: 'SPOILER_photo.jpg' }],
        suppressSourceEmbeds: true, deleteSource: true,
    }]);
    assert.equal(payloads.length, 2);
    assert.equal(result.outcome, 'D');
    assert.deepEqual(message.postprocess, []);
    assert.doesNotMatch(JSON.stringify(payloads[1]), /hidden.jpg/);
});
