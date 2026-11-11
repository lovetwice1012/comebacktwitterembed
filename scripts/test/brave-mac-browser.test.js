'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness(options = {}) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/brave-mac-browser.js'), 'utf8');
    const app = '/Applications/Brave Browser.app', executable = `${app}/Contents/MacOS/Brave Browser`;
    let calls = 0, argumentsSeen;
    const fakeFs = { async lstat(name) {
        assert([app, executable].includes(name)); calls++;
        return { dev: 1, ino: options.changed && calls > 2 ? 99 : name.length, size: 20, mtimeMs: 1, ctimeMs: 2,
            isSymbolicLink: () => options.link === name, isDirectory: () => name === app, isFile: () => name === executable };
    }, async realpath(name) { return options.redirect === name ? '/other' : name; } };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:path') return path.posix;
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            argumentsSeen = { file, args, opts }; callback(options.badSignature ? new Error('private') : null, '', '');
        } };
        return require(name);
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, process: { platform: options.platform || 'darwin' } });
    return { verify: module.exports.verifyInstalledMacBrave, getArguments: () => argumentsSeen, app, executable };
}
test('Mac Brave discovery checks the expected Apple signature and executable', async () => {
    const h = await harness(); assert.equal(await h.verify(), h.executable);
    const call = h.getArguments(); assert.equal(call.file, '/usr/bin/codesign');
    assert(call.args.includes('--strict')); assert(call.args.includes('--deep'));
    assert(call.args.some(arg => arg.includes('com.brave.Browser') && arg.includes('KL8N8XSYF4')));
    assert.equal(call.args.at(-1), h.app);
});
test('Mac Brave discovery rejects signatures, links, replacements and unsupported OS', async () => {
    for (const options of [{ badSignature: true }, { changed: true }, { link: '/Applications/Brave Browser.app' },
        { redirect: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' }]) {
        const h = await harness(options); await assert.rejects(h.verify(), { code: 'X_BRAVE_MAC_BROWSER_INVALID' });
    }
    const h = await harness({ platform: 'linux' });
    await assert.rejects(h.verify(), { code: 'X_BRAVE_MAC_BROWSER_UNSUPPORTED' });
    assert.equal(h.getArguments(), undefined);
});
