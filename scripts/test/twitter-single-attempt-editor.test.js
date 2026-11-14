'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { REST, DefaultRestOptions } = require('discord.js');
const { createSingleAttemptEditor } = require('../../src/providers/twitter/singleAttemptEditor')._internal;
const channelId = '333333333333333333', messageId = '444444444444444444', botId = '222222222222222222';

function fixture(makeRequest, configuredRequest = DefaultRestOptions.makeRequest) {
    const optionsSeen = [], client = { token: 'fixture-only', user: { id: botId }, options: { jsonTransformer: value => value },
        rest: { options: { ...DefaultRestOptions, makeRequest: configuredRequest } } };
    const channel = { id: channelId, client, messages: { _add: value => ({ ...value, channel, client }) } };
    const message = { id: messageId, channel, client, author: { id: botId } };
    const editor = createSingleAttemptEditor({ restFactory: options => { optionsSeen.push(options); return new REST({ ...options, makeRequest }); } });
    return { client, channel, message, editor, optionsSeen };
}
const response = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

test('attachment edit uses one PATCH and does not retry an unknown response', async () => {
    let calls = 0;
    const f = fixture(async (_url, init) => {
        calls++; assert.equal(init.method, 'PATCH');
        throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    });
    await assert.rejects(f.editor.forMessage(f.message).edit({ files: [Buffer.from('fixture')] }), { code: 'ECONNRESET' });
    assert.equal(calls, 1); assert.equal(f.optionsSeen[0].retries, 0);
    assert.equal(f.client.rest.options.retries, DefaultRestOptions.retries);
});

test('rate limit rejects rather than silently repeating an edit', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return response(429, { message: 'rate limited', retry_after: 0.01, global: false }, { 'retry-after': '0.01' }); });
    await assert.rejects(f.editor.forMessage(f.message).edit({ files: [Buffer.from('fixture')] }));
    assert.equal(calls, 1);
});

test('a confirmed response must identify the same Bot message and channel', async () => {
    let data = { id: messageId, channel_id: channelId };
    const f = fixture(async () => response(200, data));
    assert.equal((await f.editor.forMessage(f.message).edit({ files: [Buffer.from('fixture')] })).id, messageId);
    data = { id: '777777777777777777', channel_id: channelId };
    await assert.rejects(f.editor.forMessage(f.message).edit({ files: [Buffer.from('fixture')] }), { code: 'DISCORD_EDIT_RESULT_UNKNOWN' });
    data = { id: messageId, channel_id: '999999999999999999' };
    await assert.rejects(f.editor.forMessage(f.message).edit({ files: [Buffer.from('fixture')] }), { code: 'DISCORD_EDIT_RESULT_UNKNOWN' });
});

test('foreign authors, unsupported transports, and missing credentials never send', () => {
    let calls = 0;
    const f = fixture(async () => { calls++; });
    f.message.author.id = '888888888888888888'; assert.equal(f.editor.forMessage(f.message), null);
    f.message.author.id = botId; f.client.token = null; assert.equal(f.editor.forMessage(f.message), null);
    f.client.token = 'fixture-only'; f.client.rest.options.makeRequest = async () => {}; assert.equal(f.editor.forMessage(f.message), null);
    assert.equal(calls, 0);
});
