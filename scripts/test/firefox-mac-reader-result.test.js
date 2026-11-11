'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createECDH } = require('node:crypto');
const { createMacFirefoxProfile } = require('../../src/automation/chrome-mac-profile');
const { prepareMacFirefoxReaderResult, consumeMacFirefoxReaderResult, discardMacFirefoxReaderResult } = require('../../src/automation/firefox-mac-reader-result');

function syntheticFile() {
    const scalar = Buffer.alloc(32); scalar[31] = 1;
    const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(scalar); const point = ecdh.getPublicKey();
    return { format: 'x-notification-subscription', version: 1,
        provenance: { kind: 'firefox-pushdb', adapterVersion: '1.0.0', browserVersion: '160.0', readMethod: 'gecko-indexeddb-readonly' },
        push: { uaid: '22222222-2222-4222-8222-222222222222', channelID: '11111111-1111-4111-8111-111111111111',
            pushEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY', scope: 'https://x.com/', originAttributes: '',
            p256dhPublicKey: point.toString('base64url'), authenticationSecret: Buffer.alloc(16).toString('base64url'),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
                d: scalar.toString('base64url'), ext: true, key_ops: ['deriveBits'] } } };
}

test('Firefox reader result is private, one-shot, tied to the verified snapshot and strictly validated', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-firefox-result-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-firefox-result-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacFirefoxProfile(base), token = 'a'.repeat(32);
    const snapshotPath = path.join(profile.rootPath, `firefox-snapshot-${token}`);
    const output = path.join(profile.rootPath, `firefox-result-${token}.json`);
    await fs.mkdir(snapshotPath, { mode: 0o700 });
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, snapshotPath,
        expectedUaid: '22222222-2222-4222-8222-222222222222', expectedVersion: '160.0' };
    const record = { ok: true, export: syntheticFile(), otherSubscriptionCount: 2 };
    const make = value => fs.writeFile(output, value, { mode: 0o600 });
    let capability = await prepareMacFirefoxReaderResult(args);
    await make(JSON.stringify(record));
    const result = await consumeMacFirefoxReaderResult(capability);
    assert.equal(result.file.push.scope, 'https://x.com/'); assert.equal(result.otherSubscriptionCount, 2);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
    await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    capability = await prepareMacFirefoxReaderResult(args);
    assert.deepEqual(await discardMacFirefoxReaderResult(capability), { discarded: false });
    await assert.rejects(discardMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    capability = await prepareMacFirefoxReaderResult(args); await make('partial-synthetic-output');
    assert.deepEqual(await discardMacFirefoxReaderResult(capability), { discarded: true });
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
    capability = await prepareMacFirefoxReaderResult(args); await fs.symlink(path.join(base, 'missing'), output);
    await assert.rejects(discardMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_CLEANUP_FAILED' });
    assert((await fs.lstat(output)).isSymbolicLink()); await fs.unlink(output);
    capability = await prepareMacFirefoxReaderResult(args); await make('private-synthetic-result');
    await fs.rename(snapshotPath, `${snapshotPath}.old`); await fs.mkdir(snapshotPath, { mode: 0o700 });
    await assert.rejects(discardMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_CLEANUP_FAILED' });
    assert.equal(await fs.readFile(output, 'utf8'), 'private-synthetic-result');
    await fs.unlink(output); await fs.rmdir(snapshotPath); await fs.rename(`${snapshotPath}.old`, snapshotPath);
    capability = await prepareMacFirefoxReaderResult(args); await make(JSON.stringify(record));
    const raced = await Promise.allSettled([consumeMacFirefoxReaderResult(capability), discardMacFirefoxReaderResult(capability)]);
    assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(raced.filter(item => item.status === 'rejected' && item.reason.code === 'X_FIREFOX_MAC_RESULT_INVALID').length, 1);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
    await make('preexisting');
    await assert.rejects(prepareMacFirefoxReaderResult(args), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    assert.equal(await fs.readFile(output, 'utf8'), 'preexisting'); await fs.unlink(output);
    for (const text of ['{"ok":true,"ok":true}', JSON.stringify({ ...record, otherSubscriptionCount: 64 }),
        JSON.stringify({ ...record, extra: 'private' }), JSON.stringify({ ...record, export: { ...record.export, version: 3 } }),
        JSON.stringify({ ...record, export: { ...record.export, provenance: { ...record.export.provenance, browserVersion: '161.0' } } }),
        JSON.stringify({ ...record, export: { ...record.export, push: { ...record.export.push, uaid: '33333333-3333-4333-8333-333333333333' } } })]) {
        capability = await prepareMacFirefoxReaderResult(args); await make(text);
        await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
        await assert.rejects(fs.access(output), { code: 'ENOENT' });
    }
    capability = await prepareMacFirefoxReaderResult(args); await make(JSON.stringify(record)); await fs.chmod(output, 0o644);
    await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    assert.equal(await fs.readFile(output, 'utf8'), JSON.stringify(record)); await fs.unlink(output);
    capability = await prepareMacFirefoxReaderResult(args); await fs.symlink(path.join(base, 'missing'), output);
    await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    assert((await fs.lstat(output)).isSymbolicLink()); await fs.unlink(output);
    capability = await prepareMacFirefoxReaderResult(args); await make('x'.repeat(32769));
    await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    assert.equal((await fs.stat(output)).size, 32769); await fs.unlink(output);
    capability = await prepareMacFirefoxReaderResult(args); await make(JSON.stringify(record));
    await fs.link(output, path.join(base, 'hardlink'));
    await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_INVALID' });
    await fs.unlink(output); await fs.unlink(path.join(base, 'hardlink'));
    capability = await prepareMacFirefoxReaderResult(args); await make(JSON.stringify(record));
    const open = fs.open.bind(fs);
    const hook = mock.method(fs, 'open', async (name, ...options) => {
        const handle = await open(name, ...options);
        if (name === output) {
            const read = handle.read.bind(handle); let changed = false;
            handle.read = async (...readArgs) => {
                const value = await read(...readArgs);
                if (!changed) { changed = true; await fs.rename(output, `${output}.old`); await fs.writeFile(output, 'replacement'); }
                return value;
            };
        }
        return handle;
    });
    try { await assert.rejects(consumeMacFirefoxReaderResult(capability), { code: 'X_FIREFOX_MAC_RESULT_CLEANUP_FAILED' }); }
    finally { hook.mock.restore(); }
    assert.equal(await fs.readFile(output, 'utf8'), 'replacement');
});
