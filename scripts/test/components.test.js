'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const showAttachmentsAsEmbedsImage = require('../../src/components/showAttachmentsAsEmbedsImage');
const showMediaAsAttachments = require('../../src/components/showMediaAsAttachments');

const imageUrl = 'https://pbs.twimg.com/media/image-one.jpg?format=jpg&name=large';
const videoUrl = 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/movie.mp4?tag=12';

function buttons() {
    return {
        showMediaAsAttachmentsButton: { customId: 'showMediaAsAttachments' },
        showAttachmentsAsMediaButton: { customId: 'showAttachmentsAsEmbedsImage' },
        translateButton: { customId: 'translate' },
        deleteButton: { customId: 'delete' },
    };
}

function baseEmbed(overrides = {}) {
    return {
        title: 'Tweet author',
        url: 'https://twitter.com/a/status/1',
        description: 'tweet text',
        color: 0x1DA1F2,
        author: { name: 'request by user(id:user-1)' },
        timestamp: '2024-01-01T00:00:00.000Z',
        ...overrides,
    };
}

async function withoutTimers(fn) {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = () => 0;
    try {
        await fn();
    } finally {
        global.setTimeout = originalSetTimeout;
    }
}

test('showAttachmentsAsEmbedsImage keeps video attachments while embedding images', async () => {
    await withoutTimers(async () => {
        let editedMessage = null;
        let reply = null;
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: [
                    { url: imageUrl },
                    { url: videoUrl },
                ],
                embeds: [baseEmbed()],
                edit: async (payload) => {
                    editedMessage = payload;
                },
            },
            editReply: async (payload) => {
                reply = payload;
            },
            deleteReply: async () => {},
        };

        await showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() });

        assert.deepEqual(editedMessage.files, [videoUrl]);
        assert.equal(editedMessage.embeds.length, 1);
        assert.equal(editedMessage.embeds[0].image.url, imageUrl);
        assert.equal(reply.content, 'Finished action.');
    });
});

test('showMediaAsAttachments preserves existing video attachments', async () => {
    await withoutTimers(async () => {
        let editedMessage = null;
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: [
                    { url: videoUrl },
                ],
                embeds: [baseEmbed({ image: { url: imageUrl } })],
                edit: async (payload) => {
                    editedMessage = payload;
                },
            },
            editReply: async () => {},
            deleteReply: async () => {},
        };

        await showMediaAsAttachments.handle(interaction, { buttons: buttons() });

        assert.deepEqual(editedMessage.files, [videoUrl, imageUrl]);
        assert.equal(editedMessage.embeds.length, 1);
        assert.equal(editedMessage.embeds[0].image, undefined);
    });
});

test('translate preserves embed image in translated response', async () => {
    const translatePath = require.resolve('../../src/components/translate');
    const fetchPath = require.resolve('node-fetch');
    const originalTranslate = require.cache[translatePath];
    const originalFetch = require.cache[fetchPath];

    require.cache[fetchPath] = {
        id: fetchPath,
        filename: fetchPath,
        loaded: true,
        exports: async () => ({ text: async () => 'translated text' }),
    };
    delete require.cache[translatePath];

    try {
        const translate = require(translatePath);
        let reply = null;
        const interaction = {
            guildId: 'guild-components-translate',
            locale: 'en-US',
            message: {
                embeds: [baseEmbed({ image: { url: imageUrl } })],
                components: [],
                attachments: [],
            },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await translate.handle(interaction);

        assert.equal(reply.embeds[0].image.url, imageUrl);
        assert.equal(reply.embeds[0].description, 'translated text');
    } finally {
        delete require.cache[translatePath];
        if (originalTranslate) require.cache[translatePath] = originalTranslate;
        if (originalFetch) require.cache[fetchPath] = originalFetch;
        else delete require.cache[fetchPath];
    }
});
