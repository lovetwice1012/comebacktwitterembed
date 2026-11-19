'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const showAttachmentsAsEmbedsImage = require('../../src/components/showAttachmentsAsEmbedsImage');
const showMediaAsAttachments = require('../../src/components/showMediaAsAttachments');

const imageUrl = 'https://pbs.twimg.com/media/image-one.jpg?format=jpg&name=large';
const extensionlessImageUrl = 'https://image-cdn-ak.spotifycdn.com/image/ab67616d0000b27315ebbedaacef61af244262a8';
const videoUrl = 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/movie.mp4?tag=12';
const audioUrl = 'https://cdn.discordapp.com/attachments/1/2/spotify-preview-track.mp3?ex=1';

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

        assert.deepEqual(editedMessage.files, [
            videoUrl,
            { attachment: imageUrl, name: 'embed-image-1.jpg' },
        ]);
        assert.equal(editedMessage.embeds.length, 1);
        assert.equal(editedMessage.embeds[0].image.url, 'attachment://embed-image-1.jpg');
        assert.equal(reply.content, 'Finished action.');
    });
});

test('showAttachmentsAsEmbedsImage keeps audio attachments while embedding images', async () => {
    await withoutTimers(async () => {
        let editedMessage = null;
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: [
                    { url: imageUrl },
                    { url: audioUrl },
                ],
                embeds: [baseEmbed({ url: 'https://open.spotify.com/track/1' })],
                edit: async (payload) => {
                    editedMessage = payload;
                },
            },
            editReply: async () => {},
            deleteReply: async () => {},
        };

        await showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() });

        assert.deepEqual(editedMessage.files, [
            audioUrl,
            { attachment: imageUrl, name: 'embed-image-1.jpg' },
        ]);
        assert.equal(editedMessage.embeds.length, 1);
        assert.equal(editedMessage.embeds[0].image.url, 'attachment://embed-image-1.jpg');
    });
});

test('image display conversion keeps subsequent quoted embeds', async () => {
    await withoutTimers(async () => {
        let edited;
        const interaction = { guildId: 'guild-components', locale: 'en', message: {
            attachments: [{ id: '1', url: imageUrl, name: 'image.jpg', contentType: 'image/jpeg' }],
            embeds: [baseEmbed({ thumbnail: { url: imageUrl } }), { title: 'Quoted post', description: 'Quoted text', image: { url: imageUrl } }],
            edit: async payload => { edited = payload; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() });
        assert.equal(edited.embeds[0].thumbnail.url, imageUrl);
        assert.equal(edited.embeds[1].description, 'Quoted text');
        assert.equal(edited.embeds[1].image.url, imageUrl);
    });
});

test('image display conversion preserves PDF and other non-image attachments by identity', async () => {
    await withoutTimers(async () => {
        let edited;
        const interaction = { guildId: 'guild-components', locale: 'en', message: {
            attachments: [{ id: '111111111111111111', url: imageUrl, name: 'photo.jpg', contentType: 'image/jpeg' },
                { id: '222222222222222222', url: 'https://cdn.example/document.pdf', name: 'document.pdf', contentType: 'application/pdf', description: 'Fixture document' },
                { id: '333333333333333333', url: 'https://cdn.example/SPOILER_clip.mp4', name: 'SPOILER_clip.mp4', contentType: 'video/mp4', spoiler: true }],
            embeds: [baseEmbed()], edit: async value => { edited = value; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() });
        assert.deepEqual(edited.attachments, [{ id: '222222222222222222', description: 'Fixture document' }, { id: '333333333333333333' }]);
        assert.deepEqual(edited.files, [{ attachment: imageUrl, name: 'embed-image-1.jpg' }]);
        assert.equal(edited.embeds[0].image.url, 'attachment://embed-image-1.jpg');
    });
});

test('spoiler images never become uncovered embeds', async () => {
    for (const spoiler of [{ name: 'SPOILER_photo.jpg' }, { name: 'photo.jpg', spoiler: true }, { name: 'photo.jpg', flags: 8 },
        { name: 'photo.jpg', flags: { has: () => true } }]) {
        let edits = 0;
        const interaction = { guildId: 'guild-components', locale: 'en', message: {
            attachments: [{ ...spoiler, url: imageUrl, contentType: 'image/jpeg' }], embeds: [baseEmbed()], edit: async () => { edits++; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await assert.rejects(showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() }), /GRID_SPOILER_DISPLAY_UNAVAILABLE/);
        assert.equal(edits, 0);
    }
});

test('non-image-only and incomplete attachments do not report a successful conversion', async () => {
    for (const [attachments, expected] of [
        [[{ id: '222222222222222222', name: 'file.pdf', contentType: 'application/pdf' }], /GRID_NO_DISPLAYABLE_IMAGES/],
        [[{ id: '111111111111111111', name: 'photo.jpg', contentType: 'image/jpeg' }], /GRID_SOURCE_INCOMPLETE/],
        [[{ url: imageUrl, name: 'photo.jpg', contentType: 'image/jpeg' }, {}], /GRID_SOURCE_INCOMPLETE/],
    ]) {
        let edits = 0;
        const interaction = { guildId: 'guild-components', locale: 'en', message: { attachments, embeds: [baseEmbed()], edit: async () => { edits++; } }, editReply: async () => {} };
        await assert.rejects(showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() }), expected);
        assert.equal(edits, 0);
    }
});

test('showAttachmentsAsEmbedsImage rebuilds multi-image embed groups from attachments', async () => {
    await withoutTimers(async () => {
        let editedMessage = null;
        const images = Array.from({ length: 6 }, (_value, index) => ({
            url: `https://img.example/artwork-${index + 1}.jpg`,
        }));
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: images,
                embeds: [baseEmbed({ url: 'https://www.pixiv.net/artworks/123456' })],
                edit: async (payload) => {
                    editedMessage = payload;
                },
            },
            editReply: async () => {},
            deleteReply: async () => {},
        };

        await showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() });

        assert.equal(editedMessage.embeds.length, 6);
        assert.deepEqual(editedMessage.embeds.map(embed => embed.url), [
            'https://www.pixiv.net/artworks/123456',
            'https://www.pixiv.net/artworks/123456',
            'https://www.pixiv.net/artworks/123456',
            'https://www.pixiv.net/artworks/123456',
            'https://www.pixiv.net/artworks/123456#g1',
            'https://www.pixiv.net/artworks/123456#g1',
        ]);
        assert.equal(editedMessage.embeds[0].title, 'Tweet author');
        assert.equal(editedMessage.embeds[1].title, undefined);
        assert.equal(editedMessage.embeds[5].image.url, 'attachment://embed-image-6.jpg');
        assert.deepEqual(editedMessage.files, images.map((image, index) => ({
            attachment: image.url,
            name: `embed-image-${index + 1}.jpg`,
        })));
    });
});

test('showAttachmentsAsEmbedsImage keeps mixed video attachments while grouping image embeds', async () => {
    await withoutTimers(async () => {
        let editedMessage = null;
        const images = Array.from({ length: 5 }, (_value, index) => ({
            url: `https://pbs.twimg.com/media/mixed-${index + 1}.jpg`,
        }));
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: [
                    { url: videoUrl },
                    ...images,
                ],
                embeds: [baseEmbed({ url: 'https://twitter.com/a/status/1' })],
                edit: async (payload) => {
                    editedMessage = payload;
                },
            },
            editReply: async () => {},
            deleteReply: async () => {},
        };

        await showAttachmentsAsEmbedsImage.handle(interaction, { buttons: buttons() });

        assert.equal(editedMessage.embeds.length, 5);
        assert.deepEqual(editedMessage.embeds.map(embed => embed.url), [
            'https://twitter.com/a/status/1',
            'https://twitter.com/a/status/1',
            'https://twitter.com/a/status/1',
            'https://twitter.com/a/status/1',
            'https://twitter.com/a/status/1#g1',
        ]);
        assert.deepEqual(editedMessage.files, [
            videoUrl,
            ...images.map((image, index) => ({
                attachment: image.url,
                name: `embed-image-${index + 1}.jpg`,
            })),
        ]);
    });
});

test('showAttachmentsAsEmbedsImage refuses image embeds that would exceed file slots with videos', async () => {
    await withoutTimers(async () => {
        let editedMessage = null;
        let reply = null;
        const audioAttachments = Array.from({ length: 9 }, (_value, index) => ({
            url: `https://cdn.example/audio-${index + 1}.mp3`,
        }));
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: [
                    ...audioAttachments,
                    { url: 'https://img.example/one.jpg' },
                    { url: 'https://img.example/two.jpg' },
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

        assert.equal(editedMessage, null);
        assert.equal(reply, "You can't show more than 1 image attachments as embeds image while keeping non-image attachments.");
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

        assert.deepEqual(editedMessage.files, [videoUrl, { attachment: imageUrl, name: 'embed-image-1.jpg' }]);
        assert.equal(editedMessage.embeds.length, 1);
        assert.equal(editedMessage.embeds[0].image, undefined);
    });
});

test('attachment display retains existing files and the text of subsequent quoted Embeds', async () => {
    await withoutTimers(async () => {
        let edited;
        const interaction = { guildId: 'guild-components', locale: 'en', message: {
            attachments: [{ id: '222222222222222222', name: 'SPOILER_clip.mp4', url: videoUrl, spoiler: true, contentType: 'video/mp4' },
                { id: '333333333333333333', name: 'document.pdf', url: 'https://cdn.example/document.pdf', contentType: 'application/pdf' }],
            embeds: [baseEmbed({ image: { url: imageUrl } }),
                { title: 'Quoted post', description: 'Quoted text', url: 'https://example.test/quote', image: { url: 'https://img.example/quoted.png' } },
                { url: 'https://example.test/group', image: { url: 'https://img.example/third.png' } }],
            edit: async value => { edited = value; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await showMediaAsAttachments.handle(interaction, { buttons: buttons() });
        assert.deepEqual(edited.attachments, [{ id: '222222222222222222' }, { id: '333333333333333333' }]);
        assert.deepEqual(edited.files, [{ attachment: imageUrl, name: 'embed-image-1.jpg' }, 'https://img.example/quoted.png', 'https://img.example/third.png']);
        assert.equal(edited.embeds.length, 2); assert.equal(edited.embeds[1].title, 'Quoted post');
        assert.equal(edited.embeds[1].description, 'Quoted text'); assert.equal(edited.embeds[1].url, 'https://example.test/quote');
    });
});

test('a retained Discord attachment is not reuploaded when its signed image URL changes', async () => {
    await withoutTimers(async () => {
        let edited;
        const channelId = '444444444444444444', fileId = '555555555555555555';
        const base = `https://cdn.discordapp.com/attachments/${channelId}/${fileId}/photo.png`;
        const interaction = { guildId: 'guild-components', channelId, locale: 'en', message: {
            channelId, attachments: [{ id: fileId, name: 'photo.png', contentType: 'image/png', url: `${base}?ex=1&is=2&hm=aa` }],
            embeds: [baseEmbed({ image: { url: `${base}?ex=3&is=4&hm=bb` } })], edit: async value => { edited = value; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await showMediaAsAttachments.handle(interaction, { buttons: buttons() });
        assert.deepEqual(edited.attachments, [{ id: fileId }]); assert.deepEqual(edited.files, []);
        assert.equal(edited.embeds[0].image, undefined);
    });
});

test('a message without images does not report a successful attachment conversion', async () => {
    let edits = 0;
    const interaction = { guildId: 'guild-components', locale: 'en', message: {
        attachments: [{ id: '222222222222222222', url: videoUrl, name: 'clip.mp4' }], embeds: [baseEmbed()], edit: async () => { edits++; },
    }, editReply: async () => {} };
    await assert.rejects(showMediaAsAttachments.handle(interaction, { buttons: buttons() }), /GRID_NO_DISPLAYABLE_IMAGES/);
    assert.equal(edits, 0);
});

test('showMediaAsAttachments gives extensionless embed images a filename', async () => {
    await withoutTimers(async () => {
        const componentPath = require.resolve('../../src/components/showMediaAsAttachments');
        const fetchPath = require.resolve('node-fetch');
        const settingsPath = require.resolve('../../src/settings');
        const originalComponent = require.cache[componentPath];
        const originalFetch = require.cache[fetchPath];
        const originalSettings = require.cache[settingsPath];

        require.cache[fetchPath] = {
            id: fetchPath,
            filename: fetchPath,
            loaded: true,
            exports: async () => ({
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null,
                },
            }),
        };
        require.cache[settingsPath] = {
            id: settingsPath,
            filename: settingsPath,
            loaded: true,
            exports: {
                checkComponentIncludesDisabledButtonAndIfFindDeleteIt: async components => components,
                detectProviderIdFromMessage: () => 'spotify',
            },
        };
        delete require.cache[componentPath];
        const component = require(componentPath);
        let editedMessage = null;
        const interaction = {
            guildId: 'guild-components',
            locale: 'en',
            message: {
                attachments: [],
                embeds: [baseEmbed({
                    url: 'https://open.spotify.com/track/1',
                    image: { url: extensionlessImageUrl },
                })],
                edit: async (payload) => {
                    editedMessage = payload;
                },
            },
            editReply: async () => {},
            deleteReply: async () => {},
        };

        try {
            await component.handle(interaction, { buttons: buttons() });
        } finally {
            delete require.cache[componentPath];
            if (originalComponent) require.cache[componentPath] = originalComponent;
            if (originalFetch) require.cache[fetchPath] = originalFetch;
            else delete require.cache[fetchPath];
            if (originalSettings) require.cache[settingsPath] = originalSettings;
            else delete require.cache[settingsPath];
        }

        assert.deepEqual(editedMessage.files, [{
            attachment: extensionlessImageUrl,
            name: 'embed-image-1.png',
        }]);
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

test('downloadYouTubeVideo returns a temporary public download link', async () => {
    const componentPath = require.resolve('../../src/components/downloadYouTubeVideo');
    const storePath = require.resolve('../../src/youtubeDownloadStore');
    const originalComponent = require.cache[componentPath];
    const originalStore = require.cache[storePath];
    const calls = [];

    require.cache[storePath] = {
        id: storePath,
        filename: storePath,
        loaded: true,
        exports: {
            isDownloadButtonEnabled: () => true,
            downloadYouTubeToCache: async (url) => {
                calls.push(url);
                return {
                    publicUrl: 'https://cbte.sprink.cloud/youtube-downloads/token/video.mp4',
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
                    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                }],
            },
            editReply: async (payload) => {
                replies.push(payload);
            },
        };

        await component.handle(interaction);

        assert.deepEqual(calls, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
        assert.equal(replies[0].content, 'Preparing the download. This can take a few minutes.');
        assert.ok(replies[1].content.includes('Download is ready.'));
        assert.ok(replies[1].content.includes('Size: 12.0 MiB'));
        assert.equal(
            replies[1].components[0].components[0].data.url,
            'https://cbte.sprink.cloud/youtube-downloads/token/video.mp4'
        );
    } finally {
        delete require.cache[componentPath];
        if (originalComponent) require.cache[componentPath] = originalComponent;
        if (originalStore) require.cache[storePath] = originalStore;
        else delete require.cache[storePath];
    }
});

test('downloadYouTubeVideo is temporarily disabled when the button flag is off', async () => {
    const componentPath = require.resolve('../../src/components/downloadYouTubeVideo');
    const storePath = require.resolve('../../src/youtubeDownloadStore');
    const originalComponent = require.cache[componentPath];
    const originalStore = require.cache[storePath];
    const calls = [];

    require.cache[storePath] = {
        id: storePath,
        filename: storePath,
        loaded: true,
        exports: {
            isDownloadButtonEnabled: () => false,
            downloadYouTubeToCache: async (url) => {
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
                    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                }],
            },
            editReply: async (payload) => {
                replies.push(payload);
            },
        };

        await component.handle(interaction);

        assert.deepEqual(calls, []);
        assert.equal(replies[0].content, 'YouTube downloads are temporarily unavailable.');
    } finally {
        delete require.cache[componentPath];
        if (originalComponent) require.cache[componentPath] = originalComponent;
        if (originalStore) require.cache[storePath] = originalStore;
        else delete require.cache[storePath];
    }
});

test('attachment conversion gives signed image URLs clean filenames', async () => {
    await withoutTimers(async () => {
        let edited;
        const signed = 'https://images.example/photo.jpg?stp=dst-jpg&token=fixture';
        const interaction = { guildId: 'guild-components', locale: 'en', message: {
            attachments: [], embeds: [baseEmbed({ image: { url: signed } })], edit: async value => { edited = value; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await showMediaAsAttachments.handle(interaction, { buttons: buttons() });
        assert.deepEqual(edited.files, [{ attachment: signed, name: 'embed-image-1.jpg' }]);
    });
});

test('attachment conversion removes empty query and fragment markers from names', async () => {
    for (const suffix of ['?', '#']) await withoutTimers(async () => {
        let edited;
        const signed = `https://images.example/photo.jpg${suffix}`;
        const interaction = { guildId: 'guild-components', locale: 'en', message: {
            attachments: [], embeds: [baseEmbed({ image: { url: signed } })], edit: async value => { edited = value; },
        }, editReply: async () => {}, deleteReply: async () => {} };
        await showMediaAsAttachments.handle(interaction, { buttons: buttons() });
        assert.deepEqual(edited.files, [{ attachment: signed, name: 'embed-image-1.jpg' }]);
    });
});
