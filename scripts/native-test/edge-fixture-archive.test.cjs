'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildArchive } = require('../build-edge-setup-package.cjs');
const { readPinnedHostedArchive, NAME, SHA256, SIZE } = require('../../experiments/chrome-push/edge-fixture-archive.cjs');

test('hosted Edge fixture accepts only the exact built preview and rejects replacement',
    { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
        const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-edge-pinned-test-'));
        const keys = ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'NODE_ENV', 'RUNNER_TEMP'];
        const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        t.after(async () => {
            for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
            const actual = await fs.realpath(root);
            assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
            assert.match(path.basename(actual), /^cbte-edge-pinned-test-/);
            await fs.rm(actual, { recursive: true });
        });
        const built = await buildArchive({ nodeExecutable: process.execPath });
        assert.equal(built.version, '0.1.0-edge-preview.16'); assert.equal(built.sha256, SHA256); assert.equal(built.archive.length, SIZE);
        process.env.GITHUB_ACTIONS = 'true'; process.env.RUNNER_ENVIRONMENT = 'github-hosted'; process.env.NODE_ENV = 'test'; process.env.RUNNER_TEMP = root;
        const target = path.join(root, NAME); await fs.writeFile(target, built.archive, { flag: 'wx' });
        const accepted = await readPinnedHostedArchive(); assert(accepted.equals(built.archive));
        const handle = await fs.open(target, 'r+');
        try { const byte = Buffer.from([built.archive[0] ^ 1]); await handle.write(byte, 0, 1, 0); }
        finally { await handle.close(); }
        await assert.rejects(readPinnedHostedArchive(), { message: 'PROBE_PACKAGE_INVALID' });
        process.env.GITHUB_ACTIONS = 'false';
        await assert.rejects(readPinnedHostedArchive(), { message: 'PROBE_PACKAGE_HOST_INVALID' });
    });
