'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchesReference, canonicalUrl } = require('../../src/discordAttachmentIdentity');
const { matchesEdit } = require('../../src/twitterGridLegacyActions');
const legacy = require('../../src/twitterGridLegacyActions');
const grid = require('../../src/components/twitterGrid')._internal;
const cards = require('../../src/twitterGridCards');
const { createHash } = require('node:crypto');

const channel = '111111111111111111', fileId = '222222222222222222';
const file = { id: fileId, name: 'hello world.png' };
const base = `https://cdn.discordapp.com/attachments/${channel}/${fileId}/hello%20world.png`;
const message = { channelId: channel, attachments: new Map([[fileId, file]]) };

test('only a verified Discord attachment has its signed query removed', () => {
    for (const query of ['', '?ex=abc&is=def&hm=1234', '?hm=abcd&is=1&ex=2']) {
        assert.equal(matchesReference(base + query, file, channel), true);
        assert.equal(canonicalUrl(base + query, message), base);
    }
    const proxy = base.replace('cdn.discordapp.com', 'media.discordapp.net');
    assert.equal(canonicalUrl(proxy + '?ex=1&is=2&hm=abc', message), proxy);
    assert.notEqual(canonicalUrl(proxy, message), canonicalUrl(base, message));
});

test('other query data, duplicate signatures and unsafe URL forms are retained and never matched', () => {
    for (const value of [base + '?', base + '?ex=1&is=2&hm=3&width=50', base + '?ex=1&ex=2', base + '?ex=xyz',
        base + '#fragment', base.replace('https:', 'http:'), base.replace('cdn.discordapp.com', 'evil.example'),
        base.replace('cdn.discordapp.com', 'cdn.discordapp.com.evil.example'), base.replace('cdn.discordapp.com', 'x@cdn.discordapp.com'),
        base.replace('cdn.discordapp.com', 'cdn.discordapp.com:8443')]) {
        assert.equal(matchesReference(value, file, channel), false, value);
        assert.equal(canonicalUrl(value, message), value, value);
    }
});

test('the channel, attachment ID and exact filename must match one unique message attachment', () => {
    for (const value of [base.replace(channel, '333333333333333333'), base.replace(fileId, '444444444444444444'), base.replace('hello%20world.png', 'other.png')]) {
        assert.equal(matchesReference(value, file, channel), false);
        assert.equal(canonicalUrl(value, message), value);
    }
    assert.equal(canonicalUrl(base + '?ex=1', { ...message, channelId: '333333333333333333' }), base + '?ex=1');
    assert.equal(canonicalUrl(base + '?ex=1', { ...message, attachments: [file, { ...file }] }), base + '?ex=1');
    assert.equal(matchesReference(`attachment://${file.name}`, file, channel), false);
    assert.equal(matchesReference(`attachment://${file.name}`, file, channel, { allowAttachmentScheme: true }), true);
    assert.equal(matchesReference('attachment://other.png', file, channel, { allowAttachmentScheme: true }), false);
});

test('a foreign host or channel cannot impersonate an attachment in a journal proof', () => {
    const actualFile = { ...file, url: base, contentType: 'image/png' };
    const expected = { content: '', embeds: [{ image: { url: `attachment://${file.name}` } }], components: [] };
    const withImage = url => ({ channelId: channel, content: '', embeds: [{ image: { url } }], components: [], attachments: new Map([[fileId, actualFile]]) });
    for (const value of [base.replace('cdn.discordapp.com', 'evil.example'), base.replace(channel, '333333333333333333'),
        base.replace(fileId, '444444444444444444'), base + '?ex=1&width=50']) {
        assert.equal(matchesEdit(withImage(value), expected, [actualFile]), false, value);
        const message = withImage(value);
        assert.equal(grid.safeContinuation(message, cards.fingerprint(message), 1), false, value);
    }
    const legitimate = withImage(base + '?ex=1&is=2&hm=abc');
    assert.equal(matchesEdit(legitimate, expected, [actualFile]), true);
    assert.equal(grid.safeContinuation(legitimate, cards.fingerprint(legitimate), 1), true);
    const scheme = withImage(`attachment://${file.name}`);
    assert.equal(matchesEdit(scheme, expected, [actualFile]), true);
    assert.equal(grid.safeContinuation(scheme, cards.fingerprint(scheme), 1), true);
    for (const badUrl of [base.replace('cdn.discordapp.com', 'evil.example'), base.replace(channel, '333333333333333333'), base + '?ex=1&width=50']) {
        const badFile = { ...actualFile, url: badUrl };
        const bad = { ...scheme, attachments: new Map([[fileId, badFile]]) };
        assert.equal(matchesEdit(bad, expected, [badFile]), false, badUrl);
        assert.equal(grid.safeContinuation(bad, cards.fingerprint(bad), 1), false, badUrl);
    }
    const duplicated = { ...scheme, attachments: [actualFile, { ...actualFile, id: '666666666666666666' }] };
    assert.equal(matchesEdit(duplicated, expected, duplicated.attachments), false);
});

test('legacy journal proof still recovers the same verified CDN attachment and rejects another host', async () => {
    const galleryId = 'a'.repeat(32), operationId = 'b'.repeat(32), guildId = '333333333333333333', messageId = '444444444444444444', botId = '555555555555555555';
    const actualFile = { ...file, url: base + '?ex=1&is=2&hm=abc', contentType: 'image/png' };
    const makeMessage = url => ({ id: messageId, channelId: channel, author: { id: botId }, content: '', embeds: [{ image: { url } }], components: [], attachments: new Map([[fileId, actualFile]]) });
    // This is the v1 serialized semantic state, using the old journal's
    // canonical attachment:// representation for a matching CDN pathname.
    const oldState = { attachments: [[fileId, file.name]], components: [], content: '', embeds: [{ image: { url: `attachment://${file.name}` } }] };
    const expected = createHash('sha256').update(JSON.stringify(oldState)).digest('hex');
    const before = cards.fingerprint(makeMessage(base));
    const intent = { version: 1, kind: 'twitter-grid-legacy', operationId, galleryId, lockId: galleryId, action: 'showAttachmentsAsEmbedsImage',
        steps: [{ type: 'edit', index: 0, id: messageId, before, expected }] };
    const row = { operation_id: operationId, guild_id: guildId, channel_id: channel, message_id: messageId, payload_json: JSON.stringify(intent) };
    for (const [url, accepted] of [[base + '?ex=2&is=3&hm=def', true], [`attachment://${file.name}`, true], [base.replace('cdn.discordapp.com', 'evil.example'), false],
        [base.replace(channel, '666666666666666666'), false], [base + '?ex=2&width=500', false]]) {
        const payload = { id: galleryId, lockId: galleryId, messageIds: [messageId], partSignatures: [before] };
        const interaction = { guildId, channelId: channel, client: { user: { id: botId } }, channel: { messages: { fetch: async () => makeMessage(url) } } };
        const db = { queryDatabaseIndependent: async () => [row] };
        let updates = 0;
        const query = async () => { updates++; return { affectedRows: 1 }; };
        if (accepted) { assert.equal((await legacy.recover({ interaction, payload, query, db })).operationId, operationId); assert.equal(updates, 1); }
        else { await assert.rejects(legacy.recover({ interaction, payload, query, db }), /GRID_LOCK_UNAVAILABLE/); assert.equal(updates, 0); }
    }
});
