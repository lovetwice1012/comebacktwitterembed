'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { PermissionFlagsBits } = require('discord.js');

function fixture() {
    const calls = [], replies = [];
    const filename = path.resolve(__dirname, '../../src/commands/handlers/messageExpansion.js');
    const requireActual = createRequire(filename), mod = { exports: {} };
    const rows = [{ trace_id: 'trace', state: 'failed', outcome: 'extract_failed', provider_id: 'twitter', raw_url: 'https://x.com/u/status/1',
        updated_at_ms: Date.now() - 60000, has_output: 0, has_delivery: 0, error_json: '{"status":429,"message":"private-secret"}' }];
    const service = { retryMessage: async (client, source) => { calls.push({ retry: source, client }); return { status: 'processed', count: 1 }; } };
    const mocks = {
        '../../expansionTraceStore': { getMessageExpansionTraces: async source => { calls.push({ history: source }); return rows; }, _internal: require('../../src/expansionTraceStore')._internal },
        '../../handlers/messageCreate': service,
    };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => mocks[id] || requireActual(id), mod, mod.exports);
    const member = { roles: { cache: new Map([['current-role', {}]]) } };
    const message = { id: 'source', guildId: 'guild', channelId: 'channel', content: 'https://x.com/u/status/1', author: { id: 'author', bot: false },
        guild: { id: 'guild', members: { fetch: async options => { calls.push({ member: options }); return member; } } } };
    const permissions = new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
    const interaction = { locale: 'ja', guildId: 'guild', channelId: 'channel', targetId: 'source', user: { id: 'author' },
        memberPermissions: { has: value => (Array.isArray(value) ? value : [value]).every(bit => permissions.has(bit)) },
        channel: { messages: { fetch: async options => { calls.push({ message: options }); return message; } } },
        editReply: async value => replies.push(value), followUp: async value => replies.push(value) };
    return { module: mod.exports, calls, rows, service, interaction, message, permissions, replies, member };
}

test('message menu definitions register separately from slash commands and always defer privately', () => {
    const { buildApplicationCommands, buildSlashCommands } = require('../../src/commands');
    const { shouldDeferEphemeral } = require('../../src/handlers/applicationCommands')._internal;
    const commands = buildApplicationCommands().filter(command => command.type === 3);
    assert.equal(commands.length, 2);
    assert.ok(commands.every(command => command.dm_permission === false && command.name_localizations.ja));
    assert.ok(buildSlashCommands().every(command => command.type !== 3));
    assert.ok(commands.every(command => shouldDeferEphemeral({ commandType: 3, commandName: command.name })));
});

test('status fetches the current source message, exposes no raw errors, and does not resend', async () => {
    const f = fixture();
    await f.module._internal.execute(f.interaction, {});
    assert.deepEqual(f.calls[0], { message: { message: 'source', force: true, cache: false } });
    assert.ok(!f.calls.some(call => call.retry || call.member));
    assert.match(f.replies[0].embeds[0].description, /利用制限/);
    assert.match(f.replies[0].embeds[0].description, /再試行可能/);
    assert.match(f.replies[0].embeds[0].description, /\[twitter \/ 1\]\(https:\/\/x.com\/u\/status\/1\)/);
    assert.doesNotMatch(JSON.stringify(f.replies), /private-secret|error_json|trace_id/);
});

test('retry uses the original author with refreshed roles and the shared message pipeline', async () => {
    const f = fixture(), client = {};
    await f.module._internal.execute(f.interaction, client, true);
    assert.deepEqual(f.calls[1], { member: { user: 'author', force: true } });
    assert.equal(f.calls[2].retry, f.message);
    assert.equal(f.calls[2].client, client);
    assert.equal(f.message.member, f.member);
    assert.match(f.replies[0].embeds[0].description, /1件再試行/);
});

test('another user cannot retry without Manage Messages, but a moderator can', async () => {
    const f = fixture(); f.interaction.user.id = 'other';
    await f.module._internal.execute(f.interaction, {}, true);
    assert.equal(f.calls.length, 1);
    assert.match(f.replies[0].content, /メッセージ管理権限/);
    f.permissions.add(PermissionFlagsBits.ManageMessages);
    await f.module._internal.execute(f.interaction, {}, true);
    assert.ok(f.calls.some(call => call.retry));
});

test('visibility and member lookup failures fail closed; cross-channel and Bot messages cannot be retried', async () => {
    for (const setup of [
        f => f.permissions.delete(PermissionFlagsBits.ReadMessageHistory),
        f => { f.message.channelId = 'other'; },
        f => { f.message.guildId = 'other'; },
        f => { f.message.author.bot = true; },
        f => { f.message.webhookId = 'webhook'; },
        f => { f.message.guild.members.fetch = async () => { throw new Error('secret'); }; },
        f => { f.interaction.channel.messages.fetch = async () => { throw new Error('secret'); }; },
    ]) {
        const f = fixture(); setup(f);
        await f.module._internal.execute(f.interaction, {}, true);
        assert.ok(!f.calls.some(call => call.retry || call.history));
        assert.equal(f.replies.length, 1);
        assert.doesNotMatch(JSON.stringify(f.replies), /secret/);
    }
});

test('busy processing, ineligible retries and truncated histories explain why no resend occurs', async () => {
    const f = fixture();
    f.service.retryMessage = async () => ({ status: 'busy' });
    await f.module._internal.execute(f.interaction, {}, true);
    assert.match(f.replies[0].content, /処理中/);
    f.service.retryMessage = async () => ({ status: 'not_retryable' });
    while (f.rows.length < 101) f.rows.push({ ...f.rows[0] });
    await f.module._internal.execute(f.interaction, {}, true);
    const text = f.replies[1].embeds[0].description;
    assert.match(text, /30秒/);
    assert.match(text, /一部を表示/);
    assert.doesNotMatch(text, /再試行可能/);
});
