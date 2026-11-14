'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const grid = require('../../src/components/twitterGrid');
const cards = require('../../src/twitterGridCards');
const id = 'a'.repeat(32), user = '111111111111111111', bot = '222222222222222222', guildId = '333333333333333333', channelId = '444444444444444444';
const messageId = '555555555555555555', markerId = '666666666666666666', nextId = '777777777777777777';
const statusId = '1234567890123456789', marker = `tg-${id}.jpg`, image = n => `https://pbs.twimg.com/media/P${n}?format=jpg`;

function fixture() {
    const first = { id: messageId, channelId, author: { id: bot }, content: '', components: [],
        embeds: [{ url: `https://x.com/example/status/${statusId}`, image: { url: `https://cdn.discordapp.com/attachments/${channelId}/${markerId}/${marker}` } }],
        attachments: new Map([[markerId, { id: markerId, name: marker, contentType: 'image/jpeg' }]]) };
    const settings = { enabled: true, defaultLanguage: 'ja', button_disabled: { user: [], role: [], channel: [] }, twitter_grid_replace_permission: 'restricted' };
    const payload = { id, lockId: id, kind: 'twitter-image-grid-v1', replacePhase: 'done', imageUrls: Array.from({ length: 13 }, (_, i) => image(i)),
        totalParts: 2, completedParts: 2, messageIds: [messageId, nextId], partSizes: [10, 3],
        partSignatures: ['0'.repeat(64), '1'.repeat(64)], firstStaticSignature: cards.fingerprint(first, true), requesterId: user,
        settingsHash: cards.safetyHash(settings), nsfw: false, nsfwContextVersion: 1 };
    const channel = { id: channelId, messages: { fetch: async query => {
        if (query.limit) return new Map([['888888888888888888', { id: '888888888888888888', channelId }]]);
        if (query.message === messageId) return first;
        throw { code: 10008 };
    } } };
    const calls = [], interaction = { customId: `tg:${id}:0:open`, guildId, channelId, locale: 'ja', user: { id: user },
        client: { user: { id: bot } }, memberPermissions: { has: () => true }, message: first, channel,
        deferReply: async () => {}, deferUpdate: async () => {}, editReply: async value => calls.push(value), reply: async value => calls.push(value) };
    const deps = { storage: { get: async () => ({ gallery_id: id, provider_id: 'twitter', message_id: messageId, payload }) },
        getSettings: async () => settings, isAllowed: async () => true,
        freshAccess: async () => ({ channel, has: () => true, permissions: { has: () => true }, member: {} }),
        createRestoreAdapters: () => ({ inPlaceAvailable: async () => ({ status: 'ok', separateOnly: false }) }) };
    return { first, payload, interaction, calls, deps };
}

test('a verified public composite offers an owner-only restore menu with the three older-message options', async () => {
    const f = fixture(); await grid.handle(f.interaction, f.deps);
    const open = f.calls.at(-1), button = open.components[4].components.find(item => item.label === '元の画像に戻す');
    assert.ok(button); assert.ok(button.custom_id.includes(`:${user}:restore:`));
    f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    assert.deepEqual(f.calls.at(-1).components[0].components.map(item => item.label), ['最初の10枚を戻す', '10枚を戻し、残りを新しく投稿', 'すべて新しく展開']);
});

test('a limited shared message states its capacity and retains every choice', async () => {
    const f = fixture(); f.deps.createRestoreAdapters = () => ({ inPlaceAvailable: async () => ({ status: 'ok', separateOnly: false, rootCapacity: 1 }) });
    await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '元の画像に戻す');
    f.interaction.customId = button.custom_id; f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    assert.match(f.calls.at(-1).content, /最大1枚/);
    assert.deepEqual(f.calls.at(-1).components[0].components.map(item => item.label), ['最初の10枚を戻す', '10枚を戻し、残りを新しく投稿', 'すべて新しく展開']);
});

test('a private viewer without public-replacement rights cannot obtain restore controls', async () => {
    const f = fixture(); f.payload.requesterId = '999999999999999999'; f.deps.freshAccess = async () => ({ channel: f.interaction.channel,
        permissions: { has: () => false }, member: {}, guild: { ownerId: '888888888888888888' } });
    await grid.handle(f.interaction, f.deps);
    assert.equal(f.calls.at(-1).components[4].components.some(item => item.label === '元の画像に戻す'), false);
});

test('the selected restore choice reaches the guarded executor and reports success', async () => {
    const f = fixture(); await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '元の画像に戻す');
    f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    f.interaction.customId = f.calls.at(-1).components[0].components[0].custom_id;
    const operations = [];
    f.deps.createRestoreAdapters = () => ({
        withLock: async (_request, work) => work({ first: f.first, payload: f.payload }), authorize: async () => true,
        latestMessageId: async () => '888888888888888888', adjacency: async () => 'adjacent', fileLimit: async () => 25 * 1024 * 1024, verifyLiveSource: async () => f.payload.imageUrls,
        measureImages: async urls => urls.map(source => ({ source, size: 4, format: 'jpeg', sha256: require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex') })),
        prepareImages: async urls => urls.map(source => ({ source, format: 'jpeg', data: Buffer.from('ffd8ff00', 'hex') })),
        preflight: async () => true, begin: async () => ({ id: 'b'.repeat(32) }), cancel: async () => {},
        plan: async () => {}, reject: async () => {}, confirm: async () => {}, finish: async () => {}, markUnknown: async () => {},
        editOnce: async (_request, _snapshot, files) => { operations.push(files.length); return { id: messageId }; },
        sendOnce: async () => { throw Error('this choice must not send'); }, verifyResult: async () => true,
    });
    await grid.handle(f.interaction, f.deps);
    assert.deepEqual(operations, [10]); assert.equal(f.calls.at(-1).content, '画像を戻しました。');
});

test('first-ten restoration asks before posting extra physical parts and accepts only its owner', async () => {
    const f = fixture(); await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '元の画像に戻す');
    f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    f.interaction.customId = f.calls.at(-1).components[0].components[0].custom_id;
    const data = Buffer.alloc(9 * 1024 * 1024); Buffer.from('ffd8ff', 'hex').copy(data);
    let hash = require('node:crypto').createHash('sha256').update(data).digest('hex'); const actions = [];
    const makeAdapters = () => ({ withLock: async (_request, work) => work({ first: f.first, payload: f.payload }), authorize: async () => true,
        latestMessageId: async () => '888888888888888888', adjacency: async () => 'adjacent', fileLimit: async () => 25 * 1024 * 1024, verifyLiveSource: async () => f.payload.imageUrls,
        measureImages: async urls => urls.map(source => ({ source, size: data.length, format: 'jpeg', sha256: hash })),
        prepareImages: async urls => urls.map(source => ({ source, format: 'jpeg', data })),
        preflight: async () => true, begin: async request => { assert.equal(request.splitConfirmed, true); return { id: 'b'.repeat(32) }; },
        cancel: async () => {}, plan: async () => {}, reject: async () => {}, confirm: async () => {}, finish: async () => {}, markUnknown: async () => {},
        editOnce: async (_request, _snapshot, files) => { actions.push(['edit', files.length]); return { id: messageId }; },
        sendOnce: async (_request, _snapshot, files) => { actions.push(['send', files.length]); return { id: nextId }; }, verifyResult: async () => true });
    f.deps.createRestoreAdapters = makeAdapters;
    await grid.handle(f.interaction, f.deps);
    const confirmation = f.calls.at(-1);
    assert.match(confirmation.content, /8枚・2枚の2通/); assert.deepEqual(actions, []);
    const customId = confirmation.components[0].components[0].custom_id;
    f.interaction.customId = customId; f.interaction.user.id = '999999999999999999';
    await grid.handle(f.interaction, f.deps); assert.deepEqual(actions, []);
    f.interaction.user.id = user;
    data[3] = 1; hash = require('node:crypto').createHash('sha256').update(data).digest('hex');
    await grid.handle(f.interaction, f.deps);
    assert.match(f.calls.at(-1).content, /8枚・2枚の2通/); assert.deepEqual(actions, []);
    f.interaction.customId = f.calls.at(-1).components[0].components[0].custom_id;
    await grid.handle(f.interaction, f.deps);
    assert.deepEqual(actions, [['edit', 8], ['send', 2]]); assert.equal(f.calls.at(-1).content, '画像を戻しました。');
});

test('a restored prior operation is reported rather than presented as a new failure', async () => {
    const f = fixture(); await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '元の画像に戻す');
    f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    f.deps.createRestoreAdapters = () => ({ inPlaceAvailable: async () => ({ status: 'recovered' }) });
    await grid.handle(f.interaction, f.deps);
    assert.equal(f.calls.at(-1).content, '前回の復旧結果を確認しました。');
});

test('opening a changed composite reconciles a verified previous restoration before showing controls', async () => {
    const f = fixture();
    f.first.embeds[0].image = undefined;
    f.first.attachments = new Map();
    let recovered = 0;
    f.deps.createRestoreAdapters = () => ({ recoverOnly: async () => {
        recovered++;
        f.payload.imageUrls = f.payload.imageUrls.slice(0, 10); f.payload.totalParts = 1; f.payload.completedParts = 1;
        f.payload.messageIds = [messageId]; f.payload.partSizes = [10]; f.payload.partSignatures = [cards.fingerprint(f.first)];
        f.payload.replacePhase = undefined;
        return { status: 'recovered' };
    } });
    await grid.handle(f.interaction, f.deps);
    assert.equal(recovered, 1);
    assert.equal(f.calls.at(-1).components.length, 5);
    assert.equal(f.calls.at(-1).components[4].components.some(item => item.label === '元の画像に戻す'), false);
});

test('a verified partial restore offers an explicit confirmation before posting the remaining images', async () => {
    const f = fixture(), original = [...f.payload.imageUrls];
    f.first.embeds[0].image = undefined; f.first.attachments = new Map();
    f.payload.imageUrls = original.slice(0, 10); f.payload.totalParts = 1; f.payload.completedParts = 1;
    f.payload.messageIds = [messageId]; f.payload.partSizes = [10]; f.payload.partSignatures = [cards.fingerprint(f.first)];
    f.payload.partContainsNonImage = [false];
    f.payload.partRefs = [f.payload.imageUrls.map(url => ({ type: 'url', url }))]; f.payload.replacePhase = undefined;
    f.payload.sourceStatusId = statusId; f.payload.restoreArchive = { sourceStatusId: statusId, imageUrls: original };
    f.payload.restoreContinuation = { sourceStatusId: statusId, nextIndex: 10 };
    await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '残りの画像を投稿');
    assert.ok(button); f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    assert.equal(f.calls.at(-1).components[0].components[0].label, '残りを投稿');
    f.interaction.customId = f.calls.at(-1).components[0].components[0].custom_id;
    const sends = [];
    f.deps.createRestoreAdapters = () => ({
        withLock: async (_request, work) => work({ first: f.first, payload: f.payload }), authorize: async () => true,
        latestMessageId: async () => '888888888888888888', adjacency: async () => 'adjacent', fileLimit: async () => 25 * 1024 * 1024, verifyLiveSource: async () => original,
        measureImages: async urls => urls.map(source => ({ source, size: 4, format: 'jpeg', sha256: require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex') })),
        prepareImages: async urls => urls.map(source => ({ source, format: 'jpeg', data: Buffer.from('ffd8ff00', 'hex') })),
        preflight: async () => true, begin: async () => ({ id: 'b'.repeat(32) }), cancel: async () => {},
        plan: async () => {}, reject: async () => {}, confirm: async () => {}, finish: async () => {}, markUnknown: async () => {},
        editOnce: async () => { throw Error('must not edit'); },
        sendOnce: async (_request, _snapshot, files) => { sends.push(files.length); return { id: nextId }; }, verifyResult: async () => true,
    });
    await grid.handle(f.interaction, f.deps);
    assert.deepEqual(sends, [3]); assert.equal(f.calls.at(-1).content, '画像を戻しました。');
});

test('a verified one-image partial restore can open and confirm the remaining images', async () => {
    const f = fixture(), firstUrl = image(0);
    f.first.embeds[0].image = { url: firstUrl };
    f.first.attachments = new Map();
    Object.assign(f.payload, {
        replacePhase: undefined, sourceStatusId: statusId, imageUrls: [firstUrl],
        restoreArchive: { sourceStatusId: statusId, imageUrls: Array.from({ length: 13 }, (_, i) => image(i)) },
        restoreContinuation: { sourceStatusId: statusId, nextIndex: 1, targetCount: 13 },
        partsState: 'complete', totalParts: 1, completedParts: 1, messageIds: [messageId],
        partSizes: [1], partRefs: [[{ type: 'url', url: firstUrl }]], partContainsNonImage: [false],
        partSignatures: [cards.fingerprint(f.first)],
    });
    await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '残りの画像を投稿');
    assert.ok(button);
    f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    assert.equal(f.calls.at(-1).components[0].components[0].label, '残りを投稿');

    // A corrupted continuation cannot use the one-image exception.
    f.interaction.customId = `tg:${id}:0:open`;
    f.interaction.message = f.first;
    f.payload.restoreContinuation.nextIndex = 2;
    await grid.handle(f.interaction, f.deps);
    assert.match(f.calls.at(-1).content, /画像を表示できません/);
});


test('a definitive 413 asks the owner before the first ten become two posts', async () => {
    const f = fixture(); await grid.handle(f.interaction, f.deps);
    const button = f.calls.at(-1).components[4].components.find(item => item.label === '元の画像に戻す');
    f.interaction.customId = button.custom_id;
    f.interaction.message = { author: { id: bot }, flags: { has: value => value === 64 } };
    await grid.handle(f.interaction, f.deps);
    f.interaction.customId = f.calls.at(-1).components[0].components[0].custom_id;
    const data = Buffer.from('ffd8ff00', 'hex'), hash = require('node:crypto').createHash('sha256').update(data).digest('hex');
    const actions = []; let attempts = 0;
    f.deps.createRestoreAdapters = () => ({ withLock: async (_request, work) => work({ first: f.first, payload: f.payload }), authorize: async () => true,
        latestMessageId: async () => '888888888888888888', adjacency: async () => 'adjacent', fileLimit: async () => 25 * 1024 * 1024, verifyLiveSource: async () => f.payload.imageUrls,
        measureImages: async urls => urls.map(source => ({ source, size: data.length, format: 'jpeg', sha256: hash })),
        prepareImages: async urls => urls.map(source => ({ source, format: 'jpeg', data })), preflight: async () => true,
        begin: async () => ({ id: 'b'.repeat(32) }), cancel: async () => {}, plan: async () => {}, reject: async () => {},
        markRejected413: async () => {}, confirm: async () => {}, finish: async () => {}, markUnknown: async () => {},
        editOnce: async (_request, _snapshot, files) => {
            actions.push(['edit', files.length]);
            if (++attempts === 1) throw new (require('discord.js').DiscordAPIError)({ message: 'too large' }, 0, 413, 'PATCH', '/fixture', {});
            return { id: messageId };
        },
        sendOnce: async (_request, _snapshot, files) => { actions.push(['send', files.length]); return { id: nextId }; }, verifyResult: async () => true });
    await grid.handle(f.interaction, f.deps);
    assert.match(f.calls.at(-1).content, /5枚・5枚の2通/);
    assert.deepEqual(actions, [['edit', 10]]);
    const confirm = f.calls.at(-1).components[0].components[0].custom_id;
    f.interaction.customId = confirm; f.interaction.user.id = '999999999999999999';
    await grid.handle(f.interaction, f.deps); assert.deepEqual(actions, [['edit', 10]]);
    f.interaction.user.id = user; await grid.handle(f.interaction, f.deps);
    assert.deepEqual(actions, [['edit', 10], ['edit', 5], ['send', 5]]);
    assert.equal(f.calls.at(-1).content, '画像を戻しました。');
});
