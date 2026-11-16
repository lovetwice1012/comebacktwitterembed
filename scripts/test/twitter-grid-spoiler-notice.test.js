'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../../src/handlers/messageComponents');

test('expected image-operation outcomes get private, specific notices without error logs', async () => {
    const errorLog = mock.method(console, 'error', () => {});
    try {
        for (const [locale, code, pattern] of [
            ['ja', 'GRID_SPOILER_DISPLAY_UNAVAILABLE', /スポイラー保護.*現在の表示/],
            ['en-US', 'GRID_SPOILER_DISPLAY_UNAVAILABLE', /Spoiler protection.*current display/],
            ['ja', 'GRID_NO_DISPLAYABLE_IMAGES', /変更できる画像がありません/],
            ['ja', 'GRID_CONFIRMATION_EXPIRED', /元の投稿からもう一度/],
            ['en-US', 'GRID_CONFIRMATION_EXPIRED', /Start again from the original post/],
        ]) {
            let reply;
            await _internal.replyComponentError({ locale, deferred: true, editReply: async value => { reply = value; } }, new Error(code));
            assert.match(reply.content, pattern);
            assert.equal(reply.ephemeral, true);
        }
        assert.equal(errorLog.mock.calls.length, 0);
    } finally { errorLog.mock.restore(); }
});

test('a failed recovery lookup records bounded protocol facts without private response text', async () => {
    const tracking = require('../../src/errorTracking'), modulePath = require.resolve('../../src/handlers/messageComponents');
    const records = [], patches = [mock.method(tracking, 'recordError', (error, context) => records.push({ error, context })),
        mock.method(tracking, 'recordMetric', () => {}), mock.method(console, 'error', () => {})];
    delete require.cache[modulePath];
    try {
        const handler = require(modulePath)._internal.replyComponentError;
        const error = Object.assign(new Error('GRID_LOCK_UNAVAILABLE'), { gridDiagnostic: { stage: 'recover_message_fetch',
            discordCode: 50013, httpStatus: 403, reason: 'discord', leaked: 'private secret' } });
        let reply;
        await handler({ locale: 'ja', deferred: true, editReply: async value => { reply = value; } }, error);
        assert.match(reply.content, /もう一度/);
        assert.deepEqual(records[0].context.details, { grid: { stage: 'recover_message_fetch', discordCode: 50013, httpStatus: 403, reason: 'discord' } });
        assert.equal(JSON.stringify(records[0].context.details).includes('private secret'), false);
    } finally {
        delete require.cache[modulePath];
        for (const patch of patches.reverse()) patch.mock.restore();
    }
});
