'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const handlerPath = require.resolve('../../src/commands/handlers/autoextract/unwatch');
const storePath = require.resolve('../../src/providers/autoWatch/store');
const trackingPath = require.resolve('../../src/errorTracking');

async function run({ thrown, fail = false, locale = 'ja', id = 42, diagnosticsFail = false, replyFail = false } = {}) {
    const saved = new Map([handlerPath, storePath, trackingPath].map(path => [path, require.cache[path]]));
    const deleted = [], diagnostics = [], replies = [];
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { deleteTarget: async (...args) => {
        deleted.push(args); if (fail) throw thrown;
    } } };
    require.cache[trackingPath] = { id: trackingPath, filename: trackingPath, loaded: true, exports: { recordError: (...args) => {
        diagnostics.push(args); if (diagnosticsFail) throw Error('diagnostic storage unavailable');
    } } };
    delete require.cache[handlerPath];
    try {
        let rejection;
        try { await require(handlerPath)({ locale, user: { id: '123456789012345678' }, guildId: 'guild-fixture', options: { getInteger: () => id },
            editReply: async payload => { replies.push(payload); if (replyFail) throw Error('private reply transport failure'); } }); }
        catch (error) { rejection = error; }
        return { deleted, diagnostics, replies, rejection };
    } finally {
        for (const [path, entry] of saved) { if (entry) require.cache[path] = entry; else delete require.cache[path]; }
    }
}

test('unwatch never exposes raw exception representations in its public reply', async () => {
    const marker = 'SECRET-FIXTURE https://internal.invalid/private?token=synthetic';
    const getter = Object.defineProperty({}, 'message', { get() { throw Error(marker); } });
    const codeGetter = Object.defineProperty({}, 'code', { get() { throw Error(marker); } });
    const cases = [Error(marker), { message: marker }, marker, { message: '', toString: () => marker },
        { code: 'UNEXPECTED', message: marker, stack: marker, cause: Error(marker) }, getter, codeGetter, null, undefined];
    for (const locale of ['ja', 'en-US']) for (const thrown of cases) {
        const result = await run({ fail: true, thrown, locale });
        assert.equal(result.rejection, undefined);
        assert.equal(result.replies.length, 1);
        assert.equal(result.replies[0].embeds[0].color, 0xe74c3c);
        assert.doesNotMatch(JSON.stringify(result.replies), /SECRET-FIXTURE|internal\.invalid|private|synthetic|transport/);
        assert.match(result.replies[0].embeds[0].description, locale === 'ja' ? /少し待って.*もう一度/ : /try again/i);
        assert.equal(result.diagnostics[0][0], thrown);
        assert.deepEqual(result.diagnostics[0][1], { source: 'autoextract.unwatch', userId: '123456789012345678', guildId: 'guild-fixture', details: { targetId: 42 } });
    }
});

test('unwatch not-found messages are static and do not reveal another owner or raw message', async () => {
    for (const locale of ['ja', 'en-US']) {
        const result = await run({ fail: true, locale, thrown: { code: 'AUTO_WATCH_NOT_FOUND', message: 'SECRET-FIXTURE owner=other-user' } });
        assert.match(result.replies[0].embeds[0].description, locale === 'ja' ? /一覧でID/ : /watch list/);
        assert.doesNotMatch(JSON.stringify(result.replies), /SECRET-FIXTURE|other-user/);
    }
});

test('unwatch diagnostics failure keeps safe retry guidance available', async () => {
    const result = await run({ fail: true, thrown: Error('SECRET-FIXTURE'), diagnosticsFail: true });
    assert.equal(result.rejection, undefined); assert.equal(result.replies.length, 1);
    assert.match(result.replies[0].embeds[0].description, /もう一度/);
});

test('unwatch preserves caller-scoped deletion and localized success', async () => {
    for (const locale of ['ja', 'en-US', '']) {
        const result = await run({ locale });
        assert.deepEqual(result.deleted, [['123456789012345678', 42]]); assert.deepEqual(result.diagnostics, []);
        assert.equal(result.replies.length, 1); assert.equal(result.replies[0].embeds[0].color, 0x1DA1F2);
        assert.match(result.replies[0].embeds[0].description, locale === 'ja' ? /削除しました/ : /deleted/);
    }
});

test('unwatch validates IDs before any delete or diagnostics', async () => {
    for (const id of [0, -1, null, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
        const result = await run({ id });
        assert.deepEqual(result.deleted, []); assert.deepEqual(result.diagnostics, []);
        assert.equal(result.replies.length, 1); assert.match(result.replies[0].embeds[0].description, /ID/);
    }
});

test('a Discord reply transport failure does not re-run deletion or mislabel successful deletion', async () => {
    const result = await run({ replyFail: true });
    assert.deepEqual(result.deleted, [['123456789012345678', 42]]); assert.deepEqual(result.diagnostics, []);
    assert.equal(result.replies.length, 1); assert.match(result.rejection.message, /reply transport/);
    assert.match(result.replies[0].embeds[0].description, /削除しました/);
});
