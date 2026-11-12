'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ensureMacSetupDirectory } = require('../../src/automation/chrome-mac-app');

test('Mac app reuses its dedicated profile and refuses unsafe setup directories', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-app-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-app-test-/); await fs.rm(real, { recursive: true });
    });
    const support = path.join(base, 'Application Support'); await fs.mkdir(support, { mode: 0o700 });
    const sourceFile = path.join(__dirname, '../../src/automation/chrome-mac-app.js');
    const source = await fs.readFile(sourceFile, 'utf8'), module = { exports: {} }, sessions = [];
    const mockedRequire = name => {
        if (name === './chrome-mac-setup-session') return { runMacChromeSetup: async options => { sessions.push(options); return { state: 'cancelled' }; } };
        if (name.startsWith('./')) return require(path.join(path.dirname(sourceFile), name));
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire,
        process: { platform: 'darwin', getuid: () => process.getuid() } });
    const args = { applicationSupport: support, helperPath: '/tmp/example-helper', expectedSha256: 'a'.repeat(64), ui: {} };
    assert.equal((await module.exports.runMacChromeApp(args)).state, 'cancelled');
    assert.equal((await module.exports.runMacChromeApp(args)).state, 'cancelled');
    assert.equal(sessions.length, 2); assert.equal(sessions[0].rootPath, sessions[1].rootPath);
    assert.equal(sessions[0].profileId, sessions[1].profileId);
    const data = path.join(support, 'XNotificationSetup'); assert.equal((await fs.stat(data)).mode & 0o777, 0o700);
    await fs.chmod(data, 0o755);
    await assert.rejects(ensureMacSetupDirectory(support), { code: 'X_CHROME_MAC_APP_INVALID' });
    await fs.chmod(data, 0o700);
    await fs.chmod(support, 0o777);
    await assert.rejects(ensureMacSetupDirectory(support), { code: 'X_CHROME_MAC_APP_INVALID' });
    await fs.chmod(support, 0o700);
    const symlink = path.join(base, 'link'); await fs.symlink(support, symlink);
    await assert.rejects(ensureMacSetupDirectory(symlink), { code: 'X_CHROME_MAC_APP_INVALID' });
});
