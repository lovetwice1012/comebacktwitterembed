'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness(options = {}) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/brave-mac-browser.js'), 'utf8');
    const app = '/Applications/Brave Browser.app', executable = `${app}/Contents/MacOS/Brave Browser`, plist = `${app}/Contents/Info.plist`;
    let calls = 0; const argumentsSeen = [];
    const fakeFs = { async lstat(name) {
        assert([app, executable, plist].includes(name)); calls++;
        return { dev: 1, ino: options.changed && calls > 3 ? 99 : name.length, size: 20, mtimeMs: 1, ctimeMs: 2,
            isSymbolicLink: () => options.link === name, isDirectory: () => name === app, isFile: () => name !== app };
    }, async realpath(name) { return options.redirect === name ? '/other' : name; } };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:path') return path.posix;
        if (name === 'node:util') return { promisify: fn => (...args) => new Promise((resolve, reject) =>
            fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) };
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            argumentsSeen.push({ file, args, opts });
            if (file === '/usr/bin/codesign') return callback(options.badSignature || options.badSecond && argumentsSeen.length === 3 ? new Error('private') : null, '', '');
            assert.equal(file, '/usr/bin/plutil'); return callback(null, options.version ?? '157.1.99.55\n', '');
        } };
        return require(name);
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, process: { platform: options.platform || 'darwin' } });
    return { verify: module.exports.verifyInstalledMacBrave, argumentsSeen, app, executable, plist };
}
test('Mac Brave discovery checks the expected Apple signature and executable', async () => {
    const h = await harness(), result = await h.verify(); assert.equal(result.executable, h.executable); assert.equal(result.browserVersion, '157.1.99.55');
    assert.deepEqual(h.argumentsSeen.map(call => call.file), ['/usr/bin/codesign', '/usr/bin/plutil', '/usr/bin/codesign']);
    const call = h.argumentsSeen[0];
    assert(call.args.includes('--strict')); assert(call.args.includes('--deep'));
    assert(call.args.some(arg => arg.includes('com.brave.Browser') && arg.includes('KL8N8XSYF4')));
    assert.equal(call.args.at(-1), h.app);
    assert.equal(h.argumentsSeen[1].args.at(-1), h.plist);
});
test('Mac Brave discovery rejects signatures, links, replacements and unsupported OS', async () => {
    for (const options of [{ badSignature: true }, { badSecond: true }, { changed: true }, { link: '/Applications/Brave Browser.app' },
        { redirect: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' }, { version: '157.1.99' }, { version: '157.1.99.55\nextra' }]) {
        const h = await harness(options); await assert.rejects(h.verify(), { code: 'X_BRAVE_MAC_BROWSER_INVALID' });
    }
    const h = await harness({ platform: 'linux' });
    await assert.rejects(h.verify(), { code: 'X_BRAVE_MAC_BROWSER_UNSUPPORTED' });
    assert.equal(h.argumentsSeen.length, 0);
});
