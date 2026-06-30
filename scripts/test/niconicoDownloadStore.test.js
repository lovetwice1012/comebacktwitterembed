'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const store = require('../../src/niconicoDownloadStore');
const storeModulePath = require.resolve('../../src/niconicoDownloadStore');
const apiModulePath = require.resolve('../../src/niconicoApi');
const fetchModulePath = require.resolve('node-fetch');

function loadStoreWithFetch(fakeFetch) {
    const originalFetchModule = require.cache[fetchModulePath];
    const originalApiModule = require.cache[apiModulePath];
    const originalStoreModule = require.cache[storeModulePath];

    require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fakeFetch,
    };
    delete require.cache[apiModulePath];
    delete require.cache[storeModulePath];

    try {
        return require(storeModulePath);
    } finally {
        delete require.cache[storeModulePath];
        delete require.cache[apiModulePath];
        if (originalStoreModule) require.cache[storeModulePath] = originalStoreModule;
        if (originalApiModule) require.cache[apiModulePath] = originalApiModule;
        if (originalFetchModule) require.cache[fetchModulePath] = originalFetchModule;
        else delete require.cache[fetchModulePath];
    }
}

async function makeTempRoot() {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'cte-niconico-downloads-'));
}

function headersWithCookies(cookies = []) {
    return { raw: () => ({ 'set-cookie': cookies }) };
}

function okJson(json, cookies = []) {
    return { ok: true, status: 200, json: async () => json, headers: headersWithCookies(cookies) };
}

function watchResponse() {
    return {
        meta: { status: 200, code: 'HTTP_200' },
        data: {
            response: {
                client: {
                    watchId: 'sm9',
                    watchTrackId: 'track-1',
                },
                video: {
                    id: 'sm9',
                    title: 'Nico Test / Title',
                },
                media: {
                    domand: {
                        accessRightKey: 'access-key',
                        videos: [
                            { id: 'video-low', isAvailable: true, label: '360p', qualityLevel: 1, width: 640, height: 360 },
                            { id: 'video-high', isAvailable: true, label: '720p', qualityLevel: 2, width: 1280, height: 720 },
                        ],
                        audios: [
                            { id: 'audio-low', isAvailable: true, qualityLevel: 1 },
                            { id: 'audio-high', isAvailable: true, qualityLevel: 2 },
                        ],
                    },
                },
            },
        },
    };
}

function fakeSpawnFactory(calls) {
    return (_command, args) => {
        calls.push({ args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(async () => {
            const outputPath = args[args.length - 1];
            await fsp.writeFile(outputPath, 'fake mp4');
            child.emit('close', 0);
        });
        return child;
    };
}

test('niconico download store builds public download URL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-niconico-download-url-'));
    store.configureForTest(root, 'https://cbte.sprink.cloud');

    try {
        assert.equal(
            store.publicUrlForRecord({ token: 'abc123token', filename: 'video name.mp4' }),
            'https://cbte.sprink.cloud/niconico-downloads/abc123token/video%20name.mp4'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('niconico download store shows the download button by default but allows explicit disable', () => {
    const oldEnabled = process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
    try {
        delete process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
        assert.equal(store.isDownloadButtonEnabled(), true);

        process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED = 'false';
        assert.equal(store.isDownloadButtonEnabled(), false);
    } finally {
        if (oldEnabled === undefined) delete process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED;
        else process.env.NICONICO_DOWNLOAD_BUTTON_ENABLED = oldEnabled;
    }
});

test('niconico download store creates an HLS session and runs ffmpeg with domand cookie', async () => {
    const root = await makeTempRoot();
    const requests = [];
    const spawnCalls = [];
    const fakeStore = loadStoreWithFetch(async (url, options = {}) => {
        requests.push({ url, options });

        if (url === 'https://www.nicovideo.jp/watch/sm9?responseType=json') {
            return okJson(watchResponse(), ['domand_bid=bid-1; Path=/']);
        }
        if (url.includes('/access-rights/hls?actionTrackId=track-1')) {
            assert.equal(options.method, 'POST');
            assert.equal(options.headers['X-Access-Right-Key'], 'access-key');
            assert.match(options.headers.Cookie, /domand_bid=bid-1/);
            assert.deepEqual(JSON.parse(options.body), {
                outputs: [['video-high', 'audio-high']],
            });
            return okJson({
                data: {
                    contentUrl: 'https://asset.domand.nicovideo.jp/hls/master.m3u8',
                },
            });
        }
        throw new Error(`unexpected url ${url}`);
    });
    fakeStore.configureForTest(root, 'https://download.example.test', fakeSpawnFactory(spawnCalls));

    try {
        const record = await fakeStore.downloadNiconicoToCache('https://www.nicovideo.jp/watch/sm9');

        assert.equal(record.filename, 'Nico Test _ Title.mp4');
        assert.equal(record.outputLabel, '720p');
        assert.equal(record.publicUrl.startsWith('https://download.example.test/niconico-downloads/'), true);
        assert.equal(requests.length, 2);
        assert.equal(spawnCalls.length, 1);
        assert.ok(spawnCalls[0].args.includes('https://asset.domand.nicovideo.jp/hls/master.m3u8'));
        assert.ok(spawnCalls[0].args.includes('Cookie: domand_bid=bid-1\r\nUser-Agent: niconico.py\r\nReferer: https://www.nicovideo.jp/\r\n'));

        const index = await fakeStore._internal.readIndex();
        assert.equal(index[record.token].filename, 'Nico Test _ Title.mp4');
        assert.equal(fs.existsSync(path.join(fakeStore._internal.getFilesDir(), record.token, record.filename)), true);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
