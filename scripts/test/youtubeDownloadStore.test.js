'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const store = require('../../src/youtubeDownloadStore');
const storeModulePath = require.resolve('../../src/youtubeDownloadStore');
const fetchModulePath = require.resolve('node-fetch');

function loadStoreWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalStoreModule = require.cache[storeModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[storeModulePath];

    try {
        return require(storeModulePath);
    } finally {
        delete require.cache[storeModulePath];
        if (originalStoreModule) require.cache[storeModulePath] = originalStoreModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

async function makeTempRoot() {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'cte-youtube-downloads-'));
}

test('youtube download store cleanup deletes expired indexed files and old orphan dirs', async () => {
    const root = await makeTempRoot();
    store.configureForTest(root, 'https://cbte.sprink.cloud');

    try {
        const filesDir = store._internal.getFilesDir();
        await fsp.mkdir(path.join(filesDir, 'expired'), { recursive: true });
        await fsp.mkdir(path.join(filesDir, 'active'), { recursive: true });
        await fsp.mkdir(path.join(filesDir, 'orphan'), { recursive: true });
        await fsp.writeFile(path.join(filesDir, 'expired', 'old.mp4'), 'old');
        await fsp.writeFile(path.join(filesDir, 'active', 'new.mp4'), 'new');
        await fsp.writeFile(path.join(filesDir, 'orphan', 'lost.mp4'), 'lost');

        const now = Date.now();
        await store._internal.writeIndex({
            expired: {
                token: 'expired',
                filename: 'old.mp4',
                expiresAtMs: now - 1,
            },
            active: {
                token: 'active',
                filename: 'new.mp4',
                expiresAtMs: now + 60_000,
            },
        });

        const old = new Date(now - store._internal.ttlMs() - 60_000);
        await fsp.utimes(path.join(filesDir, 'orphan'), old, old);

        await store.cleanupExpiredDownloads(now);
        const index = await store._internal.readIndex();

        assert.equal(fs.existsSync(path.join(filesDir, 'expired')), false);
        assert.equal(fs.existsSync(path.join(filesDir, 'orphan')), false);
        assert.equal(fs.existsSync(path.join(filesDir, 'active', 'new.mp4')), true);
        assert.deepEqual(Object.keys(index), ['active']);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('youtube download store builds the requested public download URL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-youtube-download-url-'));
    store.configureForTest(root, 'https://cbte.sprink.cloud');

    try {
        assert.equal(
            store.publicUrlForRecord({ token: 'abc123token', filename: 'video name.mp4' }),
            'https://cbte.sprink.cloud/media/youtube/abc123token/video%20name.mp4'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('youtube download store uses audio-only format for YouTube Music links', () => {
    const presets = store._internal.downloadPresetsForUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ');

    assert.deepEqual(presets, [{
        formatCode: '774/bestaudio',
        presetKey: '774-opus',
        audioOption: 'none',
    }]);
    assert.equal(
        store._internal.requestBodyForPreset('https://music.youtube.com/watch?v=dQw4w9WgXcQ', presets[0]).formatCode,
        '774/bestaudio'
    );
});

test('youtube download store uses the best merged format for regular YouTube videos', () => {
    const presets = store._internal.downloadPresetsForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    assert.deepEqual(presets, [{
        formatCode: 'bestvideo+bestaudio/best',
        presetKey: 'best',
        audioOption: 'none',
    }]);
});

test('youtube download store keeps the download button disabled unless explicitly enabled', () => {
    const oldEnabled = process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
    try {
        delete process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
        assert.equal(store.isDownloadButtonEnabled(), false);

        process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED = 'true';
        assert.equal(store.isDownloadButtonEnabled(), true);
    } finally {
        if (oldEnabled === undefined) delete process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED;
        else process.env.YOUTUBE_DOWNLOAD_BUTTON_ENABLED = oldEnabled;
    }
});

test('youtube download store includes progress logs when yt-dlp fails', async () => {
    const root = await makeTempRoot();
    const calls = [];
    const fakeStore = loadStoreWithFetch(async (url, options = {}) => {
        calls.push({ url, options });

        if (url === 'https://yt-dlp.arcdc.jp/api/download' && options.method === 'POST') {
            return { ok: true, json: async () => ({ jobId: 'job-1' }) };
        }
        if (url === 'https://yt-dlp.arcdc.jp/api/download?jobId=job-1') {
            return {
                ok: false,
                status: 500,
                text: async () => '{"error":"yt-dlp exited with code 1"}',
            };
        }
        if (url === 'https://yt-dlp.arcdc.jp/api/progress?jobId=job-1') {
            return {
                ok: true,
                body: Readable.from([
                    'event: log\n',
                    'data: [download] Downloading item\n\n',
                    'event: log\n',
                    'data: ERROR: Requested format is not available\n\n',
                ]),
            };
        }
        throw new Error(`unexpected url ${url}`);
    });
    fakeStore.configureForTest(root, 'https://cbte.sprink.cloud');

    try {
        await assert.rejects(
            () => fakeStore.downloadYouTubeToCache('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
            (err) => {
                assert.match(err.message, /yt-dlp exited with code 1/);
                assert.match(err.message, /Requested format is not available/);
                assert.match(err.message, /formatCode=bestvideo\+bestaudio\/best/);
                assert.equal(err.progressLog.includes('ERROR: Requested format is not available'), true);
                return true;
            }
        );

        const post = calls.find(call => call.url === 'https://yt-dlp.arcdc.jp/api/download');
        assert.equal(JSON.parse(post.options.body).formatCode, 'bestvideo+bestaudio/best');
        assert.ok(calls.some(call => call.url === 'https://yt-dlp.arcdc.jp/api/progress?jobId=job-1'));
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
