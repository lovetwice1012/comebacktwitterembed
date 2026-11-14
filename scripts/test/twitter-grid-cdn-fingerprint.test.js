'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../src/twitterGridCards');
const grid = require('../../src/components/twitterGrid')._internal;
const restore = require('../../src/twitterGridRestore');

const channelId = '444444444444444444', otherChannel = '999999999999999999';
const fileId = '777777777777777777', otherFileId = '888888888888888888';
const messageId = '555555555555555555', bot = '222222222222222222', name = 'image.jpg';
const url = (options = {}) => {
    const { host = 'cdn.discordapp.com', channel = channelId, file = fileId, filename = name,
        query = 'ex=1234&is=5678&hm=abcdef', hash = '' } = options;
    return `https://${host}/attachments/${channel}/${file}/${filename}${query ? `?${query}` : ''}${hash}`;
};
function message(imageUrl, overrides = {}) {
    return { id: messageId, channelId, author: { id: bot }, content: 'stable', components: [],
        embeds: [{ title: 'source', image: { url: imageUrl } }],
        attachments: new Map([[fileId, { id: fileId, name, contentType: 'image/jpeg', url: url() }]]), ...overrides };
}

test('only refreshed signing parameters of this actual Discord attachment are ignored', () => {
    const original = message(url()), refreshed = message(url({ query: 'hm=123abc&is=abcdef&ex=9876' }));
    assert.equal(cards.fingerprint(original), cards.fingerprint(refreshed));
    assert.notEqual(cards.legacyFingerprint(original), cards.legacyFingerprint(refreshed));
    assert.equal(cards.matchesFingerprint(refreshed, cards.fingerprint(original)), true);
    assert.equal(cards.matchesFingerprint(original, cards.legacyFingerprint(original)), true);
    assert.equal(cards.matchesFingerprint(refreshed, cards.legacyFingerprint(original)), false,
        'a legacy hash cannot prove an already refreshed URL and must not be guessed');
});

test('attachment scheme and CDN refer to the same unique, channel-bound attachment', () => {
    const cdn = message(url());
    const symbolic = message(`attachment://${name}`);
    assert.equal(cards.fingerprint(symbolic), cards.fingerprint(cdn));
    const ambiguous = message(`attachment://${name}`, { attachments: [
        { id: fileId, name, url: url() }, { id: otherFileId, name, url: url({ file: otherFileId }) },
    ] });
    assert.notEqual(cards.fingerprint(ambiguous), cards.fingerprint(cdn));
    const invalidUrl = message(`attachment://${name}`, { attachments: [{ id: fileId, name, url: url({ host: 'attacker.invalid' }) }] });
    assert.notEqual(cards.fingerprint(invalidUrl), cards.fingerprint(cdn));
    const wrongChannel = message(`attachment://${name}`, { attachments: [{ id: fileId, name, url: url({ channel: otherChannel }) }] });
    assert.notEqual(cards.fingerprint(wrongChannel), cards.fingerprint(cdn));
    const extraQuery = message(`attachment://${name}`, { attachments: [{ id: fileId, name, url: url({ query: 'ex=1234&is=5678&hm=abcdef&width=30' }) }] });
    assert.notEqual(cards.fingerprint(extraQuery), cards.fingerprint(cdn));
});

test('an exact local attachment reference works but ambiguous or foreign references cannot authorize continuation', () => {
    const firstFile = { id: fileId, name, contentType: 'image/jpeg', url: url() };
    const one = message(`attachment://${name}`, { content: '', embeds: [{ image: { url: `attachment://${name}` } }], attachments: [firstFile] });
    const signature = cards.fingerprint(one);
    assert.equal(grid.safeContinuation(one, signature, 1), true);
    const duplicate = { ...one, attachments: [firstFile, { id: otherFileId, name, contentType: 'image/jpeg', url: url({ file: otherFileId }) }] };
    assert.equal(grid.safeContinuation(duplicate, cards.fingerprint(duplicate), 2), false);
    const foreign = { ...one, embeds: [{ image: { url: url({ host: 'attacker.invalid' }) } }] };
    assert.equal(grid.safeContinuation(foreign, cards.fingerprint(foreign), 1), false);
    const wrongChannel = { ...one, embeds: [{ image: { url: url({ channel: otherChannel }) } }] };
    assert.equal(grid.safeContinuation(wrongChannel, cards.fingerprint(wrongChannel), 1), false);
});

test('restore accepts a unique channel-bound marker scheme but not ambiguous or forged attachments', () => {
    const group = 'a'.repeat(32), markerName = `tg-${group}.jpg`, statusId = '1234567890123456789';
    const marker = { id: fileId, name: markerName, contentType: 'image/jpeg', url: url({ filename: markerName }) };
    const payload = { id: group, replacePhase: 'done' };
    const original = message(`attachment://${markerName}`, { attachments: [marker],
        embeds: [{ url: `https://x.com/example/status/${statusId}`, image: { url: `attachment://${markerName}` } }] });
    assert.equal(restore.statusFromCombined(payload, original)?.id, statusId);
    const refreshed = { ...original, embeds: [{ ...original.embeds[0], image: { url: marker.url.replace('ex=1234', 'ex=9999') } }] };
    assert.equal(restore.statusFromCombined(payload, refreshed)?.id, statusId);
    for (const bad of [
        { ...original, attachments: [marker, { ...marker, id: otherFileId }] },
        { ...original, attachments: [{ ...marker, url: marker.url.replace(channelId, otherChannel) }] },
        { ...original, attachments: [{ ...marker, url: marker.url.replace('cdn.discordapp.com', 'attacker.invalid') }] },
        { ...original, channelId: otherChannel },
    ]) assert.equal(restore.statusFromCombined(payload, bad), null);
});

test('the same verified attachment in a thumbnail is stable, including static fingerprints', () => {
    const original = message(url()), refreshed = message(url({ query: 'hm=123abc&is=abcdef&ex=9876' }));
    original.embeds[0].thumbnail = { url: url() };
    refreshed.embeds[0].thumbnail = { url: url({ query: 'hm=123abc&is=abcdef&ex=9876' }) };
    assert.equal(cards.fingerprint(original, true), cards.fingerprint(refreshed, true));
    assert.notEqual(cards.legacyFingerprint(original, true), cards.legacyFingerprint(refreshed, true));
    assert.equal(cards.matchesFingerprint(original, cards.legacyFingerprint(original, true), true), true);
    assert.equal(cards.matchesFingerprint(refreshed, cards.legacyFingerprint(original, true), true), false);
});

test('untrusted URL, other channel/file, missing or ambiguous attachment and unrelated query remain distinct', () => {
    const signed = message(url()), altered = [
        message(url({ host: 'attacker.invalid', query: 'ex=9999&is=5678&hm=abcdef' })),
        message(url({ channel: otherChannel, query: 'ex=9999&is=5678&hm=abcdef' })),
        message(url({ file: otherFileId, query: 'ex=9999&is=5678&hm=abcdef' })),
        message(url({ filename: 'other.jpg', query: 'ex=9999&is=5678&hm=abcdef' })),
        message(url({ query: 'ex=9999&is=5678&hm=abcdef&width=512' })),
        message(url({ query: 'ex=9999&ex=1111&is=5678&hm=abcdef' })),
        message(url({ query: 'ex=9999&is=5678&hm=abcdef', hash: '#x' })),
        message(url({ query: 'ex=9999&is=5678&hm=abcdef' }), { channelId: otherChannel }),
        message(url({ query: 'ex=9999&is=5678&hm=abcdef' }), { attachments: new Map() }),
        message(url({ query: 'ex=9999&is=5678&hm=abcdef' }), { attachments: [{ id: fileId, name }, { id: fileId, name }] }),
        message(url({ query: 'ex=9999&is=5678&hm=abcdef' }), { content: 'changed' }),
    ];
    for (const candidate of altered) assert.notEqual(cards.fingerprint(candidate), cards.fingerprint(signed));
});

test('embed witnesses accept exact legacy hashes and new signatures across refresh without accepting edits', () => {
    const old = message(url()), current = message(url({ query: 'ex=9999&is=5555&hm=eeff' }));
    const attachments = [{ id: fileId, name }];
    const v2 = { hashes: [cards.embedFingerprint(old.embeds[0], old)], attachments };
    const legacy = { hashes: [cards.embedFingerprint(old.embeds[0])], attachments };
    assert.deepEqual(grid.embedWitnessPosition(current, v2), { start: 0, end: 1 });
    assert.deepEqual(grid.embedWitnessPosition(old, legacy), { start: 0, end: 1 });
    assert.equal(grid.embedWitnessPosition(current, legacy), null);
    current.embeds[0].title = 'changed';
    assert.equal(grid.embedWitnessPosition(current, v2), null);
});

test('saved v2 signatures survive refresh; legacy records require their exact old content', async () => {
    const old = message(url()), current = message(url({ query: 'ex=9999&is=5555&hm=eeff' }));
    const payload = { messageIds: [messageId], completedParts: 1, partSignatures: [cards.fingerprint(old)] };
    const interaction = { channelId, client: { user: { id: bot } }, channel: { messages: { fetch: async () => current } } };
    assert.equal(await grid.sourcesRemainValid(interaction, { message_id: messageId, payload }), true);
    payload.partSignatures[0] = cards.legacyFingerprint(old);
    const before = payload.partSignatures[0];
    assert.equal(await grid.sourcesRemainValid(interaction, { message_id: messageId, payload }), false);
    assert.equal(payload.partSignatures[0], before, 'unprovable legacy state is not rewritten');
    interaction.channel.messages.fetch = async () => old;
    assert.equal(await grid.sourcesRemainValid(interaction, { message_id: messageId, payload }), true);
});
