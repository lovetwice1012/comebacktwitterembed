'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../src/twitterGridCards');
const grid = require('../../src/components/twitterGrid')._internal;
const { embeddedImage, logicalAttachments } = require('../../src/discordAttachmentIdentity');

const channelId = '444444444444444444';
const file = (id, name, signature = '1') => `https://cdn.discordapp.com/attachments/${channelId}/${id}/${name}?ex=${signature}&is=2&hm=abc`;
function continuation() {
    return { channelId, content: '', components: [], attachments: new Map(), embeds: [
        { url: 'https://x.com/a/status/1', image: { url: file('777777777777777771', 'photo1.jpg') } },
        { url: 'https://x.com/a/status/1', image: { url: file('777777777777777772', 'photo2.png') } },
    ] };
}
const evidence = { containsNonImage: false, refs: [
    { type: 'url', url: 'https://pbs.twimg.com/media/one?format=jpg' },
    { type: 'url', url: 'https://pbs.twimg.com/media/two?format=png' },
], imageUrls: ['https://pbs.twimg.com/media/one?format=jpg', 'https://pbs.twimg.com/media/two?format=png'], offset: 0 };

test('embedded CDN images hidden from attachments remain a verified continuation', () => {
    const message = continuation(), signature = cards.fingerprint(message);
    assert.equal(logicalAttachments(message).length, 2);
    assert.equal(grid.safeContinuation(message, signature, 2, evidence), true);
    message.embeds[0].image.url = file('777777777777777771', 'photo1.jpg', 'f');
    assert.equal(cards.fingerprint(message), signature, 'only Discord signature renewal is ignored');
    assert.equal(grid.safeContinuation(message, signature, 2, evidence), true);
    assert.equal(grid.safeContinuation(message, signature, 2), false, 'hidden image MIME must not be guessed without a manifest');
    assert.equal(grid.safeContinuation(message, signature, 2, { ...evidence, containsNonImage: true }), false);
    assert.equal(grid.safeContinuation(message, signature, 2, { ...evidence, refs: [{ type: 'url', url: 'https://video.twimg.com/v.mp4' }] }), false);
    assert.equal(grid.safeContinuation(message, signature, 2, { ...evidence, imageUrls: [...evidence.imageUrls].reverse() }), false);
});

test('foreign, ambiguous, non-image or changed embedded content cannot authorize deletion', () => {
    for (const mutate of [
        m => { m.embeds[0].image.url = m.embeds[0].image.url.replace('cdn.discordapp.com', 'attacker.invalid'); },
        m => { m.embeds[0].image.url = m.embeds[0].image.url.replace(channelId, '999999999999999999'); },
        m => { m.embeds[0].image.url += '&width=1'; },
        m => { m.embeds[0].image.url = file('777777777777777773', 'photo1.jpg'); },
        m => { m.embeds[1].image.url = m.embeds[0].image.url; },
        m => { m.embeds[0].description = 'unrelated content'; },
        m => { m.content = 'unrelated content'; },
        m => { m.embeds[0].image.url = file('777777777777777771', 'SPOILER_photo1.jpg'); },
    ]) {
        const message = continuation(), signature = cards.fingerprint(message);
        mutate(message);
        assert.equal(grid.safeContinuation(message, signature, 2, evidence), false);
    }
    assert.equal(embeddedImage(file('777777777777777771', 'photo1.jpg'), '999999999999999999'), null);
});

test('legacy signatures remain accepted only while the original contents are unchanged', () => {
    const message = continuation(), previous = cards.legacyFingerprint(message);
    assert.equal(cards.matchesFingerprint(message, previous), true);
    message.embeds[0].image.url = file('777777777777777771', 'photo1.jpg', 'f');
    assert.equal(cards.matchesFingerprint(message, previous), false);
});

test('replacing a hidden combined marker retains an unrelated hidden restored quote', () => {
    const id = 'a'.repeat(32), markerId = '777777777777777771', quoteId = '777777777777777772';
    const message = { channelId, content: '', components: [], attachments: new Map(), embeds: [
        { title: 'parent', image: { url: file(markerId, `tg-${id}.jpg`) } },
        { title: 'quote', image: { url: file(quoteId, `restore-${'b'.repeat(32)}-0.jpg`) } },
    ] };
    const payload = { id, isPrimary: true, sharedInline: true, imageUrls: [], embedStart: 0, embedEnd: 1 };
    const result = grid.editPayload(message, payload, { data: Buffer.from('new'), filename: 'grid.png' }, new Map([[id, payload]]));
    assert.deepEqual(result.attachments, [{ id: quoteId }]);
    assert.equal(result.embeds[1].image.url, message.embeds[1].image.url);
    assert.equal(result.embeds[0].image.url, `attachment://tg-${id}.png`);
});

test('combining a quote retains hidden and visible parent photos', () => {
    const id = 'c'.repeat(32), hiddenId = '777777777777777771', visibleId = '777777777777777772';
    const original = 'https://pbs.twimg.com/media/quoted?format=jpg';
    const message = { channelId, content: '', components: [], embeds: [
        { title: 'parent', image: { url: file(hiddenId, 'parent-hidden.jpg') } },
        { title: 'quote', image: { url: original } },
    ], attachments: new Map([[visibleId, { id: visibleId, name: 'parent-visible.jpg', contentType: 'image/jpeg', url: file(visibleId, 'parent-visible.jpg') }]]) };
    const payload = { id, isPrimary: false, sharedInline: true, imageUrls: [original], embedStart: 1, embedEnd: 2 };
    const result = grid.editPayload(message, payload, { data: Buffer.from('new'), filename: 'grid.jpg' });
    assert.deepEqual(new Set(result.attachments.map(item => item.id)), new Set([hiddenId, visibleId]));
    assert.equal(result.embeds[0].image.url, message.embeds[0].image.url);
    assert.equal(result.embeds[1].image.url, `attachment://tg-${id}.jpg`);
});
