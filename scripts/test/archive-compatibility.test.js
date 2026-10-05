'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ZipArchive } = require('archiver');
const { unzipSync, strFromU8 } = require('fflate');

test('download ZIP API produces a readable archive after the archiver security upgrade', async () => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    const completed = new Promise((resolve, reject) => {
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', resolve);
    });
    archive.append('download fixture', { name: 'nested/example.txt' });
    await archive.finalize();
    await completed;
    const files = unzipSync(Buffer.concat(chunks));
    assert.deepEqual(Object.keys(files), ['nested/example.txt']);
    assert.equal(strFromU8(files['nested/example.txt']), 'download fixture');
});
