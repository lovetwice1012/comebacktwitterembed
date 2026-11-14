'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const restore = require('../../src/twitterGridRestore');
const restoreUI = require('../../src/twitterGridRestoreUI');

const id = 'a'.repeat(32), postId = '1234567890123456789', attachmentId = '333333333333333333';
const image = n => `https://pbs.twimg.com/media/P${n}?format=jpg&name=orig`;
function fixture(count = 13) {
    const marker = `tg-${id}.jpg`, urls = Array.from({ length: count }, (_, i) => image(i));
    return {
        payload: { id, replacePhase: 'done', imageUrls: urls },
        message: { channelId: '22', embeds: [{ url: `https://x.com/example/status/${postId}`, image: { url: `https://cdn.discordapp.com/attachments/22/${attachmentId}/${marker}?ex=abc` } }],
            attachments: new Map([[attachmentId, { id: attachmentId, name: marker, contentType: 'image/jpeg' }]]) },
        tweet: { tweetID: postId, tweetURL: `https://x.com/example/status/${postId}`, author: { protected: false }, possibly_sensitive: false, mediaURLs: urls },
    };
}

test('a combined marker and its own verified embed identify an existing X post', () => {
    const f = fixture();
    assert.deepEqual(restore.statusFromCombined(f.payload, f.message), { id: postId, url: `https://x.com/i/web/status/${postId}` });
    assert.deepEqual(restore.verifySource(restore.statusFromCombined(f.payload, f.message), f.payload, f.tweet), f.payload.imageUrls);
});

test('a Discord-hidden embedded marker identifies the source only for its exact channel and gallery', () => {
    const f = fixture();
    f.message.attachments.clear();
    assert.deepEqual(restore.statusFromCombined(f.payload, f.message), { id: postId, url: `https://x.com/i/web/status/${postId}` });
    const original = f.message.embeds[0].image.url;
    for (const url of [
        original.replace('cdn.discordapp.com', 'evil.example'),
        original.replace('/attachments/22/', '/attachments/23/'),
        original.replace(`tg-${id}.jpg`, `tg-${'b'.repeat(32)}.jpg`),
        `${original}&unexpected=1`,
        `attachment://tg-${id}.jpg`,
    ]) {
        f.message.embeds[0].image.url = url;
        assert.equal(restore.statusFromCombined(f.payload, f.message), null);
    }
    f.message.embeds[0].image.url = original;
    f.message.embeds.push({ ...f.message.embeds[0] });
    assert.equal(restore.statusFromCombined(f.payload, f.message), null, 'ambiguous duplicated markers are rejected');
});

test('a forged, ambiguous, missing, or unrelated marker never identifies a source', () => {
    const f = fixture();
    f.message.embeds[0].image.url = `https://cdn.discordapp.com/attachments/22/999/tg-${id}.jpg`;
    assert.equal(restore.statusFromCombined(f.payload, f.message), null);
    f.message.embeds[0].image.url = `https://elsewhere.example/attachments/22/${attachmentId}/tg-${id}.jpg`;
    assert.equal(restore.statusFromCombined(f.payload, f.message), null);
    f.message.embeds[0].image.url = `https://cdn.discordapp.com/attachments/23/${attachmentId}/tg-${id}.jpg`;
    assert.equal(restore.statusFromCombined(f.payload, f.message), null);
    f.message.embeds[0].image.url = `attachment://tg-${id}.jpg`;
    f.message.embeds.push({ ...f.message.embeds[0] });
    assert.equal(restore.statusFromCombined(f.payload, f.message), null);
    f.message.embeds.pop();
    f.message.embeds[0].url = 'https://example.com/another/status/123';
    assert.equal(restore.statusFromCombined(f.payload, f.message), null);
});

test('deleted, private, sensitive, unverifiable, or mismatched posts cannot be restored', () => {
    const f = fixture(), status = restore.statusFromCombined(f.payload, f.message);
    for (const change of [
        { tweetID: '777' }, { tweetURL: 'https://x.com/other/status/777' }, { possibly_sensitive: true },
        { possibly_sensitive: undefined }, { author: { protected: true } }, { author: {} }, { community: { is_nsfw: true } },
        { media_extended: [{ sensitive: true }] },
        { mediaURLs: f.tweet.mediaURLs.slice(1) }, { mediaURLs: [...f.tweet.mediaURLs].reverse() }, { mediaURLs: null },
    ]) assert.equal(restore.verifySource(status, f.payload, { ...f.tweet, ...change }), null, JSON.stringify(change));
    assert.equal(restore.verifySource(status, f.payload, null), null);
});

test('approved image subset and variation of CDN format keep the stored image order', () => {
    const f = fixture(3), status = restore.statusFromCombined(f.payload, f.message);
    f.tweet.mediaURLs = [`https://pbs.twimg.com/media/P0.jpg`, 'https://pbs.twimg.com/media/hidden.jpg', image(1), image(2)];
    assert.deepEqual(restore.verifySource(status, f.payload, f.tweet), f.payload.imageUrls);
    f.payload.imageUrls[0] = 'https://127.0.0.1/media/P0.jpg';
    assert.equal(restore.verifySource(status, f.payload, f.tweet), null);
});

test('live verification uses only registered sources and stops on an explicit denial', async () => {
    const f = fixture(), status = restore.statusFromCombined(f.payload, f.message);
    const sources = require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources;
    const attempts = [];
    const deps = { resolvePlan: async () => ({ sources: [{ id: 'evil', origin: 'http://127.0.0.1' }, ...sources] }), fetch: async (url, options) => {
        attempts.push([url, options]);
        return { ok: true, text: async () => JSON.stringify(f.tweet) };
    } };
    assert.deepEqual(await restore.fetchVerifiedSource(status, f.payload, deps), f.payload.imageUrls);
    assert.equal(attempts.length, 1);
    assert.ok(attempts[0][0].startsWith(sources[0].origin));
    assert.equal(attempts[0][1].redirect, 'manual');
    attempts.length = 0;
    deps.fetch = async url => { attempts.push([url]); return { ok: true, text: async () => 'This post is private' }; };
    await assert.rejects(restore.fetchVerifiedSource(status, f.payload, deps), /GRID_RESTORE_SOURCE/);
    assert.equal(attempts.length, 1, 'a private result must not be bypassed by another source');
    attempts.length = 0;
    deps.fetch = async url => { attempts.push([url]); return { ok: false, status: 403 }; };
    await assert.rejects(restore.fetchVerifiedSource(status, f.payload, deps), /GRID_RESTORE_SOURCE/);
    assert.equal(attempts.length, 1, 'an access denial must not be bypassed');
    for (const change of [{ possibly_sensitive: true }, { author: { protected: true } }, { tweetID: '111' }]) {
        attempts.length = 0;
        deps.fetch = async url => { attempts.push([url]); return { ok: true, text: async () => JSON.stringify({ ...f.tweet, ...change }) }; };
        await assert.rejects(restore.fetchVerifiedSource(status, f.payload, deps), /GRID_RESTORE_SOURCE/);
        assert.equal(attempts.length, 1, 'a known restriction or wrong post must not be bypassed');
    }
});

test('existing parser accepts an Fx fallback after Vx omits protected status', async () => {
    const f = fixture(), status = restore.statusFromCombined(f.payload, f.message);
    const sources = require('../../src/adminSupport/providerSources').REGISTRY.twitter.sources, calls = [];
    const photos = f.payload.imageUrls.map((url, index) => ({ type: 'photo', id: String(index + 1), url }));
    const vx = { ...f.tweet }; delete vx.author;
    const fx = { code: 200, tweet: { id: postId, url: `https://x.com/example/status/${postId}`, text: 'test',
        author: { name: 'Example', screen_name: 'example', protected: false }, possibly_sensitive: false, media: { all: photos, photos } } };
    const result = await restore.fetchVerifiedSource(status, f.payload, { resolvePlan: async () => ({ sources }), fetch: async url => {
        calls.push(url); return { ok: true, text: async () => JSON.stringify(calls.length === 1 ? vx : fx) };
    } });
    assert.equal(calls.length, 2); assert.deepEqual(result, f.payload.imageUrls);
});

test('the most recent message restores all; older messages offer all three explicit destinations', () => {
    const urls = fixture(20).payload.imageUrls;
    assert.deepEqual(restore.restoreChoices(20, true, 'ja').map(x => x.value), ['here']);
    assert.deepEqual(restore.restoreChoices(20, false, 'ja').map(x => x.value), ['first', 'rest', 'new']);
    assert.deepEqual(restore.planRestore(urls, 'here', true), { edit: urls.slice(0, 10), sends: [urls.slice(10)] });
    assert.deepEqual(restore.planRestore(urls, 'first', false), { edit: urls.slice(0, 10), sends: [] });
    assert.deepEqual(restore.planRestore(urls, 'rest', false), { edit: urls.slice(0, 10), sends: [urls.slice(10)] });
    assert.deepEqual(restore.planRestore(urls, 'new', false), { edit: [], sends: [urls.slice(0, 10), urls.slice(10)] });
    assert.throws(() => restore.planRestore(urls, 'here', false), /GRID_RESTORE_MODE/);
});

test('restore menu exposes only the applicable options in a private-owner custom id', () => {
    const menu = restore.restoreView(id, '111111111111111111', '2.512.512.0.ffffff.i.j.85.r', 13, false, 'ja');
    assert.equal(menu.components.length, 1);
    assert.deepEqual(menu.components[0].components.map(button => button.label), ['最初の10枚を戻す', '10枚を戻し、残りを新しく投稿', 'すべて新しく展開']);
    assert.ok(menu.components[0].components.every(button => button.custom_id.length <= 100 && button.custom_id.includes(':111111111111111111:r')));
    assert.equal(restore.restoreView(id, '111111111111111111', '2.512.512.0.ffffff.i.j.85.r', 13, true, 'ja').components[0].components.length, 1);
    const longest = restore.restoreView(id, '1'.repeat(22), '20.2048.2048.64.ffffff.i.j.95.r', 20, false, 'ja');
    assert.ok(longest.components[0].components.every(button => button.custom_id.length <= 100));
    const overflow = restore.restoreView(id, '1'.repeat(22), '20.2048.2048.64.ffffff.i.j.95.r', 2, true, 'ja', true);
    assert.deepEqual(overflow.components[0].components.map(button => button.label), ['すべて新しく展開']);
    assert.deepEqual(restore.planRestore([image(0), image(1)], 'new', true), { edit: [], sends: [[image(0), image(1)]] });
    assert.throws(() => restore.restoreView(id, '0', 'state', 13, true, 'ja'), /GRID_RESTORE_MODE/);
});

test('older shared posts offer explicit destinations when ten or fewer photos do not fit', () => {
    for (const count of [2, 9, 10]) {
        const capacity = count - 1;
        const choices = restore.restoreChoices(count, false, 'ja', capacity);
        assert.deepEqual(choices.map(choice => choice.value), ['rest', 'new']);
        const menu = restore.restoreView(id, '111111111111111111', '2.512.512.0.ffffff.i.j.85.r', count, false, 'ja', false, capacity);
        assert.deepEqual(menu.components[0].components.map(button => button.label), ['元に戻し、残りを新しく投稿', 'すべて新しく展開']);
        const urls = fixture(count).payload.imageUrls;
        assert.deepEqual(restore.planRestore(urls, 'rest', false), { edit: urls, sends: [] });
        assert.deepEqual(restore.planRestore(urls, 'new', false), { edit: [], sends: [urls] });
    }
    assert.deepEqual(restore.restoreChoices(10, false, 'ja', 10).map(choice => choice.value), ['here', 'new']);
    assert.deepEqual(restore.restoreChoices(9, false, 'ja', 10).map(choice => choice.value), ['here']);
    assert.deepEqual(restore.restoreChoices(10, true, 'ja', 9).map(choice => choice.value), ['here']);
});

test('restore choices belong to the user who opened the private menu', async () => {
    const owner = '111111111111111111', f = fixture(13), firstId = '555555555555555555';
    f.payload.messageIds = [firstId]; f.message.id = firstId;
    const interaction = { user: { id: owner }, locale: 'ja' }, snapshot = { payload: f.payload, first: f.message };
    const menu = await restoreUI.restoreMenu(interaction, snapshot, '2.512.512.0.ffffff.i.j.85.r',
        { authorize: async () => true, latestMessageId: async () => '777777777777777777' });
    const button = menu.components[0].components[0];
    assert.equal(restoreUI.parseSelection(button.custom_id, owner, true).mode, 'first');
    assert.equal(restoreUI.parseSelection(button.custom_id, '222222222222222222', true), null);
    assert.equal(restoreUI.parseSelection(button.custom_id, owner, false), null);
    assert.deepEqual(await restoreUI.restoreSelection({ customId: button.custom_id, user: { id: '222222222222222222' }, message: { flags: { has: () => true } } }, {}), { status: 'denied' });
    await assert.rejects(restoreUI.restoreMenu(interaction, snapshot, '2.512.512.0.ffffff.i.j.85.r',
        { authorize: async () => false, latestMessageId: async () => firstId }), /GRID_RESTORE_DENIED/);
});

test('splitting only the first ten requires an owner-bound, expiring, single-use confirmation', () => {
    const owner = '111111111111111111', state = '2.512.512.0.ffffff.i.j.85.r', digest = 'f'.repeat(64);
    const panel = restoreUI.offerSplitConfirmation({ id, owner, packedState: state, sizes: [8, 2], planDigest: digest }, 'ja', 1000);
    assert.match(panel.content, /8枚・2枚の2通/);
    const customId = panel.components[0].components[0].custom_id, token = customId.split(':').at(-1);
    assert.ok(customId.length <= 100);
    assert.equal(restoreUI.consumeSplitConfirmation(token, id, '222222222222222222', 1001), null);
    const accepted = restoreUI.consumeSplitConfirmation(token, id, owner, 1001);
    assert.equal(accepted.planDigest, digest); assert.deepEqual(accepted.sizes, [8, 2]);
    assert.equal(restoreUI.consumeSplitConfirmation(token, id, owner, 1001), null);
    const expired = restoreUI.offerSplitConfirmation({ id, owner, packedState: state, sizes: [8, 2], planDigest: digest }, 'ja', 1000);
    assert.equal(restoreUI.consumeSplitConfirmation(expired.components[0].components[0].custom_id.split(':').at(-1), id, owner, 121000), null);
    assert.throws(() => restoreUI.offerSplitConfirmation({ id, owner, packedState: state, sizes: [8, 3], planDigest: digest }, 'ja'), /GRID_RESTORE_CONFIRM/);
    const resumed = restoreUI.offerSplitConfirmation({ id, owner, packedState: state, sizes: [1, 1], planDigest: digest, mode: 'resume' }, 'ja', 1000);
    assert.match(resumed.content, /残りの2枚/);
    const record = restoreUI.consumeSplitConfirmation(resumed.components[0].components[0].custom_id.split(':').at(-1), id, owner, 1001);
    assert.equal(record.mode, 'resume'); assert.deepEqual(record.sizes, [1, 1]);
});

test('channel tail is fetched live, belongs to the channel, and cannot be guessed on failure', async () => {
    const channelId = '333333333333333333', messageId = '444444444444444444', calls = [];
    const channel = { id: channelId, messages: { fetch: async options => { calls.push(options); return new Map([[messageId, { id: messageId, channelId }]]); } } };
    assert.equal(await restore.latestMessageId(channel), messageId);
    assert.deepEqual(calls, [{ limit: 1, cache: false }]);
    channel.messages.fetch = async () => new Map([[messageId, { id: messageId, channelId: '999999999999999999' }]]);
    await assert.rejects(restore.latestMessageId(channel), /GRID_RESTORE_UNAVAILABLE/);
    channel.messages.fetch = async () => new Map();
    await assert.rejects(restore.latestMessageId(channel), /GRID_RESTORE_UNAVAILABLE/);
});

test('channel history detects intervening posts or refuses an incomplete view', async () => {
    const channelId = '333333333333333333', a = '555555555555555555', b = '777777777777777777', middle = '666666666666666666';
    let ids = [a, b];
    const channel = { id: channelId, messages: { fetch: async () => new Map(ids.map(id => [id, { id, channelId }])) } };
    assert.equal(await restore.adjacency(channel, a, b), 'adjacent');
    ids = [a, middle, b]; assert.equal(await restore.adjacency(channel, a, b), 'separated');
    ids = [middle, b]; assert.equal(await restore.adjacency(channel, a, b), 'unavailable');
    channel.messages.fetch = async () => { throw Error('denied'); };
    assert.equal(await restore.adjacency(channel, a, b), 'unavailable');
});

test('restoration downloads only validated X photos within a bounded sequential batch', async () => {
    const calls = [], fetchTwitterMedia = async (url, options) => { calls.push([url, options]); return { data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' }; };
    const urls = [image(0), image(1)];
    const results = await restore.prepareRestoredImages(urls, { maxTotalBytes: 8, maxPerFileBytes: 8 }, { fetchTwitterMedia });
    assert.deepEqual(results.map(file => file.source), urls);
    assert.deepEqual(calls.map(([, options]) => options.maxBytes), [8, 4]);
    calls.length = 0;
    await assert.rejects(restore.prepareRestoredImages([image(0), 'https://127.0.0.1/media/x'], {}, { fetchTwitterMedia }), /GRID_RESTORE_FORMAT/);
    assert.equal(calls.length, 0);
    calls.length = 0;
    await assert.rejects(restore.prepareRestoredImages(urls, { maxTotalBytes: 3, maxPerFileBytes: 8 }, { fetchTwitterMedia }), /GRID_RESTORE_FORMAT/);
    assert.equal(calls.length, 1);
});

test('a Discord receipt must contain precisely the restored and retained attachments on the correct Bot message', () => {
    const channelId = '333333333333333333', botId = '222222222222222222', op = 'b'.repeat(32);
    const files = [{ name: `restore-${op}-0.jpg` }, { name: `restore-${op}-1.png` }];
    const make = (id, name, type) => ({ id, name, contentType: type, url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${name}` });
    const a = make('444444444444444444', files[0].name, 'image/jpeg'), b = make('555555555555555555', files[1].name, 'image/png');
    const retained = make('666666666666666666', 'retained.jpg', 'image/jpeg');
    const message = { id: '777777777777777777', channelId, author: { id: botId }, attachments: new Map([[a.id, a], [b.id, b], [retained.id, retained]]) };
    assert.equal(restore.verifyRestoredAttachments(message, { channelId, botId }, files, [retained.id]), true);
    for (const changed of [
        { ...message, author: { id: '888888888888888888' } }, { ...message, channelId: '999999999999999999' },
        { ...message, attachments: new Map([[a.id, a], [retained.id, retained]]) },
        { ...message, attachments: new Map([[a.id, a], [b.id, { ...b, url: b.url.replace(b.id, '999999999999999999') }], [retained.id, retained]]) },
        { ...message, attachments: new Map([[a.id, a], [b.id, b], [retained.id, retained], ['extra', make('999999999999999999', 'extra.jpg', 'image/jpeg')]]) },
    ]) assert.equal(restore.verifyRestoredAttachments(changed, { channelId, botId }, files, [retained.id]), false);
});

test('hidden restore uploads require the persisted proof and matching CDN bytes', async () => {
    const channelId = '333333333333333333', botId = '222222222222222222', op = 'b'.repeat(32);
    const data = Buffer.from('ffd8ff00', 'hex'), name = `restore-${op}-0.jpg`, fileId = '444444444444444444';
    const hash = require('node:crypto').createHash('sha256').update(data).digest('hex');
    const files = [{ name, data }], url = `https://cdn.discordapp.com/attachments/${channelId}/${fileId}/${name}?ex=abc&is=123&hm=fff`;
    const message = { id: '777777777777777777', channelId, author: { id: botId }, attachments: [], embeds: [{ image: { url } }] };
    const operation = { record: { startedAtMs: Date.now(), steps: [{ state: 'planned', proofs: [{ name, sha256: hash }] }] } };
    const { verifyHiddenUploadBytes } = require('../../src/twitterGridRestoreAdapters')._internal;
    let checked = 0;
    const options = { hashAttachment: async (attachment, limits) => { checked++; assert.equal(attachment.id, fileId); assert.ok(limits.deadlineAtMs); return hash; } };
    assert.equal(restore.verifyRestoredAttachments(message, { channelId, botId }, files), true);
    assert.equal(await verifyHiddenUploadBytes(message, files, operation, options), true); assert.equal(checked, 1);
    assert.equal(await verifyHiddenUploadBytes(message, files, operation, { hashAttachment: async () => '0'.repeat(64) }), false);
    operation.record.steps[0].proofs[0].sha256 = '0'.repeat(64);
    assert.equal(await verifyHiddenUploadBytes(message, files, operation, options), false);
    for (const bad of [url.replace(channelId, '999999999999999999'), url.replace('cdn.discordapp.com', 'evil.example'), `${url}&width=50`]) {
        const forged = { ...message, embeds: [{ image: { url: bad } }] };
        assert.equal(restore.verifyRestoredAttachments(forged, { channelId, botId }, files), false);
    }
});

test('confirmed partial restoration records only visible images while retaining the complete verified source', () => {
    const f = fixture(13), operationId = 'b'.repeat(32), firstId = '555555555555555555';
    f.payload.messageIds = [firstId, '666666666666666666'];
    const files = new Map(Array.from({ length: 10 }, (_, i) => [String(1000 + i), { id: String(1000 + i), name: `restore-${operationId}-${i}.jpg`, contentType: 'image/jpeg' }]));
    const message = { id: firstId, content: 'post', embeds: [{ title: 'post' }], components: [], attachments: files };
    const result = restore.restoredManifest(f.payload, operationId, 'first', [message], f.payload.imageUrls, postId);
    assert.deepEqual(result.imageUrls, f.payload.imageUrls.slice(0, 10));
    assert.deepEqual(result.restoreArchive.imageUrls, f.payload.imageUrls);
    assert.deepEqual(result.partSizes, [10]); assert.equal(result.totalParts, 1); assert.equal(result.replacePhase, undefined);
    assert.equal(result.partRefs[0].length, 10);
    assert.throws(() => restore.restoredManifest(f.payload, operationId, 'first', [message], [image(99), ...f.payload.imageUrls.slice(1)], postId), /GRID_RESTORE_RECORD/);
    assert.throws(() => restore.restoredManifest(f.payload, operationId, 'first', [{ ...message, attachments: new Map() }], f.payload.imageUrls, postId), /GRID_RESTORE_RECORD/);
    assert.throws(() => restore.restoredManifest({ ...f.payload, sourceStatusId: '9' }, operationId, 'first', [message], f.payload.imageUrls, postId), /GRID_RESTORE_RECORD/);
});

test('a recombined ten-image generation restores those ten while keeping the earlier thirteen-image archive', () => {
    const f = fixture(13), operationId = 'b'.repeat(32), firstId = '555555555555555555', original = [...f.payload.imageUrls];
    f.payload.messageIds = [firstId]; f.payload.imageUrls = original.slice(0, 10); f.payload.sourceStatusId = postId;
    f.payload.restoreArchive = { sourceStatusId: postId, imageUrls: original };
    const files = new Map(Array.from({ length: 10 }, (_, i) => [String(1000 + i), { id: String(1000 + i), name: `restore-${operationId}-${i}.jpg`, contentType: 'image/jpeg' }]));
    const message = { id: firstId, content: '', embeds: [], components: [], attachments: files };
    assert.equal(restore.validArchive(f.payload, postId), true);
    const result = restore.restoredManifest(f.payload, operationId, 'here', [message], f.payload.imageUrls, postId);
    assert.deepEqual(result.imageUrls, original.slice(0, 10)); assert.deepEqual(result.restoreArchive.imageUrls, original);
    assert.equal(restore.validArchive({ ...f.payload, restoreArchive: { sourceStatusId: postId, imageUrls: [...original].reverse() } }, postId), false);
});

test('confirmed multi-message restoration reconstructs ordered refs and fingerprints for all images', () => {
    const f = fixture(13), op = 'b'.repeat(32), ids = ['555555555555555555', '666666666666666666'];
    f.payload.messageIds = ids;
    const make = (id, start, count) => ({ id, content: '', embeds: [], components: [], attachments: new Map(
        Array.from({ length: count }, (_, i) => [String(start + i + 1), { id: String(start + i + 1), name: `restore-${op}-${start + i}.jpg`, contentType: 'image/jpeg' }])) });
    const messages = [make(ids[0], 0, 10), make(ids[1], 10, 3)];
    const result = restore.restoredManifest(f.payload, op, 'rest', messages, f.payload.imageUrls, postId);
    assert.deepEqual(result.messageIds, ids); assert.deepEqual(result.partSizes, [10, 3]);
    assert.deepEqual(result.partRefs.flat().map(ref => ref.url), f.payload.imageUrls);
    assert.equal(result.partSignatures.length, 2);
    messages[1].attachments.delete('11');
    assert.throws(() => restore.restoredManifest(f.payload, op, 'rest', messages, f.payload.imageUrls, postId), /GRID_RESTORE_RECORD/);
});

test('1-10 images are restored in one message, and no message exceeds Discord’s ten attachment limit', () => {
    for (let n = 1; n <= 20; n++) {
        const urls = fixture(n).payload.imageUrls;
        for (const latest of [true, false]) for (const { value } of restore.restoreChoices(n, latest, 'ja')) {
            const plan = restore.planRestore(urls, value, latest);
            assert.ok(plan.edit.length <= 10);
            assert.ok(plan.sends.every(group => group.length > 0 && group.length <= 10));
            assert.deepEqual([...plan.edit, ...plan.sends.flat()], value === 'first' ? urls.slice(0, 10) : urls);
        }
    }
    assert.throws(() => restore.restoreChoices(21, true), /GRID_RESTORE_COUNT/);
});

test('large original images are split in order into bounded physical messages', () => {
    const urls = fixture(20).payload.imageUrls, size = 9 * 1024 * 1024;
    const measurements = urls.map(source => ({ source, size, format: 'jpeg', sha256: 'a'.repeat(64) }));
    const plan = restore.splitRestorePlan(urls, 'here', true, measurements);
    assert.deepEqual([plan.edit.length, ...plan.sends.map(group => group.length)], [8, 2, 8, 2]);
    assert.deepEqual([plan.edit, ...plan.sends].flat(), urls);
    assert.equal(restore.validateRestorePlan(urls, 'here', true, plan), true);
    assert.deepEqual(restore.planFromSizes(urls, 'here', [8, 2, 8, 2]), plan);
    assert.equal(restore.validateRestorePlan(urls, 'here', true, { edit: [...plan.edit].reverse(), sends: plan.sends }), false);
    const first = restore.splitRestorePlan(urls, 'first', false, measurements.slice(0, 10));
    assert.deepEqual([first.edit.length, ...first.sends.map(group => group.length)], [8, 2]);
    assert.deepEqual([first.edit, ...first.sends].flat(), urls.slice(0, 10));
    const fresh = restore.splitRestorePlan(urls, 'new', false, measurements);
    assert.deepEqual(fresh.sends.map(group => group.length), [8, 2, 8, 2]);
    assert.deepEqual(fresh.sends.flat(), urls);
    assert.throws(() => restore.splitRestorePlan(urls, 'new', false, measurements.map((item, i) => i ? item : { ...item, size: 25 * 1024 * 1024 + 1 })), /GRID_RESTORE_SIZE/);
});

test('limited inline capacity preserves all selected images in subsequent parts', () => {
    const urls = fixture(13).payload.imageUrls, measurements = urls.map(source => ({ source, size: 4, format: 'jpeg', sha256: 'a'.repeat(64) }));
    const plan = restore.splitRestorePlan(urls, 'rest', false, measurements, 80 * 1024 * 1024, undefined, 1);
    assert.deepEqual([plan.edit.length, ...plan.sends.map(group => group.length)], [1, 9, 3]);
    assert.deepEqual([plan.edit, ...plan.sends].flat(), urls);
    const first = restore.splitRestorePlan(urls, 'first', false, measurements.slice(0, 10), 80 * 1024 * 1024, undefined, 1);
    assert.deepEqual([first.edit.length, ...first.sends.map(group => group.length)], [1, 9]);
});

test('size measurement retains only hashes and discards original image bytes', async () => {
    const urls = [image(0), image(1)], limits = [], data = Buffer.from('ffd8ff00', 'hex');
    const values = await restore.measureRestoreImages(urls, {}, { fetchTwitterMedia: async (_url, options) => { limits.push(options); return { data, format: 'jpeg' }; } });
    assert.deepEqual(values.map(item => item.source), urls);
    assert.ok(values.every(item => item.size === 4 && /^[a-f0-9]{64}$/.test(item.sha256) && !Object.hasOwn(item, 'data')));
    assert.ok(limits.every(item => item.maxBytes === 25 * 1024 * 1024));
});

function executorFixture() {
    const f = fixture(13), firstId = '555555555555555555', secondId = '666666666666666666';
    f.message.id = firstId; f.payload.messageIds = [firstId, secondId];
    const snapshot = { payload: f.payload, first: f.message }, events = [], state = { last: firstId, active: false, fail: null };
    const a = {
        withLock: async (_request, work) => state.active ? { status: 'blocked' } : work(snapshot),
        authorize: async () => state.fail !== 'denied', latestMessageId: async () => state.last, adjacency: async () => 'adjacent', fileLimit: async () => 25 * 1024 * 1024,
        verifyLiveSource: async () => f.payload.imageUrls,
        measureImages: async urls => urls.map(source => ({ source, size: 4, format: 'jpeg', sha256: require('node:crypto').createHash('sha256').update(Buffer.from('ffd8ff00', 'hex')).digest('hex') })),
        prepareImages: async urls => urls.map(source => ({ source, data: Buffer.from('ffd8ff00', 'hex'), format: 'jpeg' })), preflight: async () => true,
        begin: async () => { state.active = true; events.push('begin'); return { id: 'b'.repeat(32) }; },
        cancel: async () => { events.push('cancel'); state.active = false; },
        plan: async (_op, step) => { events.push(`plan:${step.type}`); if (state.fail === 'plan') throw Error('db'); },
        reject: async () => { events.push('reject'); },
        confirm: async (_op, step) => { events.push(`confirm:${step.type}`); if (state.fail === 'receipt') throw Error('db'); },
        finish: async () => { events.push('finish'); state.active = false; },
        markUnknown: async () => { events.push('unknown'); },
        editOnce: async () => { events.push('edit'); if (state.fail === 'edit') throw Error('timeout'); return { id: firstId }; },
        sendOnce: async () => { events.push('send'); if (state.fail === 'send') throw Error('timeout'); state.last = secondId; return { id: secondId }; },
        verifyResult: async () => state.fail !== 'verify',
    };
    return { snapshot, events, state, a, firstId, secondId };
}

test('ten older photos with room for nine restore only after an explicit destination choice', async () => {
    const f = executorFixture();
    f.snapshot.payload.imageUrls = f.snapshot.payload.imageUrls.slice(0, 10);
    f.state.last = '777777777777777777';
    f.a.rootCapacity = async () => 9;
    const groups = [], edit = f.a.editOnce, send = f.a.sendOnce;
    f.a.editOnce = async (...args) => { groups.push(['edit', args[2].length]); return edit(...args); };
    f.a.sendOnce = async (...args) => { groups.push(['send', args[2].length]); return send(...args); };
    assert.deepEqual(await restore.executeRestore({ mode: 'rest' }, f.a), { status: 'done', completed: 2 });
    assert.deepEqual(groups, [['edit', 9], ['send', 1]]);
    const g = executorFixture();
    g.snapshot.payload.imageUrls = g.snapshot.payload.imageUrls.slice(0, 10);
    g.state.last = '777777777777777777'; g.a.rootCapacity = async () => 9;
    assert.deepEqual(await restore.executeRestore({ mode: 'new' }, g.a), { status: 'done', completed: 1 });
    assert.equal(g.events.includes('edit'), false);
});

test('a changed channel tail invalidates the selected ten-photo destination before writing', async () => {
    const f = executorFixture();
    f.snapshot.payload.imageUrls = f.snapshot.payload.imageUrls.slice(0, 10);
    f.a.rootCapacity = async () => 9;
    let calls = 0;
    f.a.latestMessageId = async () => ++calls === 1 ? f.firstId : '777777777777777777';
    assert.equal((await restore.executeRestore({ mode: 'here' }, f.a)).status, 'choice_changed');
    assert.equal(f.events.includes('edit'), false); assert.equal(f.events.includes('send'), false);
    const g = executorFixture();
    g.snapshot.payload.imageUrls = g.snapshot.payload.imageUrls.slice(0, 10);
    g.a.rootCapacity = async () => 9; g.state.last = g.firstId;
    assert.equal((await restore.executeRestore({ mode: 'rest' }, g.a)).status, 'choice_changed');
    assert.equal(g.events.includes('edit'), false); assert.equal(g.events.includes('send'), false);
});

test('the durable plan precedes each edit and one-shot send', async () => {
    const f = executorFixture();
    const batches = [];
    const prepare = f.a.prepareImages;
    f.a.prepareImages = async (urls, limits) => { batches.push([urls.length, limits]); return prepare(urls); };
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'done', completed: 2 });
    assert.deepEqual(f.events, ['begin', 'plan:edit', 'edit', 'confirm:edit', 'plan:send', 'send', 'confirm:send', 'finish']);
    assert.deepEqual(batches.map(([count]) => count), [10, 3]);
    assert.ok(batches.every(([, limits]) => limits.maxTotalBytes === 80 * 1024 * 1024 && limits.concurrency === 2));
});

test('a failed journal write cannot reach Discord, and an uncertain result is never resent', async () => {
    const f = executorFixture(); f.state.fail = 'plan';
    await assert.rejects(restore.executeRestore({ mode: 'here' }, f.a), /db/);
    assert.deepEqual(f.events, ['begin', 'plan:edit']);
    for (const error of ['edit', 'send', 'receipt', 'verify']) {
        const g = executorFixture(); g.state.fail = error;
        assert.equal((await restore.executeRestore({ mode: 'here' }, g.a)).status, 'unknown');
        assert.equal(g.events.at(-1), 'unknown');
        assert.deepEqual(await restore.executeRestore({ mode: 'here' }, g.a), { status: 'blocked' });
        assert.ok(g.events.filter(event => event === 'edit').length <= 1);
        assert.ok(g.events.filter(event => event === 'send').length <= 1);
    }
});

test('a definite Discord rejection is cancelable; a forged parse error with 403 remains uncertain', async () => {
    const f = executorFixture(), { DiscordAPIError, RateLimitError } = require('discord.js');
    f.a.editOnce = async () => { f.events.push('edit'); throw new DiscordAPIError({ message: 'forbidden' }, 50013, 403, 'PATCH', '/fixture', {}); };
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'rejected', completed: 0 });
    assert.deepEqual(f.events, ['begin', 'plan:edit', 'edit', 'reject', 'cancel']);
    const g = executorFixture();
    g.a.editOnce = async () => { g.events.push('edit'); throw Object.assign(new SyntaxError('invalid response'), { status: 403 }); };
    assert.equal((await restore.executeRestore({ mode: 'here' }, g.a)).status, 'unknown');
    assert.equal(g.events.includes('reject'), false); assert.equal(g.events.at(-1), 'unknown');
    const h = executorFixture();
    h.a.editOnce = async () => { h.events.push('edit'); throw new RateLimitError({ timeToReset: 1, limit: 1, method: 'PATCH', hash: 'test', url: '/fixture', route: '/fixture', majorParameter: '1', global: false, retryAfter: 1, sublimitTimeout: 0, scope: 'user' }); };
    assert.equal((await restore.executeRestore({ mode: 'here' }, h.a)).status, 'rejected');
    assert.deepEqual(h.events, ['begin', 'plan:edit', 'edit', 'reject', 'cancel']);
});

test('changed permission, post or channel tail while journaling stops before edit and send', async () => {
    for (const change of ['permission', 'source', 'tail']) {
        const f = executorFixture(), plan = f.a.plan;
        f.a.plan = async (...args) => {
            await plan(...args);
            if (change === 'permission') f.state.fail = 'denied';
            else if (change === 'source') f.a.verifyLiveSource = async () => null;
            else f.state.last = '999999999999999999';
        };
        const result = await restore.executeRestore({ mode: 'here' }, f.a);
        assert.equal(result.status, { permission: 'denied', source: 'source_unavailable', tail: 'choice_changed' }[change]);
        assert.equal(f.events.includes('edit'), false); assert.equal(f.events.includes('send'), false);
        assert.ok(f.events.includes('reject')); assert.equal(f.state.active, false);
    }
    const f = executorFixture(), originalPlan = f.a.plan;
    f.a.plan = async (operation, step) => {
        await originalPlan(operation, step);
        if (step.type === 'send') f.state.last = '999999999999999999';
    };
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'partial', completed: 1 });
    assert.equal(f.events.filter(value => value === 'edit').length, 1);
    assert.equal(f.events.includes('send'), false); assert.equal(f.events.at(-1), 'reject');
});

test('an expired restoration deadline never starts another Discord request', async () => {
    for (const expireAt of ['edit', 'send']) {
        const f = executorFixture(); let now = Date.now(); f.a.now = () => now;
        const plan = f.a.plan;
        f.a.plan = async (operation, step) => { await plan(operation, step); if (step.type === expireAt) now += 90001; };
        const result = await restore.executeRestore({ mode: 'here' }, f.a);
        assert.equal(result.status, expireAt === 'edit' ? 'unavailable' : 'partial');
        assert.equal(f.events.filter(value => value === 'edit').length, expireAt === 'edit' ? 0 : 1);
        assert.equal(f.events.includes('send'), false); assert.ok(f.events.includes('reject'));
    }
});

test('a post inserted after the last-message check is reported without resending or altering it', async () => {
    const f = executorFixture(); f.a.adjacency = async () => 'separated';
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'separated', completed: 2 });
    assert.equal(f.events.filter(value => value === 'send').length, 1);
    assert.equal(f.events.includes('finish'), false);
});

test('new channel messages invalidate an automatic in-place restore without modifying them', async () => {
    const f = executorFixture(), unrelated = '777777777777777777';
    f.a.editOnce = async () => { f.events.push('edit'); f.state.last = unrelated; return { id: f.firstId }; };
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'partial', completed: 1 });
    assert.equal(f.events.includes('send'), false);
    const g = executorFixture(); g.state.last = unrelated;
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, g.a), { status: 'choice_changed' });
    assert.equal(g.events.includes('begin'), false);
});

test('a single-message restore remains available when the channel has newer messages', async () => {
    const f = executorFixture();
    f.snapshot.payload.imageUrls = f.snapshot.payload.imageUrls.slice(0, 10);
    f.state.last = '777777777777777777';
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'done', completed: 1 });
    assert.equal(f.events.includes('send'), false);
});

test('a failed later image download leaves the confirmed first group and never sends an unprepared continuation', async () => {
    const f = executorFixture(); let calls = 0; const prepare = f.a.prepareImages;
    f.a.prepareImages = async urls => { if (++calls === 2) throw Error('network'); return prepare(urls); };
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'partial', completed: 1 });
    assert.equal(f.events.includes('send'), false);
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'blocked' });
});

test('channel and source are rechecked after a slow download before starting an edit', async () => {
    const f = executorFixture(), prepare = f.a.prepareImages;
    f.a.prepareImages = async urls => { const output = await prepare(urls); f.state.last = '777777777777777777'; return output; };
    assert.equal((await restore.executeRestore({ mode: 'here' }, f.a)).status, 'choice_changed');
    assert.equal(f.events.includes('edit'), false);
    assert.equal(f.state.active, false);
});

test('revoked permission or a changed original post prevents all writes', async () => {
    const f = executorFixture(); f.state.fail = 'denied';
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, f.a), { status: 'denied' });
    assert.deepEqual(f.events, []);
    const g = executorFixture(); g.a.verifyLiveSource = async () => null;
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, g.a), { status: 'source_unavailable' });
    assert.deepEqual(g.events, []);
});

test('a missing or exceeded Discord per-file size limit stops before any mutation', async () => {
    const a = executorFixture(); a.a.fileLimit = async () => null;
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, a.a), { status: 'size_limit_unavailable' });
    assert.deepEqual(a.events, []);
    const b = executorFixture(); b.a.fileLimit = async () => 3;
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, b.a), { status: 'image_too_large', fileLimit: 3 });
    assert.deepEqual(b.events, []);
});

test('concurrent restorations are bounded even while a network call is in flight', async () => {
    let release, entered = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const fixtures = [executorFixture(), executorFixture(), executorFixture()];
    for (const f of fixtures) f.a.verifyLiveSource = async () => { entered++; await gate; return f.snapshot.payload.imageUrls; };
    const first = restore.executeRestore({ mode: 'here' }, fixtures[0].a);
    const second = restore.executeRestore({ mode: 'here' }, fixtures[1].a);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, 2);
    assert.deepEqual(await restore.executeRestore({ mode: 'here' }, fixtures[2].a), { status: 'busy' });
    assert.deepEqual(await restore.withRestorationSlot(async () => ({ status: 'should_not_run' })), { status: 'busy' });
    release();
    assert.equal((await first).status, 'done');
    assert.equal((await second).status, 'done');
});

test('restore history requires the expected guild and channel even for other users posts', async () => {
    const channelId = '333333333333333333', guildId = '222222222222222222';
    const a = '555555555555555555', b = '777777777777777777', scope = { channelId, guildId };
    let entries = [{ id: a, channelId, guildId }, { id: b, channelId, guildId }];
    const channel = { id: channelId, messages: { fetch: async options => new Map((options.limit === 1 ? entries.slice(-1) : entries).map(item => [item.id, item])) } };
    assert.equal(await restore.latestMessageId(channel, scope), b);
    assert.equal(await restore.adjacency(channel, a, b, scope), 'adjacent');
    for (const field of ['id', 'channelId', 'guildId']) for (const value of [undefined, '999999999999999999']) {
        const old = entries[1]; entries[1] = { ...old, [field]: value };
        // A different valid ID is a valid channel tail; no prior ID is known.
        if (field === 'id' && value) assert.equal(await restore.latestMessageId(channel, scope), value);
        else await assert.rejects(restore.latestMessageId(channel, scope), /GRID_RESTORE_UNAVAILABLE/);
        assert.equal(await restore.adjacency(channel, a, b, scope), 'unavailable');
        entries[1] = old;
    }
});
