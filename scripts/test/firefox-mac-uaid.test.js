'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMacFirefoxProfile, createMacChromeProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease, releaseMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');
const { readMacFirefoxUaid } = require('../../src/automation/firefox-mac-uaid');

test('isolated Firefox identifier reader accepts only bounded, unambiguous owned prefs', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-mac-firefox-uaid-'));
    let lease, otherLease;
    t.after(async () => {
        if (otherLease) await releaseMacProfileLease(otherLease);
        if (lease) await releaseMacProfileLease(lease);
        const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-mac-firefox-uaid-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacFirefoxProfile(base), chrome = await createMacChromeProfile(base);
    lease = await acquireMacProfileLease({ ...profile, browser: 'firefox' });
    otherLease = await acquireMacProfileLease({ ...chrome, browser: 'chrome' });
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, lease };
    const filename = path.join(profile.profilePath, 'prefs.js'), id = '12345678-1234-1234-1234-123456789abc';
    const record = `user_pref("dom.push.userAgentID", "${id}");`;
    await fs.writeFile(filename, `// synthetic\n${record}\nuser_pref("example", true);\n`, { mode: 0o600 });
    assert.equal(await readMacFirefoxUaid(args), id);
    await fs.writeFile(filename, `${'x'.repeat(4095)}\r\n${record}\ruser_pref("example", true);`);
    assert.equal(await readMacFirefoxUaid(args), id);
    const activeRead = readMacFirefoxUaid(args);
    await assert.rejects(readMacFirefoxUaid(args), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    assert.equal(await activeRead, id);
    await fs.writeFile(filename, record);
    const realOpen = fs.open.bind(fs);
    const hook = mock.method(fs, 'open', async (name, ...openArgs) => {
        const handle = await realOpen(name, ...openArgs);
        if (name === filename) {
            const read = handle.read.bind(handle); let changed = false;
            handle.read = async (...readArgs) => {
                const result = await read(...readArgs);
                if (!changed) { changed = true; await fs.appendFile(filename, 'x'); }
                return result;
            };
        }
        return handle;
    });
    try { await assert.rejects(readMacFirefoxUaid(args), { code: 'X_FIREFOX_MAC_PREFS_INVALID' }); }
    finally { hook.mock.restore(); }
    await assert.rejects(readMacFirefoxUaid({ ...args, lease: otherLease }), { code: 'X_CHROME_MAC_LEASE_INVALID' });
    await assert.rejects(readMacFirefoxUaid({ ...args, profileId: chrome.profileId }), { code: 'X_CHROME_MAC_LEASE_INVALID' });
    const cases = [
        [`${record}\n${record}\n`, 'X_FIREFOX_MAC_UAID_INVALID'],
        ['user_pref("dom.push.userAgentID", "INVALID");\n', 'X_FIREFOX_MAC_UAID_INVALID'],
        ['// dom.push.userAgentID\n', 'X_FIREFOX_MAC_UAID_INVALID'],
        ['user_pref("unrelated", true);\n', 'X_FIREFOX_MAC_UAID_UNAVAILABLE'],
        ['x'.repeat(65537), 'X_FIREFOX_MAC_PREFS_INVALID'],
        [Buffer.from([0xc3, 0x28]), 'X_FIREFOX_MAC_PREFS_INVALID'],
        [Buffer.alloc(8 * 1024 * 1024 + 1), 'X_FIREFOX_MAC_PREFS_INVALID'],
    ];
    for (const [contents, code] of cases) {
        await fs.writeFile(filename, contents);
        await assert.rejects(readMacFirefoxUaid(args), { code });
    }
    await fs.unlink(filename);
    await fs.symlink(path.join(base, 'nonexistent'), filename);
    await assert.rejects(readMacFirefoxUaid(args), { code: 'X_FIREFOX_MAC_PREFS_INVALID' });
    await fs.unlink(filename);
    await fs.writeFile(filename, record);
    await fs.link(filename, path.join(base, 'hardlink'));
    await assert.rejects(readMacFirefoxUaid(args), { code: 'X_FIREFOX_MAC_PREFS_INVALID' });
});
