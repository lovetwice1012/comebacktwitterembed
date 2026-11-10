'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMacChromeProfile, verifyMacChromeProfile, createMacEdgeProfile, verifyMacEdgeProfile } = require('../../src/automation/chrome-mac-profile');

test('dedicated Mac Chrome profile is private, marked and rejects tampering', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-profile-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-profile-test-/); await fs.rm(real, { recursive: true });
    });
    const normal = await createMacChromeProfile(base);
    assert.equal(path.dirname(normal.rootPath), base); assert.equal(path.dirname(normal.profilePath), normal.rootPath);
    assert.equal((await fs.stat(normal.rootPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(normal.profilePath)).mode & 0o777, 0o700);
    const marker = path.join(normal.rootPath, 'owner.json'); assert.equal((await fs.stat(marker)).mode & 0o777, 0o600);
    assert.deepEqual(await verifyMacChromeProfile(normal.rootPath, normal.profileId), normal);
    const markerText = await fs.readFile(marker, 'utf8');
    await fs.writeFile(marker, markerText.replace(normal.profileId, '00000000-0000-4000-8000-000000000000'));
    await assert.rejects(verifyMacChromeProfile(normal.rootPath, normal.profileId), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.writeFile(marker, markerText.replace(normal.profilePath, '/not-the-profile'));
    await assert.rejects(verifyMacChromeProfile(normal.rootPath, normal.profileId), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.writeFile(marker, markerText); await fs.chmod(marker, 0o644);
    await assert.rejects(verifyMacChromeProfile(normal.rootPath, normal.profileId), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.chmod(marker, 0o600); await fs.unlink(marker); await fs.symlink(path.join(base, 'missing'), marker);
    await assert.rejects(verifyMacChromeProfile(normal.rootPath, normal.profileId), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.chmod(base, 0o777);
    await assert.rejects(createMacChromeProfile(base), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await fs.chmod(base, 0o700);
});
test('Edge and Chrome setup profiles cannot be confused', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-edge-profile-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-edge-profile-test-/); await fs.rm(real, { recursive: true });
    });
    const chrome = await createMacChromeProfile(base), edge = await createMacEdgeProfile(base);
    assert.notEqual(chrome.rootPath, edge.rootPath); assert.equal(path.basename(edge.profilePath), 'edge-profile');
    assert.deepEqual(await verifyMacEdgeProfile(edge.rootPath, edge.profileId), edge);
    await assert.rejects(verifyMacChromeProfile(edge.rootPath, edge.profileId), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    await assert.rejects(verifyMacEdgeProfile(chrome.rootPath, chrome.profileId), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
});
