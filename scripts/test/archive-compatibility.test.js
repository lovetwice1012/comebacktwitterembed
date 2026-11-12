'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ZipArchive } = require('archiver');
const { unzipSync, strFromU8 } = require('fflate');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

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
test('directory glob still archives matching files and respects exclusions', async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-archive-glob-test-'));
    t.after(async () => {
        const real = await fs.realpath(root); assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(real), /^cbte-archive-glob-test-/); await fs.rm(real, { recursive: true });
    });
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'one.txt'), 'one'); await fs.writeFile(path.join(root, 'nested', 'two.txt'), 'two');
    await fs.writeFile(path.join(root, 'nested', 'skip.txt'), 'skip'); await fs.writeFile(path.join(root, 'nested', 'other.json'), '{}');
    const archive = new ZipArchive(), chunks = [];
    const done = new Promise((resolve, reject) => { archive.on('data', chunk => chunks.push(chunk)); archive.on('error', reject); archive.on('end', resolve); });
    archive.glob('**/*.txt', { cwd: root, ignore: ['**/skip.txt'] }); await archive.finalize(); await done;
    const files = unzipSync(Buffer.concat(chunks));
    assert.deepEqual(Object.keys(files).sort(), ['nested/two.txt', 'one.txt']);
    assert.equal(strFromU8(files['one.txt']), 'one'); assert.equal(strFromU8(files['nested/two.txt']), 'two');
});
