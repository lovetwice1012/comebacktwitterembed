'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../../src/handlers/messageComponents');

test('spoiler display unavailability is a private, specific notice and not an error log', async () => {
    const errorLog = mock.method(console, 'error', () => {});
    try {
        for (const [locale, code, pattern] of [
            ['ja', 'GRID_SPOILER_DISPLAY_UNAVAILABLE', /スポイラー保護.*現在の表示/],
            ['en-US', 'GRID_SPOILER_DISPLAY_UNAVAILABLE', /Spoiler protection.*current display/],
            ['ja', 'GRID_NO_DISPLAYABLE_IMAGES', /変更できる画像がありません/],
        ]) {
            let reply;
            await _internal.replyComponentError({ locale, deferred: true, editReply: async value => { reply = value; } }, new Error(code));
            assert.match(reply.content, pattern);
            assert.equal(reply.ephemeral, true);
        }
        assert.equal(errorLog.mock.calls.length, 0);
    } finally { errorLog.mock.restore(); }
});
