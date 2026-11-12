'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness(options = {}) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/firefox-mac-browser.js'), 'utf8');
    const app = '/Applications/Firefox.app', executable = `${app}/Contents/MacOS/firefox`, plist = `${app}/Contents/Info.plist`;
    const paths = new Set([app, executable, plist]), calls = [], counts = new Map();
    const fakeFs = {
        async lstat(name) {
            assert(paths.has(name)); const count = (counts.get(name) || 0) + 1; counts.set(name, count);
            return { dev: 1, ino: options.changed === name && count > 1 ? 99 : name.length,
                size: 10, mtimeMs: 12, ctimeMs: 13, isSymbolicLink: () => options.link === name,
                isDirectory: () => name === app, isFile: () => name !== app };
        },
        async realpath(name) { return options.redirect === name ? '/unexpected' : name; },
    };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:path') return path.posix;
        if (name === 'node:util') return { promisify: fn => (...args) => new Promise((resolve, reject) =>
            fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) };
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            calls.push({ file, args, opts });
            if (file === '/usr/bin/codesign') return callback(options.badSignature || options.badSecond && calls.length === 3 ? new Error('private') : null, '', '');
            assert.equal(file, '/usr/bin/plutil'); return callback(null, options.version ?? '160.0.1\n', '');
        } };
        return require(name);
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire,
        process: { platform: options.platform || 'darwin' } });
    return { verify: module.exports.verifyInstalledMacFirefox, calls, app, executable, plist };
}

test('Mac Firefox discovery verifies signed bundle and obtains only its version', async () => {
    const h = await harness(), result = await h.verify();
    assert.equal(result.executable, h.executable); assert.equal(result.version, '160.0.1');
    assert.deepEqual(h.calls.map(call => call.file), ['/usr/bin/codesign', '/usr/bin/plutil', '/usr/bin/codesign']);
    for (const call of h.calls.filter(call => call.file.endsWith('codesign'))) {
        assert(call.args.includes('--deep')); assert(call.args.includes('--strict'));
        assert(call.args.some(arg => arg.includes('org.mozilla.firefox') && arg.includes('43AQ936H96')));
        assert.equal(call.args.at(-1), h.app);
    }
    assert.equal(h.calls[1].args.at(-1), h.plist);
});

test('Mac Firefox discovery refuses bad signature, links, altered installations and malformed versions', async () => {
    for (const options of [
        { badSignature: true }, { badSecond: true }, { link: '/Applications/Firefox.app' },
        { redirect: '/Applications/Firefox.app/Contents/MacOS/firefox' },
        { changed: '/Applications/Firefox.app/Contents/Info.plist' },
        { version: '160.0\nextra' }, { version: '' }, { version: 'a'.repeat(65) },
    ]) {
        const h = await harness(options);
        await assert.rejects(h.verify(), { code: 'X_FIREFOX_MAC_BROWSER_INVALID' });
    }
    const unsupported = await harness({ platform: 'linux' });
    await assert.rejects(unsupported.verify(), { code: 'X_FIREFOX_MAC_BROWSER_UNSUPPORTED' });
    assert.equal(unsupported.calls.length, 0);
});
