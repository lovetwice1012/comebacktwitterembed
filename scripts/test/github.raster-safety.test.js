'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { encodePng, decodeRasterImage } = require('../../src/providers/github/raster');
const { createGitHubClient } = require('../../src/providers/github/client');

function chunk(type, data) {
    const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length, 0); value.write(type, 4); data.copy(value, 8);
    let crc = 0xffffffff;
    for (const byte of value.subarray(4, 8 + data.length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    value.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return value;
}

function pngWithInflatedBytes(bytes) {
    const template = encodePng(1, 1, Buffer.from([1, 2, 3, 255]));
    const idat = template.indexOf(Buffer.from('IDAT'));
    const header = template.subarray(0, idat - 4), data = zlib.deflateSync(bytes);
    return Buffer.concat([header, chunk('IDAT', data), template.subarray(idat + 4 + template.readUInt32BE(idat - 4) + 4)]);
}

function rawPng(colorType, pixels, transparency) {
    const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = colorType;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
        ...(transparency ? [chunk('tRNS', transparency)] : []), chunk('IDAT', zlib.deflateSync(Buffer.from([0, ...pixels]))), chunk('IEND', Buffer.alloc(0))]);
}

test('invalid, oversized and overinflated PNG data cannot crash the avatar decoder', () => {
    const corrupt = encodePng(1, 1, Buffer.from([1, 2, 3, 255]));
    corrupt[corrupt.indexOf(Buffer.from('IDAT')) + 4] = 0;
    assert.doesNotThrow(() => decodeRasterImage(corrupt));
    assert.equal(decodeRasterImage(corrupt), null);
    const badCrc = encodePng(1, 1, Buffer.from([1, 2, 3, 255]));
    const idat = badCrc.indexOf(Buffer.from('IDAT'));
    badCrc[idat + 4 + badCrc.readUInt32BE(idat - 4)] ^= 1;
    assert.equal(decodeRasterImage(badCrc), null, 'corrupted chunk checksums are rejected');
    const hugeDimensions = encodePng(1, 1, Buffer.from([1, 2, 3, 255]));
    hugeDimensions.writeUInt32BE(50000, 16); hugeDimensions.writeUInt32BE(50000, 20);
    assert.equal(decodeRasterImage(hugeDimensions), null);
    assert.equal(decodeRasterImage(pngWithInflatedBytes(Buffer.alloc(1024 * 1024))), null);
    assert.equal(decodeRasterImage(pngWithInflatedBytes(Buffer.from([5, 1, 2, 3, 255]))), null, 'unknown PNG filters are not decoded as unfiltered pixels');
    assert.ok(decodeRasterImage(encodePng(1, 1, Buffer.from([1, 2, 3, 255]))));
});

test('GitHub retries a malformed optional avatar and bounds both downloads', async () => {
    const bad = encodePng(1, 1, Buffer.from([1, 2, 3, 255])); bad[bad.indexOf(Buffer.from('IDAT')) + 4] = 0;
    const good = encodePng(1, 1, Buffer.from([4, 5, 6, 255])), sizes = [];
    const client = createGitHubClient(async (url, options) => {
        if (String(url).includes('avatars.example')) { sizes.push(options.size); return { ok: true, buffer: async () => bad }; }
        if (String(url).includes('github.com/owner.png')) { sizes.push(options.size); return { ok: true, buffer: async () => good }; }
        if (String(url).endsWith('/repos/owner/repo')) return { ok: true, json: async () => ({ full_name: 'owner/repo', owner: { login: 'owner', avatar_url: 'https://avatars.example/a' } }) };
        return { ok: true, json: async () => [] };
    });
    const data = await client.fetchGitHubData({ type: 'repo', owner: 'owner', repo: 'repo' });
    assert.deepEqual(data.ownerAvatar, good);
    assert.deepEqual(sizes, [4 * 1024 * 1024, 4 * 1024 * 1024]);
});

test('GitHub PNG decoding preserves grayscale alpha and transparent color keys', () => {
    assert.deepEqual([...decodeRasterImage(rawPng(4, [80, 32])).pixels], [80, 80, 80, 32]);
    assert.deepEqual([...decodeRasterImage(rawPng(0, [80], Buffer.from([0, 80]))).pixels], [80, 80, 80, 0]);
    assert.deepEqual([...decodeRasterImage(rawPng(2, [1, 2, 3], Buffer.from([0, 1, 0, 2, 0, 3]))).pixels], [1, 2, 3, 0]);
    assert.deepEqual([...decodeRasterImage(rawPng(2, [1, 2, 4], Buffer.from([0, 1, 0, 2, 0, 3]))).pixels], [1, 2, 4, 255]);
});
