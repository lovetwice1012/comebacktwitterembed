'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../../src/youtubeDownloadStore');

async function makeTempRoot() {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'cte-youtube-downloads-'));
}

test('youtube download store cleanup deletes expired indexed files and old orphan dirs', async () => {
    const root = await makeTempRoot();
    store.configureForTest(root, 'https://download.youtube.cbte.sprink.cloud');

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
    store.configureForTest(root, 'https://download.youtube.cbte.sprink.cloud');

    try {
        assert.equal(
            store.publicUrlForRecord({ token: 'abc123token', filename: 'video name.mp4' }),
            'https://download.youtube.cbte.sprink.cloud/youtube-downloads/abc123token/video%20name.mp4'
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
