'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { permissions, has, VIEW, SEND, MANAGE_WEBHOOKS, webhookParts, createDestinations } = require('../../src/automation/destinations');
const { assertMonitorAccess, publicMonitor, createMonitors } = require('../../src/automation/monitors');
const { createService } = require('../../src/automation/service');
const G = '111111111111111111', U = '222222222222222222', B = '333333333333333333', C = '444444444444444444', W = '555555555555555555';
const actor = { userId: U, guildId: G, canView: true, canEdit: true };
const guild = { id: G, owner_id: '666666666666666666' };
const member = { user: { id: U }, roles: ['r1', 'r2'] };
const channel = { id: C, guild_id: G, type: 0, name: 'test', permission_overwrites: [] };
const roles = [{ id: G, permissions: String(VIEW | SEND) }, { id: 'r1', permissions: String(MANAGE_WEBHOOKS) }, { id: 'r2', permissions: '0' }];
const secret = 'a'.repeat(60);

test('channel permissions union role allows, then member overrides, owner/admin bypass, timeout denial', () => {
    const ch = { ...channel, permission_overwrites: [{ id: 'r1', type: 0, deny: String(MANAGE_WEBHOOKS), allow: '0' }, { id: 'r2', type: 0, deny: '0', allow: String(MANAGE_WEBHOOKS) }] };
    assert(has(permissions(guild, roles, member, ch), VIEW | SEND | MANAGE_WEBHOOKS));
    ch.permission_overwrites.push({ id: U, type: 1, deny: String(SEND), allow: '0' });
    assert(!has(permissions(guild, roles, member, ch), SEND));
    assert(has(permissions({ ...guild, owner_id: U }, roles, member, ch), MANAGE_WEBHOOKS | SEND));
    assert(has(permissions(guild, [{ id: G, permissions: '8' }], member, ch), MANAGE_WEBHOOKS | SEND));
    assert(!has(permissions(guild, roles, { ...member, communication_disabled_until: '2030-01-01' }, channel, Date.parse('2026-01-01')), SEND));
    assert.equal(permissions(guild, roles, null, channel), 0n);
});

test('webhook input is constrained to official HTTPS endpoint; URL never survives public monitor shaping', () => {
    assert.equal(webhookParts(`https://discord.com/api/v10/webhooks/${W}/${secret}`).url, `https://discord.com/api/webhooks/${W}/${secret}`);
    for (const raw of [`https://discord.com.evil.test/api/webhooks/${W}/${secret}`, `http://discord.com/api/webhooks/${W}/${secret}`, `https://discord.com/api/webhooks/${W}/${secret}?wait=true`, 'http://localhost/']) assert.throws(() => webhookParts(raw));
    const out = publicMonitor('auto', { id: '1', user_id: U, guild_id: G, destination_type: 'webhook', webhook_url: secret });
    assert(!JSON.stringify(out).includes(secret));
    const telemetry = require('../../src/adminSupport/telemetry');
    assert(!JSON.stringify(telemetry.serializable({ message: `input https://discord.com/api/v10/webhooks/${W}/${secret}`, token: secret })).includes(secret));
});

test('private and DM monitors cannot be read or edited by another guild/platform administrator', () => {
    const other = { ...actor, userId: B, isAdmin: true };
    assert.throws(() => assertMonitorAccess(other, { user_id: U, guild_id: G, scope: 'private', destination_type: 'webhook' }, true), { status: 404 });
    assert.throws(() => assertMonitorAccess(other, { user_id: U, guild_id: G, destination_type: 'dm' }), { status: 404 });
    assert.doesNotThrow(() => assertMonitorAccess(other, { user_id: U, guild_id: G, destination_type: 'webhook' }, true));
    assert.throws(() => assertMonitorAccess({ ...other, canEdit: false }, { user_id: U, guild_id: G, destination_type: 'webhook' }, true), { status: 403 });
    assert.throws(() => assertMonitorAccess({ ...actor, guildId: C }, { user_id: U, guild_id: G, destination_type: 'webhook' }), { status: 403 });
});

function discordMock(ch = channel, guildRoles = roles) {
    const calls = [];
    const rest = async (route, init) => {
        calls.push({ route, init });
        const data = route === `/guilds/${G}` ? guild : route === `/guilds/${G}/roles` ? guildRoles
            : route === `/guilds/${G}/members/${U}` ? member : route === '/users/@me' ? { id: B }
                : route === `/guilds/${G}/members/${B}` ? { user: { id: B }, roles: ['r1'] }
                    : route === `/channels/${C}` ? ch : route === `/guilds/${G}/channels` ? [ch]
                        : route === `/channels/${C}/webhooks` ? [{ id: W, type: 1, guild_id: G, channel_id: C, token: secret, name: 'ComebackTwitterEmbed Auto', user: { id: B } }]
                            : route === `/webhooks/${W}/${secret}` ? { id: W, type: 1, guild_id: G, channel_id: C } : null;
        if (!data) throw new Error('Unexpected mock route');
        return { data };
    };
    return { rest, calls };
}

test('channel creation requires fresh caller AND bot permissions; owned hook reuse causes no remote write', async () => {
    const mock = discordMock();
    const saved = [];
    const db = { queryDatabase: async () => [{ id: '7' }], withDatabaseTransaction: async fn => fn(async sql => sql.startsWith('SELECT id') ? [{ id: '7' }] : {}) };
    const api = createDestinations(db, { saveDestination: async (...args) => { saved.push(args); return { id: 'resource' }; } }, mock);
    assert((await api.channels(actor)).items[0].canCreateWebhook);
    await api.save(actor, { name: 'notify', kind: 'channel', channelId: C, scope: 'guild' });
    assert.equal(saved[0][2].createdByBot, true);
    assert(!mock.calls.some(call => call.init?.method === 'POST'));
    const denied = discordMock(channel, [{ id: G, permissions: String(VIEW | SEND) }]);
    await assert.rejects(createDestinations(db, {}, denied).save(actor, { name: 'notify', kind: 'channel', channelId: C, scope: 'guild' }), { code: 'CHANNEL_PERMISSION' });
    assert(!denied.calls.some(call => call.init?.method === 'POST'));
    const botDenied = discordMock({ ...channel, permission_overwrites: [{ id: B, type: 1, deny: String(MANAGE_WEBHOOKS), allow: '0' }] });
    await assert.rejects(createDestinations(db, {}, botDenied).save(actor, { name: 'notify', kind: 'channel', channelId: C }), { code: 'BOT_CHANNEL_PERMISSION' });
});

test('unauthorized destination edits fail before Discord access and error responses cannot include secrets', async () => {
    let calls = 0;
    const service = { getRow: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } };
    await assert.rejects(createDestinations({}, service, { rest: async () => { calls++; } }).save(actor, { kind: 'channel', name: 'x', channelId: C }, 'bad'), { status: 404 });
    assert.equal(calls, 0);
    const api = createDestinations({}, {}, { rest: async () => { throw Object.assign(new Error(secret), { status: 500, token: secret }); } });
    await assert.rejects(api.save(actor, { name: 'x', kind: 'webhook', webhookUrl: `https://discord.com/api/webhooks/${W}/${secret}` }), error => !JSON.stringify(error).includes(secret) && !error.message.includes(secret));
});

test('list pagination honors requested size instead of silently returning an extra authorized resource', async () => {
    const service = createService({ queryDatabase: async () => Array.from({ length: 4 }, (_, index) => ({ id: String(index), name: 'x', scope: 'private' })) });
    const result = await service.list('destination', actor, '', 3);
    assert.equal(result.items.length, 3); assert.equal(result.nextCursor, '2');
});

test('monitor pause does not require revoked remote permission and cancels old pending jobs atomically', async () => {
    const target = { id: '8', user_id: U, guild_id: G, scope: 'private', revision: 2, enabled: 1, provider_id: 'youtube', source_url: 'https://youtube.com/@test', destination_id: 'dest', destination_type: 'webhook' };
    const statements = [];
    const query = async (sql, params) => { statements.push({ sql, params }); return sql.startsWith('SELECT t.*') ? [target] : []; };
    const db = { queryDatabase: query, withDatabaseTransaction: async work => work(query) };
    const api = createMonitors(db, { audit: async () => {} }, { verifyChannel: async () => { throw new Error('Must not access Discord when pausing'); } }, {
        auto: { normalizeSource: () => ({ sourceKey: 'test', sourceUrl: target.source_url }) }, price: {}, slotDecision: async () => ({ premiumSlot: 0 }), normalizeRule: () => ({}),
    });
    const result = await api.save(actor, 'auto', { expectedRevision: 2, enabled: false }, '8');
    assert.equal(result.revision, 3);
    assert(statements.some(s => s.sql.includes("SET status='cancelled'")));
    assert(statements.some(s => s.sql.includes('UPDATE automation_jobs')));
    assert(statements.some(s => s.sql.includes('UPDATE automation_flow_runs')));
    await assert.rejects(api.save(actor, 'auto', { expectedRevision: 1, enabled: false }, '8'), { code: 'REVISION_CONFLICT' });
});
