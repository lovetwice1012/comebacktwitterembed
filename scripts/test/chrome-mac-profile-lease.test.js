'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMacEdgeProfile, createMacChromeProfile, createMacBraveProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');

test('profile lease retains exclusive ownership across multiple operations', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-lease-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-lease-test-/); await fs.rm(real, { recursive: true });
    });
    const edge = await createMacEdgeProfile(base), chrome = await createMacChromeProfile(base);
    const args = { rootPath: edge.rootPath, profileId: edge.profileId, browser: 'edge' };
    const lease = await acquireMacProfileLease(args);
    await assert.rejects(acquireMacProfileLease(args), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    assert.throws(() => beginMacProfileLease({}, args), { code: 'X_CHROME_MAC_LEASE_INVALID' });
    assert.throws(() => beginMacProfileLease(lease, { rootPath: chrome.rootPath, profileId: chrome.profileId, browser: 'chrome' }), { code: 'X_CHROME_MAC_LEASE_INVALID' });
    const first = beginMacProfileLease(lease, args); assert.equal(first.profile.profilePath, edge.profilePath);
    assert.throws(() => beginMacProfileLease(lease, args), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    await assert.rejects(releaseMacProfileLease(lease), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    first.end(); first.end();
    const second = beginMacProfileLease(lease, args); second.end();
    await assert.rejects(acquireMacProfileLease(args), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    await releaseMacProfileLease(lease); await releaseMacProfileLease(lease);
    assert.throws(() => beginMacProfileLease(lease, args), { code: 'X_CHROME_MAC_LEASE_INVALID' });
    const next = await acquireMacProfileLease(args); await releaseMacProfileLease(next);
    const brave = await createMacBraveProfile(base), braveArgs = { rootPath: brave.rootPath, profileId: brave.profileId, browser: 'brave' };
    const braveLease = await acquireMacProfileLease(braveArgs);
    await assert.rejects(acquireMacProfileLease(braveArgs), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    assert.throws(() => beginMacProfileLease(braveLease, args), { code: 'X_CHROME_MAC_LEASE_INVALID' });
    const braveOperation = beginMacProfileLease(braveLease, braveArgs); assert.equal(braveOperation.profile.profilePath, brave.profilePath);
    braveOperation.end(); await releaseMacProfileLease(braveLease);
});
