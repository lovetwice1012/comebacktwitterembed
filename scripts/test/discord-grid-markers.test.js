'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const markers = require('../../src/discordGridMarkers');
const channel = '444444444444444444', id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fileId = '555555555555555555';
const name = `tg-${id}.jpg`, url = `https://cdn.discordapp.com/attachments/${channel}/${fileId}/${name}?ex=1&is=2&hm=abc`;
const file = { id: fileId, name, contentType: 'image/jpeg', url };
const message = (images, files = []) => ({ channelId: channel, embeds: images.map(value => ({ image: { url: value } })), attachments: new Map(files.map((f, i) => [String(i), f])) });

test('one verified embedded marker is recognized even if Discord omits its attachment object', () => {
    const entry = markers.get(message([url]), id);
    assert.deepEqual(entry, { id: fileId, name, url, attached: false, embedIndices: [0] });
    const both = markers.get(message([url], [file]), id);
    assert.equal(both.attached, true); assert.deepEqual(both.embedIndices, [0]);
});

test('embedded markers require the exact channel, Discord host, file ID, filename, query and uniqueness', () => {
    for (const invalid of [url.replace(channel, '999'), url.replace('cdn.discordapp.com', 'attacker.example'),
        url.replace(fileId, 'not-a-snowflake'), `${url}&width=1`, `${url}&ex=2`, `${url}#fragment`]) {
        assert.equal(markers.collect(message([invalid])), null, invalid);
    }
    assert.equal(markers.collect(message([url, url])), null);
    assert.equal(markers.collect(message([url], [file, { ...file, id: '777777777777777777' }])), null);
    assert.equal(markers.collect(message([url, url.replace(id, 'b'.repeat(32))])), null, 'one attachment ID cannot represent two galleries');
    assert.equal(markers.collect({ ...message([url]), channelId: undefined }), null);
});

test('attachment scheme is accepted only for a unique, channel-bound physical attachment', () => {
    assert.equal(markers.get(message([`attachment://${name}`], [file]), id).id, fileId);
    assert.equal(markers.collect(message([`attachment://${name}`])), null);
    assert.equal(markers.collect(message([`attachment://${name}`], [{ ...file, url: url.replace(channel, '999') }])), null);
});

test('operation fingerprint tolerates marker visibility and signed URL refresh, not content or identity changes', () => {
    const hidden = message([url]);
    const visible = message([url.replace('ex=1', 'ex=3')], [file]);
    assert.equal(markers.stableFingerprint(hidden), markers.stableFingerprint(visible));
    assert.notEqual(markers.stableFingerprint(hidden), markers.stableFingerprint({ ...visible, content: 'changed' }));
    assert.notEqual(markers.stableFingerprint(hidden), markers.stableFingerprint(message([url.replace(fileId, '777777777777777777')])));
    assert.equal(markers.stableFingerprint(message([url.replace(channel, '999')])), null);
});
