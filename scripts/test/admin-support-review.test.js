'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const nodeFetch = require('node-fetch');
const telemetry = require('../../src/adminSupport/telemetry');
const { withDeadline } = require('../../src/providerFetch');

function loadWithFetch(relative, fakeFetch) {
    const modulePath = require.resolve(relative);
    const fetchPath = require.resolve('node-fetch');
    const original = require.cache[modulePath], originalFetch = require.cache[fetchPath];
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };
    delete require.cache[modulePath];
    try { return require(modulePath); }
    finally {
        if (original) require.cache[modulePath] = original; else delete require.cache[modulePath];
        require.cache[fetchPath] = originalFetch;
    }
}
const jsonResponse = (data, status = 200) => new nodeFetch.Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('HTTP replay matches out-of-order parallel results and shares consumption across nested contexts', async () => {
    const replay = [
        { url: 'https://fixture.invalid/b', status: 200, body: 'B' },
        { url: 'https://fixture.invalid/a', status: 200, body: 'A1' },
        { url: 'https://fixture.invalid/a', status: 200, body: 'A2' },
    ];
    const fetch = withDeadline(() => { throw new Error('Replay must never access network'); });
    await telemetry.run({ preview: true, events: [], httpAttempts: [], replay, replayState: { consumed: new Set() } }, async () => {
        const first = await Promise.all([
            telemetry.run({}, async () => (await fetch('https://fixture.invalid/a')).text()),
            telemetry.run({}, async () => (await fetch('https://fixture.invalid/b')).text()),
        ]);
        assert.deepEqual(first, ['A1', 'B']);
        assert.equal(await (await fetch('https://fixture.invalid/a')).text(), 'A2');
        await assert.rejects(fetch('https://fixture.invalid/a'), { code: 'REPLAY_EVIDENCE_MISSING' });
    });
});
test('HTTP replay distinguishes request bodies at the same URL and refuses unknown bodies', async () => {
    const bodyA = '{"query":"A"}', bodyB = '{"query":"B"}';
    const replay = [bodyB, bodyA].map(body => ({ url: 'https://fixture.invalid/graphql', method: 'POST', status: 200,
        requestBodyHash: crypto.createHash('sha256').update(body).digest('hex'), body }));
    const fetch = withDeadline(() => { throw new Error('Replay must never access network'); });
    await telemetry.run({ preview: true, events: [], replay, replayState: { consumed: new Set() } }, async () => {
        assert.equal(await (await fetch('https://fixture.invalid/graphql', { method: 'POST', body: bodyA })).text(), bodyA);
        await assert.rejects(fetch('https://fixture.invalid/graphql', { method: 'POST', body: '{"query":"C"}' }), { code: 'REPLAY_EVIDENCE_MISSING' });
        assert.equal(await (await fetch('https://fixture.invalid/graphql', { method: 'POST', body: bodyB })).text(), bodyB);
    });
});
test('HTTP capture redacts OAuth credentials in evidence while provider receives the actual response', async () => {
    const httpAttempts = [];
    const fetch = withDeadline(async () => jsonResponse({ access_token: 'fixture-sensitive-token', expires_in: 300, content: 'retained' }));
    await telemetry.run({ preview: true, events: [], httpAttempts }, async () => {
        assert.equal((await (await fetch('https://fixture.invalid/oauth')).json()).access_token, 'fixture-sensitive-token');
    });
    assert.equal(httpAttempts[0].credentialsRedacted, true);
    assert.equal(httpAttempts[0].body.includes('fixture-sensitive-token'), false);
    assert.equal(JSON.parse(httpAttempts[0].body).content, 'retained');
});
test('every provider default validates, including Amazon surface target arrays', () => {
    const { catalog, validateSetting } = require('../../src/adminSupport/operations');
    const { loadProviders } = require('../../src/providers/_loader');
    for (const entry of catalog()) {
        const provider = loadProviders().find(item => item.id === entry.id);
        for (const [key, value] of Object.entries(entry.defaults)) assert.doesNotThrow(() => validateSetting(provider, key, value), `${entry.id}.${key}`);
    }
});
test('temporary diagnostic settings overrides can enable a disabled provider without changing baseline settings', async () => {
    const { execute } = require('../../src/adminSupport/worker');
    const input = { url: 'https://twitter.com/a/status/1', settings: { enabled: false, legacy_mode: true },
        settingsOverrides: { enabled: true }, httpAttempts: [{ url: 'https://api.vxtwitter.com/a/status/1', status: 200,
            body: JSON.stringify({ tweetURL: 'https://twitter.com/a/status/1', text: 'fixture', user_name: 'fixture', user_screen_name: 'fixture', replies: 0, retweets: 0, likes: 0, mediaURLs: [] }) }] };
    const result = await execute({ type: 'url.reparse', input });
    assert.equal(result.outcome, 'preview_generated');
    assert.equal(input.settings.enabled, false);
    assert.equal(result.settings.enabled, true);
});
test('attachment download transport failure is known not sent; a Discord success body without ID is unknown', async t => {
    const before = process.env.BOT_TOKEN; process.env.BOT_TOKEN = 'fixture-token';
    t.after(() => { if (before === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = before; });
    const guildId = '123456789012345678', channelId = '123456789012345679';
    const calls = [];
    const discord = loadWithFetch('../../src/adminSupport/discord', async (url, options) => {
        calls.push([url, options.method || 'GET']);
        if (url.includes('/guilds/')) return jsonResponse({ id: guildId, name: 'Fixture' });
        if (url.endsWith(`/channels/${channelId}`)) return jsonResponse({ id: channelId, guild_id: guildId, type: 0 });
        if (url.includes('/messages')) return jsonResponse({});
        throw Object.assign(new Error('Attachment connection reset'), { code: 'ECONNRESET' });
    });
    const failed = await discord.send({ guildId, channelId }, 'attachment', [{ files: ['https://fixture.invalid/file.jpg'] }]);
    assert.equal(failed.outcome, 'failed');
    assert.equal(calls.some(([, method]) => method === 'POST'), false);
    const unknown = await discord.send({ guildId, channelId }, 'missing-id', [{ content: 'Fixture only' }]);
    assert.equal(unknown.outcome, 'delivery_unknown');
    assert.equal(unknown.sentCount, 0);
    const failingDiscord = loadWithFetch('../../src/adminSupport/discord', async url => {
        if (url.includes('/guilds/')) return jsonResponse({ id: guildId });
        if (url.endsWith(`/channels/${channelId}`)) return jsonResponse({ id: channelId, guild_id: guildId, type: 0 });
        return jsonResponse({ message: 'Internal server error' }, 500);
    });
    assert.equal((await failingDiscord.send({ guildId, channelId }, 'server-error', [{ content: 'Fixture only' }])).outcome, 'delivery_unknown');
});
test('saved replacement preserves previous data on quota failure and keeps a recoverable previous version', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-save-review-'));
    const originalRoot = process.env.SAVES_DIR, originalEnv = process.env.NODE_ENV;
    process.env.SAVES_DIR = directory; process.env.NODE_ENV = 'test';
    const userId = '123456789012345678', tweetId = '123';
    const settings = require('../../src/providers/_provider_settings');
    t.after(async () => {
        if (originalRoot === undefined) delete process.env.SAVES_DIR; else process.env.SAVES_DIR = originalRoot;
        if (originalEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv;
        await fs.rm(directory, { recursive: true, force: true });
    });
    const target = path.join(directory, userId, tweetId);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'data.json'), '{"text":"original"}');
    const saved = loadWithFetch('../../src/components/savetweet', async () => jsonResponse({ text: 'replacement', tweetURL: `https://twitter.com/a/status/${tweetId}`, mediaURLs: [] }));
    await settings.setSaveTweetQuotaOverride(userId, 20);
    assert.deepEqual(await saved.saveTweetByUrl(userId, `https://twitter.com/a/status/${tweetId}`), { saved: false, reason: 'quota', tweetId });
    assert.equal(await fs.readFile(path.join(target, 'data.json'), 'utf8'), '{"text":"original"}');
    await settings.setSaveTweetQuotaOverride(userId, 1000);
    const replaced = await saved.saveTweetByUrl(userId, `https://twitter.com/a/status/${tweetId}`);
    assert.equal(replaced.saved, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(target, 'data.json'), 'utf8')).text, 'replacement');
    assert.equal(await fs.readFile(path.join(directory, '.admin-trash', replaced.previousVersionReceipt, 'data.json'), 'utf8'), '{"text":"original"}');
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
        if (String(from).includes('.admin-staging') && to === target) throw Object.assign(new Error('Fixture installation failure'), { code: 'EIO' });
        return originalRename(from, to);
    };
    try { await assert.rejects(saved.saveTweetByUrl(userId, `https://twitter.com/a/status/${tweetId}`), /Fixture installation failure/); }
    finally { fs.rename = originalRename; }
    assert.equal(JSON.parse(await fs.readFile(path.join(target, 'data.json'), 'utf8')).text, 'replacement', 'failed swap restores existing saved data');
    for (const value of ['https://fixture.invalid/a%2fb.jpg', 'https://fixture.invalid/a%5cb.jpg', 'https://fixture.invalid/a\\..\\config.json']) {
        assert.throws(() => saved._internal.safeMediaFileName(value), /Unsafe|Backslash/);
    }
    assert.equal(saved._internal.safeMediaFileName('https://fixture.invalid/picture.jpg?token=fixture'), 'picture.jpg');
});
