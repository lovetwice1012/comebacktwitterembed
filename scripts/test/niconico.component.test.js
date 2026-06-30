'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('downloadNiconicoVideo returns a temporary public download link', async () => {
    const componentPath = require.resolve('../../src/components/downloadNiconicoVideo');
    const storePath = require.resolve('../../src/niconicoDownloadStore');
    const originalComponent = require.cache[componentPath];
    const originalStore = require.cache[storePath];
    const calls = [];

    require.cache[storePath] = {
        id: storePath,
        filename: storePath,
        loaded: true,
        exports: {
            isDownloadButtonEnabled: () => true,
            downloadNiconicoToCache: async (url) => {
                calls.push(url);
                return {
                    publicUrl: 'https://download.niconico.cbte.sprink.cloud/niconico-downloads/token/video.mp4',
                    expiresAtMs: 1_800_000,
                    sizeBytes: 12 * 1024 * 1024,
                };
            },
        },
    };
    delete require.cache[componentPath];

    try {
        const component = require(componentPath);
        const replies = [];
        const interaction = {
            message: {
                embeds: [{
                    url: 'https://www.nicovideo.jp/watch/sm9',
                }],
            },
            editReply: async (payload) => {
                replies.push(payload);
            },
        };

        await component.handle(interaction);

        assert.deepEqual(calls, ['https://www.nicovideo.jp/watch/sm9']);
        assert.equal(replies[0].content, 'Preparing the download. This can take a few minutes.');
        assert.ok(replies[1].content.includes('Download is ready.'));
        assert.ok(replies[1].content.includes('Size: 12.0 MiB'));
        assert.equal(
            replies[1].components[0].components[0].data.url,
            'https://download.niconico.cbte.sprink.cloud/niconico-downloads/token/video.mp4'
        );
    } finally {
        delete require.cache[componentPath];
        if (originalComponent) require.cache[componentPath] = originalComponent;
        if (originalStore) require.cache[storePath] = originalStore;
        else delete require.cache[storePath];
    }
});

test('downloadNiconicoVideo is temporarily disabled when the button flag is off', async () => {
    const componentPath = require.resolve('../../src/components/downloadNiconicoVideo');
    const storePath = require.resolve('../../src/niconicoDownloadStore');
    const originalComponent = require.cache[componentPath];
    const originalStore = require.cache[storePath];
    const calls = [];

    require.cache[storePath] = {
        id: storePath,
        filename: storePath,
        loaded: true,
        exports: {
            isDownloadButtonEnabled: () => false,
            downloadNiconicoToCache: async (url) => {
                calls.push(url);
                throw new Error('should not download');
            },
        },
    };
    delete require.cache[componentPath];

    try {
        const component = require(componentPath);
        const replies = [];
        const interaction = {
            message: {
                embeds: [{
                    url: 'https://www.nicovideo.jp/watch/sm9',
                }],
            },
            editReply: async (payload) => {
                replies.push(payload);
            },
        };

        await component.handle(interaction);

        assert.deepEqual(calls, []);
        assert.equal(replies[0].content, 'Niconico downloads are temporarily unavailable.');
    } finally {
        delete require.cache[componentPath];
        if (originalComponent) require.cache[componentPath] = originalComponent;
        if (originalStore) require.cache[storePath] = originalStore;
        else delete require.cache[storePath];
    }
});
