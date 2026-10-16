'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../../src/automation/service');
const { createDestinations, VIEW, SEND, MANAGE_WEBHOOKS } = require('../../src/automation/destinations');
const api = require('../../src/automation/api');

// Structure-only Discord fixtures: these IDs and this token identify no live
// destination. Every REST request and every database operation stays in memory.
const GUILD = '111111111111111111', OTHER_GUILD = '111111111111111112';
const USER = '222222222222222222', OTHER_USER = '222222222222222223';
const BOT = '333333333333333333', CHANNEL = '444444444444444444', HOOK = '555555555555555555';
const TOKEN = 'synthetic_destination_context_token_'.repeat(2);
const URL = `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`;
const actor = { userId: USER, guildId: GUILD, canView: false, canEdit: false };
const createInput = { name: '個人のチャンネル通知', kind: 'channel', scope: 'private', channelId: CHANNEL, enabled: true };

function fixture(options = {}) {
    const state = { destinations: new Map(), endpoints: new Map(), counters: new Map(), audits: [] };
    const statements = [], calls = [], admissions = [];
    const discord = {
        channel: { id: CHANNEL, guild_id: GUILD, type: 0, name: '通知', permission_overwrites: [] },
        user: { user: { id: USER }, roles: ['notifications'] },
        bot: { user: { id: BOT }, roles: ['notifications'] },
        hooks: options.hooks || [],
        returnedHook: { id: HOOK, type: 1, guild_id: GUILD, channel_id: CHANNEL, token: TOKEN, name: 'ComebackTwitterEmbed Auto', user: { id: BOT } },
        postError: null,
    };
    const query = async (sql, params = []) => {
        statements.push({ sql, params });
        if (sql.startsWith('INSERT IGNORE INTO automation_counters')) { state.counters.set(params[0], { counter_key: params[0] }); return { affectedRows: 1 }; }
        if (sql.startsWith('SELECT counter_key FROM automation_counters')) return [state.counters.get(params[0])].filter(Boolean);
        if (sql.startsWith('INSERT INTO webhook_endpoints')) {
            if (!state.endpoints.has(params[0])) state.endpoints.set(params[0], { id: String(state.endpoints.size + 1), webhook_url: params[1] });
            return { affectedRows: 1 };
        }
        if (sql.startsWith('SELECT id FROM webhook_endpoints')) return [state.endpoints.get(params[0])].filter(Boolean);
        if (sql.startsWith('SELECT webhook_url FROM webhook_endpoints')) return [...state.endpoints.values()].filter(row => row.id === String(params[0]));
        if (sql.startsWith('SELECT * FROM automation_destinations WHERE id=')) return [state.destinations.get(params[0])].filter(Boolean);
        if (sql.startsWith('SELECT * FROM automation_destinations WHERE deleted_at_ms')) {
            const [after, owner, guild, canView, limit] = params;
            return [...state.destinations.values()].filter(row => !row.deleted_at_ms && row.id > after
                && (row.scope === 'private' && row.owner_user_id === owner || row.scope === 'guild' && row.guild_id === guild && canView === 1))
                .sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
        }
        if (sql.startsWith('INSERT INTO automation_destinations')) {
            const columns = ['id', 'owner_user_id', 'guild_id', 'scope', 'name', 'kind', 'dm_user_id', 'webhook_endpoint_id', 'channel_id', 'created_by_bot', 'enabled', 'created_at_ms', 'updated_at_ms'];
            const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
            state.destinations.set(row.id, { ...row, revision: 1, deleted_at_ms: null });
            return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE automation_destinations SET name=')) {
            const row = state.destinations.get(params[3]);
            assert(row, 'Only a stored, authorized destination may be updated');
            Object.assign(row, { name: params[0], enabled: params[1], revision: row.revision + 1, updated_at_ms: params[2] });
            return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO automation_audit')) { state.audits.push(params); return { affectedRows: 1 }; }
        throw new Error('Unexpected in-memory destination query');
    };
    const db = { queryDatabase: query, withDatabaseTransaction: async work => {
        const snapshot = structuredClone(state);
        try { return await work(query); }
        catch (error) { Object.assign(state, snapshot); throw error; }
    } };
    const rest = async (route, init) => {
        calls.push({ route, method: init?.method || 'GET', body: init?.body });
        let result;
        if (route === `/guilds/${GUILD}`) result = { id: GUILD, owner_id: OTHER_USER };
        else if (route === `/guilds/${GUILD}/roles`) result = [{ id: GUILD, permissions: String(VIEW | SEND) }, { id: 'notifications', permissions: String(MANAGE_WEBHOOKS) }];
        else if (route === `/guilds/${GUILD}/members/${USER}`) result = discord.user;
        else if (route === `/guilds/${GUILD}/members/${BOT}`) result = discord.bot;
        else if (route === '/users/@me') result = { id: BOT };
        else if (route === `/guilds/${GUILD}/channels`) result = [discord.channel];
        else if (route === `/channels/${CHANNEL}`) result = discord.channel;
        else if (route === `/channels/${CHANNEL}/webhooks` && init?.method === 'POST') {
            if (discord.postError) throw discord.postError;
            result = discord.returnedHook;
            discord.hooks.push(structuredClone(result));
        } else if (route === `/channels/${CHANNEL}/webhooks`) result = discord.hooks;
        else if (route === `/webhooks/${HOOK}/${TOKEN}`) result = discord.returnedHook;
        else throw new Error('Unexpected synthetic Discord route');
        return { data: structuredClone(result) };
    };
    // Only operation admission is replaced. Resource ownership, revisions,
    // scope, destination shaping, audit and Discord authorization stay real.
    const service = createService(db, { rateLimiter: { consumeOperation: async (current, group) => admissions.push([current.userId, group]) } });
    const destinations = createDestinations(db, service, { rest });
    const dispatch = (method, path, body, current = actor) => {
        const [pathname, search = ''] = path.split('?');
        return api.dispatch({ method, path: pathname.split('/'), search: new URLSearchParams(search), body }, current, { service, destinations });
    };
    return { state, statements, calls, admissions, discord, service, destinations, dispatch };
}

const remoteWrites = f => f.calls.filter(call => call.method !== 'GET');
const databaseWrites = f => f.statements.filter(statement => !statement.sql.startsWith('SELECT'));
const editInput = revision => ({ name: '変更した通知先', kind: 'webhook', scope: 'private', enabled: false, expectedRevision: revision });
const destinationId = index => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const storedDestination = (id, overrides = {}) => ({ id, owner_user_id: USER, guild_id: GUILD, scope: 'private', name: '保存済み通知先', kind: 'webhook',
    channel_id: CHANNEL, created_by_bot: 1, enabled: 1, revision: 1, deleted_at_ms: null, webhook_endpoint_id: '1', webhook_url: URL, ...overrides });

test('destination API pagination returns every one of 103 personal rows while excluding interleaved other-owner and deleted rows', async () => {
    const f = fixture(), expected = [];
    for (let index = 1; index <= 103; index++) {
        const own = destinationId(index * 2), foreign = destinationId(index * 2 - 1);
        f.state.destinations.set(own, storedDestination(own)); expected.push(own);
        f.state.destinations.set(foreign, storedDestination(foreign, { owner_user_id: OTHER_USER }));
    }
    const deleted = destinationId(208), shared = destinationId(209);
    f.state.destinations.set(deleted, storedDestination(deleted, { deleted_at_ms: 123 }));
    f.state.destinations.set(shared, storedDestination(shared, { scope: 'guild' }));
    const owner = { userId: USER };
    const first = await f.dispatch('GET', 'destinations', undefined, owner);
    assert.equal(first.items.length, 100); assert.equal(first.nextCursor, expected[99]);
    const second = await f.dispatch('GET', `destinations?afterId=${encodeURIComponent(first.nextCursor)}`, undefined, owner);
    assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items].map(row => row.id), expected);
    const exhausted = await f.dispatch('GET', `destinations?afterId=${encodeURIComponent(second.items.at(-1).id)}`, undefined, owner);
    assert.deepEqual(exhausted, { items: [], nextCursor: null });
    assert(!JSON.stringify([first, second, exhausted]).includes(TOKEN));
    assert.equal(databaseWrites(f).length, 0); assert.equal(f.calls.length, 0); assert.equal(f.admissions.length, 0);
});

test('GET one destination returns the exact saved public DTO to its owner without reading or returning the webhook secret', async () => {
    const f = fixture(), id = destinationId(1);
    f.state.destinations.set(id, storedDestination(id, { revision: 7, name: '新しく保存した通知先', dm_user_id: USER }));
    const result = await f.dispatch('GET', `destinations/${id}`, undefined, { userId: USER });
    assert.deepEqual(result, { id, name: '新しく保存した通知先', scope: 'private', kind: 'webhook', channelId: CHANNEL, guildId: GUILD, enabled: true, revision: 7, createdByBot: true });
    assert(!JSON.stringify(result).includes(TOKEN)); assert(!JSON.stringify(result).includes(URL));
    assert(!Object.hasOwn(result, 'dm_user_id')); assert(!Object.hasOwn(result, 'webhook_endpoint_id'));
    assert(!f.statements.some(statement => statement.sql.includes('FROM webhook_endpoints')));
    await assert.rejects(f.dispatch('GET', `destinations/${id}`, undefined, { ...actor, userId: OTHER_USER, canView: true, canEdit: true, isAdmin: true }), { code: 'NOT_FOUND', status: 404 });
    assert.equal(databaseWrites(f).length, 0); assert.equal(f.calls.length, 0);
});

test('GET one shared destination requires current read access to the same guild even for its owner or a platform administrator', async () => {
    const f = fixture(), id = destinationId(1);
    f.state.destinations.set(id, storedDestination(id, { scope: 'guild' }));
    const viewer = { ...actor, userId: OTHER_USER, canView: true, canEdit: false };
    const result = await f.dispatch('GET', `destinations/${id}`, undefined, viewer);
    assert.equal(result.id, id); assert.equal(result.scope, 'guild');
    assert(!JSON.stringify(result).includes(TOKEN));
    for (const denied of [{ userId: USER }, { ...actor, isAdmin: true }, { ...viewer, guildId: OTHER_GUILD }]) {
        await assert.rejects(f.dispatch('GET', `destinations/${id}`, undefined, denied), { code: 'FORBIDDEN', status: 403 });
    }
    assert.equal(databaseWrites(f).length, 0); assert.equal(f.calls.length, 0);
});

test('GET destinations rejects missing, deleted and invalid IDs and does not expose unknown action routes', async () => {
    const f = fixture(), id = destinationId(1), deleted = destinationId(2);
    f.state.destinations.set(id, storedDestination(id));
    f.state.destinations.set(deleted, storedDestination(deleted, { deleted_at_ms: 123 }));
    for (const path of [`destinations/${destinationId(3)}`, `destinations/${deleted}`, 'destinations/invalid-id', `destinations/${id}/raw`, `destinations/${id}/webhook`]) {
        await assert.rejects(f.dispatch('GET', path), { code: 'NOT_FOUND', status: 404 });
    }
    assert.equal(databaseWrites(f).length, 0); assert.equal(f.calls.length, 0); assert.equal(f.admissions.length, 0);
});

test('personal channel discovery is read-only until explicit POST and creates an owner-only destination in its guild context', async () => {
    const f = fixture();
    assert.equal((await f.dispatch('GET', 'channels')).items[0].canCreateWebhook, true);
    assert.deepEqual((await f.dispatch('GET', 'destinations', undefined, { userId: USER })).items, []);
    assert.equal(remoteWrites(f).length, 0); assert.equal(databaseWrites(f).length, 0);
    const saved = await f.dispatch('POST', 'destinations', createInput);
    assert.match(saved.id, /^[0-9a-f-]{36}$/); assert.deepEqual(Object.keys(saved), ['id']);
    assert.equal(remoteWrites(f).length, 1); assert.equal(remoteWrites(f)[0].route, `/channels/${CHANNEL}/webhooks`);
    const row = f.state.destinations.get(saved.id);
    assert.equal(row.owner_user_id, USER); assert.equal(row.scope, 'private'); assert.equal(row.guild_id, GUILD);
    assert.equal(row.channel_id, CHANNEL); assert.equal(row.kind, 'webhook'); assert.equal(row.created_by_bot, 1);
    const own = await f.dispatch('GET', 'destinations', undefined, { userId: USER });
    assert.equal(own.items[0].id, saved.id); assert.equal(own.items[0].createdByBot, true);
    const other = await f.dispatch('GET', 'destinations', undefined, { ...actor, userId: OTHER_USER, canView: true, canEdit: true, isAdmin: true });
    assert.equal(other.items.length, 0, 'Guild and platform administrators cannot discover a personal destination');
    assert(!JSON.stringify([saved, own, other, f.state.audits]).includes(TOKEN));
    assert(!JSON.stringify([saved, own, f.state.audits]).includes(URL));
    assert.deepEqual(f.admissions, [[USER, 'write']], 'Dispatcher, Discord preflight and storage share one write admission');
});

test('a personal channel destination is edited with its original guild without changing its endpoint or creating another webhook', async () => {
    const f = fixture(), saved = await f.dispatch('POST', 'destinations', createInput);
    const before = structuredClone(f.state.destinations.get(saved.id));
    f.calls.length = 0;
    await assert.rejects(f.dispatch('PATCH', `destinations/${saved.id}`, editInput(1), { userId: USER }), { code: 'GUILD_REQUIRED' });
    await assert.rejects(f.dispatch('PATCH', `destinations/${saved.id}`, editInput(1), { ...actor, guildId: OTHER_GUILD }), { code: 'SCOPE_IMMUTABLE' });
    assert.equal(f.calls.length, 0, 'Wrong context is rejected before remote requests');
    await f.dispatch('PATCH', `destinations/${saved.id}`, editInput(1));
    const after = f.state.destinations.get(saved.id);
    assert.equal(after.name, '変更した通知先'); assert.equal(after.enabled, 0); assert.equal(after.revision, 2);
    for (const field of ['id', 'owner_user_id', 'guild_id', 'scope', 'kind', 'channel_id', 'webhook_endpoint_id', 'created_by_bot']) assert.equal(after[field], before[field]);
    assert.equal(remoteWrites(f).length, 0);
    assert(!JSON.stringify(f.state.audits).includes(TOKEN));
});

test('real destination ownership and stale revisions reject edits before any remote operation', async () => {
    const f = fixture(), saved = await f.dispatch('POST', 'destinations', createInput);
    const before = structuredClone(f.state.destinations.get(saved.id));
    f.calls.length = 0;
    await assert.rejects(f.dispatch('PATCH', `destinations/${saved.id}`, editInput(1), { ...actor, userId: OTHER_USER, canView: true, canEdit: true, isAdmin: true }), { code: 'NOT_FOUND', status: 404 });
    await assert.rejects(f.dispatch('PATCH', `destinations/${saved.id}`, editInput(0)), { code: 'REVISION_CONFLICT', status: 409 });
    assert.equal(f.calls.length, 0); assert.deepEqual(f.state.destinations.get(saved.id), before);
});

test('channel permissions are checked again after discovery before a private webhook is created', async t => {
    for (const principal of ['user', 'bot']) await t.test(`${principal} channel overwrite revoked after discovery`, async () => {
        const f = fixture();
        assert.equal((await f.dispatch('GET', 'channels')).items[0].canCreateWebhook, true);
        f.discord.channel.permission_overwrites.push({ id: principal === 'user' ? USER : BOT, type: 1, allow: '0', deny: String(MANAGE_WEBHOOKS) });
        assert.equal((await f.dispatch('GET', 'channels')).items[0].canCreateWebhook, false);
        await assert.rejects(f.dispatch('POST', 'destinations', createInput), { code: principal === 'user' ? 'CHANNEL_PERMISSION' : 'BOT_CHANNEL_PERMISSION', status: 403 });
        assert.equal(remoteWrites(f).length, 0); assert.equal(databaseWrites(f).length, 0);
    });
    await t.test('caller membership identity no longer matches', async () => {
        const f = fixture();
        assert.equal((await f.dispatch('GET', 'channels')).items[0].canCreateWebhook, true);
        f.discord.user.user.id = OTHER_USER;
        await assert.rejects(f.dispatch('POST', 'destinations', createInput), { code: 'DISCORD_ACCESS_DENIED', status: 403 });
        assert.equal(remoteWrites(f).length, 0); assert.equal(databaseWrites(f).length, 0);
    });
});

test('a pasted webhook URL cannot register another guild or a different channel context', async t => {
    for (const mismatch of ['guild', 'channel']) await t.test(`${mismatch} mismatch`, async () => {
        const f = fixture();
        if (mismatch === 'guild') f.discord.returnedHook.guild_id = OTHER_GUILD;
        else f.discord.channel.guild_id = OTHER_GUILD;
        await assert.rejects(f.dispatch('POST', 'destinations', { name: '既存Webhook', kind: 'webhook', scope: 'private', webhookUrl: URL }), { code: mismatch === 'guild' ? 'WEBHOOK_GUILD_MISMATCH' : 'CHANNEL_MISMATCH' });
        assert.equal(remoteWrites(f).length, 0); assert.equal(databaseWrites(f).length, 0);
        assert.equal(f.state.destinations.size, 0); assert.equal(f.state.endpoints.size, 0);
    });
});

test('a verified pasted webhook becomes a private destination without creating or modifying the remote webhook', async () => {
    const f = fixture();
    const saved = await f.dispatch('POST', 'destinations', { name: '持ち込んだ通知先', kind: 'webhook', scope: 'private', webhookUrl: URL });
    const row = f.state.destinations.get(saved.id);
    assert.equal(row.owner_user_id, USER); assert.equal(row.guild_id, GUILD); assert.equal(row.scope, 'private');
    assert.equal(row.channel_id, CHANNEL); assert.equal(row.created_by_bot, 0);
    assert.equal(remoteWrites(f).length, 0, 'A pasted URL is verified with GET only');
    assert.equal((await f.service.list('destination', { userId: USER })).items[0].id, saved.id);
    assert(!JSON.stringify([saved, await f.service.list('destination', { userId: USER }), f.state.audits]).includes(TOKEN));
});

test('a same-name foreign webhook and an unrelated bot webhook are never adopted for a personal channel destination', async () => {
    const f = fixture({ hooks: [
        { id: '555555555555555556', type: 1, guild_id: GUILD, channel_id: CHANNEL, token: TOKEN, name: 'ComebackTwitterEmbed Auto', user: { id: OTHER_USER } },
        { id: '555555555555555557', type: 1, guild_id: GUILD, channel_id: CHANNEL, token: TOKEN, name: 'Unrelated notifications', user: { id: BOT } },
    ] });
    const saved = await f.dispatch('POST', 'destinations', createInput);
    assert.equal(remoteWrites(f).length, 1);
    assert.equal(f.state.destinations.get(saved.id).created_by_bot, 1);
    assert.equal([...f.state.endpoints.values()][0].webhook_url, URL);
    assert(!f.calls.some(call => call.method === 'DELETE'), 'Existing unrelated hooks remain intact');
});

test('unknown or rejected remote creation results preserve safe errors and never persist a destination', async t => {
    const cases = [[undefined, 'DISCORD_UNAVAILABLE', 503], [429, 'DISCORD_RATE_LIMITED', 503], [403, 'DISCORD_ACCESS_DENIED', 403]];
    for (const [remoteStatus, code, status] of cases) await t.test(`creation failure ${remoteStatus ?? 'unknown'}`, async () => {
        const f = fixture();
        f.discord.postError = Object.assign(new Error(`Synthetic remote body contains ${URL}`), { status: remoteStatus, token: TOKEN, response: { url: URL } });
        await assert.rejects(f.dispatch('POST', 'destinations', createInput), error => {
            assert.equal(error.code, code); assert.equal(error.status, status);
            assert(!`${error.message}${JSON.stringify(error)}`.includes(TOKEN));
            assert(!`${error.message}${JSON.stringify(error)}`.includes(URL));
            return true;
        });
        assert.equal(remoteWrites(f).length, 1, 'The explicit submission attempted creation only once');
        assert.equal(databaseWrites(f).length, 0); assert.equal(f.state.destinations.size, 0);
        assert.equal(f.state.endpoints.size, 0); assert.equal(f.state.audits.length, 0);
    });
    for (const missing of ['identity', 'token']) await t.test(`remote success without usable ${missing}`, async () => {
        const f = fixture();
        if (missing === 'identity') f.discord.returnedHook = { token: TOKEN };
        else delete f.discord.returnedHook.token;
        await assert.rejects(f.dispatch('POST', 'destinations', createInput), error => {
            assert.equal(error.code, missing === 'identity' ? 'WEBHOOK_GUILD_MISMATCH' : 'INVALID_WEBHOOK');
            assert(!`${error.message}${JSON.stringify(error)}`.includes(TOKEN));
            return true;
        });
        assert.equal(remoteWrites(f).length, 1); assert.equal(databaseWrites(f).length, 0);
        assert.equal(f.state.destinations.size, 0); assert.equal(f.state.endpoints.size, 0);
    });
});
