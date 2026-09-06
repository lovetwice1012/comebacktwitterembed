'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Response } = require('node-fetch');
const savedRoot = require('../../src/savedRoot');

const userId = '123456789012345678';
const otherId = '223456789012345678';

async function fixture(work) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-saved-root-'));
    const cwd = process.cwd();
    const keys = ['SAVES_DIR', 'ADMIN_SUPPORT_DATA_DIR', 'NODE_ENV'];
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    const root = path.join(directory, 'custom', 'saves');
    fs.mkdirSync(root, { recursive: true });
    const working = path.join(directory, 'working');
    fs.mkdirSync(working);
    process.chdir(working);
    process.env.SAVES_DIR = root;
    process.env.ADMIN_SUPPORT_DATA_DIR = path.join(directory, 'ignored-support');
    process.env.NODE_ENV = 'test';
    try { await work({ root, directory, working }); }
    finally {
        process.chdir(cwd);
        for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('saved roots honor explicit configuration and preserve each legacy fallback without a symlink', async () => {
    await fixture(async ({ root, directory, working }) => {
        assert.equal(savedRoot.getSavedRoot('/ignored-repository'), root);
        delete process.env.SAVES_DIR;
        assert.equal(savedRoot.getSavedRoot('/ignored-repository'), path.join(directory, 'ignored-support', 'saves'));
        delete process.env.ADMIN_SUPPORT_DATA_DIR;
        assert.equal(savedRoot.getSavedRoot(), path.join(working, 'saves'));
        assert.equal(savedRoot.getSavedRoot(path.join(directory, 'repository')), path.join(directory, 'repository', 'saves'));
    });
});

test('new saves can be listed, read, counted and deleted through both command and admin paths outside cwd', async () => {
    await fixture(async ({ root, working }) => {
        const fetchPath = require.resolve('node-fetch');
        const savePath = require.resolve('../../src/components/savetweet');
        const twitterPath = require.resolve('../../src/providers/twitter');
        const savedModules = new Map([fetchPath, savePath, twitterPath].map(key => [key, require.cache[key]]));
        const content = Buffer.alloc(16384, 7);
        const fakeFetch = async url => String(url).includes('api.vxtwitter.com')
            ? new Response(JSON.stringify({ text: 'new candidate saved tweet', user_name: 'FixtureAuthor', tweetURL: String(url), mediaURLs: ['https://fixture.invalid/image.jpg'] }), { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response(content, { status: 200 });
        require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };
        delete require.cache[savePath];
        const embeds = [];
        require.cache[twitterPath] = { id: twitterPath, filename: twitterPath, loaded: true, exports: { sendTweetEmbed: async (_interaction, url, options) => { embeds.push({ url, options }); } } };
        const decoy = path.join(working, 'saves', userId, '123');
        fs.mkdirSync(decoy, { recursive: true });
        fs.writeFileSync(path.join(decoy, 'data.json'), '{"text":"old cwd data must remain untouched"}');
        const replies = [];
        const interaction = id => ({ user: { id: userId }, locale: 'en', options: { getString: () => id, getUser: () => null }, editReply: async value => { replies.push(value); }, followUp: async value => { replies.push(value); } });
        try {
            const save = require(savePath);
            const operations = require('../../src/adminSupport/operations');
            const show = require('../../src/providers/twitter/commands/showsavetweet');
            const remove = require('../../src/providers/twitter/commands/deletesavetweet');
            const quota = require('../../src/commands/handlers/quotastats');
            const settings = require('../../src/providers/_provider_settings');
            await settings.setSaveTweetQuotaOverride(userId, 1024 * 1024);
            assert.equal((await save.saveTweetByUrl(userId, 'https://twitter.com/fixture/status/123')).saved, true);
            const target = path.join(root, userId, '123');
            const data = JSON.parse(fs.readFileSync(path.join(target, 'data.json'), 'utf8'));
            assert.equal(data.text, 'new candidate saved tweet');
            const listed = await operations.savedAction('saved.list', { userId });
            assert.equal(listed.rows[0].data.text, data.text);
            const read = await operations.savedAction('saved.read', { userId, tweetId: '123' });
            assert.equal(read.data.text, data.text);
            const bytes = fs.readdirSync(target).reduce((sum, file) => sum + fs.statSync(path.join(target, file)).size, 0);
            assert.equal(await quota._internal.getSavedTweetUsageBytes(userId), bytes);
            assert.equal((await operations.savedAction('saved.quota', { userId })).usedBytes, bytes);
            await show.execute(interaction(null), {});
            assert.match(JSON.stringify(replies), /FixtureAuthor/);
            await show.execute(interaction('123'), {});
            assert.deepEqual(embeds, [{ url: `https://twidata.sprink.cloud/data/${userId}/123/data.json`, options: { forceSendMode: 'channel' } }]);
            await quota.execute(interaction(null), {});
            assert.equal(replies.at(-1).embeds[0].fields[0].value, (bytes / 1024 / 1024).toFixed(2) + 'MB');
            await remove.execute(interaction('123'), {});
            assert.equal(fs.existsSync(target), false);
            assert.equal(JSON.parse(fs.readFileSync(path.join(decoy, 'data.json'), 'utf8')).text, 'old cwd data must remain untouched');
            assert.equal((await save.saveTweetByUrl(userId, 'https://twitter.com/fixture/status/124')).saved, true);
            const deleted = await operations.savedAction('saved.delete', { userId, tweetId: '124' });
            assert.equal(fs.existsSync(path.join(root, userId, '124')), false);
            assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.admin-trash', deleted.recoveryReceipt, 'data.json'), 'utf8')).text, data.text);
            assert.equal(await quota._internal.getSavedTweetUsageBytes(userId), 0);
        } finally {
            for (const [key, value] of savedModules) { if (value) require.cache[key] = value; else delete require.cache[key]; }
        }
    });
});

test('slash-command IDs cannot read or delete another user via traversal, absolute paths or separators', async () => {
    await fixture(async ({ root }) => {
        const own = path.join(root, userId, '111');
        const other = path.join(root, otherId, '222');
        for (const directory of [own, other]) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'data.json'), '{"text":"protected","user_name":"fixture"}'); }
        const show = require('../../src/providers/twitter/commands/showsavetweet');
        const remove = require('../../src/providers/twitter/commands/deletesavetweet');
        const twitterPath = require.resolve('../../src/providers/twitter');
        const previous = require.cache[twitterPath];
        let displayed = 0;
        require.cache[twitterPath] = { id: twitterPath, filename: twitterPath, loaded: true, exports: { sendTweetEmbed: async () => { displayed++; } } };
        try {
            for (const id of [`../${otherId}/222`, `..\\${otherId}\\222`, other, `/${otherId}/222`, `\\${otherId}\\222`, '111/../../' + otherId + '/222', '111/data.json', '%2e%2e%2f' + otherId, '111?redirect=222', '.', '..']) {
                const interaction = { user: { id: userId }, locale: 'en', options: { getString: () => id }, editReply: async () => {} };
                await show.execute(interaction, {});
                await remove.execute(interaction, {});
                assert.equal(fs.readFileSync(path.join(other, 'data.json'), 'utf8'), '{"text":"protected","user_name":"fixture"}');
                assert.equal(fs.existsSync(own), true);
            }
            assert.equal(displayed, 0);
            assert.throws(() => savedRoot.resolveSavedPath('../outside'));
            assert.throws(() => savedRoot.assertSavedPath(root + '-other/data.json', { root }));
            assert.throws(() => savedRoot.resolveSavedPath(userId + '/.admin-save-journal.json'));
        } finally { if (previous) require.cache[twitterPath] = previous; else delete require.cache[twitterPath]; }
    });
});

test('configured root and inner user symlinks cannot redirect reads, quota or admin operations', async () => {
    await fixture(async ({ root, directory }) => {
        const outside = path.join(directory, 'outside');
        fs.mkdirSync(path.join(outside, '222'), { recursive: true });
        fs.writeFileSync(path.join(outside, '222', 'data.json'), '{"text":"outside"}');
        const link = path.join(root, userId);
        await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        const quota = require('../../src/commands/handlers/quotastats');
        const operations = require('../../src/adminSupport/operations');
        assert.throws(() => savedRoot.resolveSavedPath(userId + '/222/data.json', { mustExist: true }), /symbolic/);
        await assert.rejects(quota._internal.getSavedTweetUsageBytes(userId), /symbolic/);
        await assert.rejects(operations.safeSavedPath(userId, '222'), /symbolic/);
        const rootLink = path.join(directory, 'root-link');
        await fsp.symlink(root, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
        process.env.SAVES_DIR = rootLink;
        assert.throws(() => savedRoot.resolveSavedPath(otherId), /symbolic/);
        assert.equal(fs.readFileSync(path.join(outside, '222', 'data.json'), 'utf8'), '{"text":"outside"}');
    });
});
