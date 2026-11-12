'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { readVerifiedMacFirefoxScript } = require('../../src/automation/firefox-mac-reader-script');

test('verified Firefox script bytes reject tampering, unsafe paths and unsafe permissions',
    { skip: process.platform === 'win32', timeout: 10000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-firefox-script-fixture-'));
        t.after(async () => {
            const real = await fs.realpath(root);
            assert.equal(path.dirname(real), temp); assert.match(path.basename(real), /^cbte-firefox-script-fixture-/);
            await fs.rm(real, { recursive: true });
        });
        const filename = path.join(root, 'FirefoxXPCShellReader.js'), source = Buffer.from('synthetic script only\n');
        const digest = createHash('sha256').update(source).digest('hex');
        await fs.writeFile(filename, source, { mode: 0o600, flag: 'wx' });
        const args = { filename, kind: 'bootstrap', expectedSha256: digest };
        const verified = await readVerifiedMacFirefoxScript(args);
        await fs.writeFile(filename, 'changed after verification');
        assert.deepEqual(verified, source); verified.fill(0);
        await fs.writeFile(filename, source);
        const reader = path.join(root, 'Read-PushSubscription.js'); await fs.writeFile(reader, source, { mode: 0o600, flag: 'wx' });
        const readerBytes = await readVerifiedMacFirefoxScript({ filename: reader, kind: 'reader', expectedSha256: digest });
        assert.deepEqual(readerBytes, source); readerBytes.fill(0);
        const replacement = path.join(root, 'replacement'), original = path.join(root, 'original');
        await fs.writeFile(replacement, source, { mode: 0o600, flag: 'wx' });
        const realOpen = fs.open.bind(fs); let swapped = false;
        const hook = mock.method(fs, 'open', async (...parameters) => {
            const handle = await realOpen(...parameters), read = handle.read.bind(handle);
            handle.read = async (...readArgs) => {
                const result = await read(...readArgs);
                if (!swapped) { swapped = true; await fs.rename(filename, original); await fs.rename(replacement, filename); }
                return result;
            };
            return handle;
        });
        try { await assert.rejects(readVerifiedMacFirefoxScript(args), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' }); }
        finally { hook.mock.restore(); }
        await fs.unlink(filename); await fs.rename(original, filename);
        await assert.rejects(readVerifiedMacFirefoxScript({ ...args, expectedSha256: '0'.repeat(64) }), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
        await assert.rejects(readVerifiedMacFirefoxScript({ ...args, kind: 'reader' }), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
        await fs.chmod(filename, 0o622);
        await assert.rejects(readVerifiedMacFirefoxScript(args), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
        await fs.chmod(filename, 0o600);
        const hardlink = path.join(root, 'hardlink'); await fs.link(filename, hardlink);
        await assert.rejects(readVerifiedMacFirefoxScript(args), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
        await fs.unlink(hardlink);
        const linkedDirectory = path.join(root, 'linked'); await fs.symlink(root, linkedDirectory);
        await assert.rejects(readVerifiedMacFirefoxScript({ ...args, filename: path.join(linkedDirectory, path.basename(filename)) }),
            { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
        await fs.unlink(filename); await fs.writeFile(filename, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
        await assert.rejects(readVerifiedMacFirefoxScript(args), { code: 'X_FIREFOX_MAC_SCRIPT_INVALID' });
    });
