'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function harness(options = {}) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/edge-mac-browser-version.js'), 'utf8');
    const app = '/Applications/Microsoft Edge.app', executable = `${app}/Contents/MacOS/Microsoft Edge`, plist = `${app}/Contents/Info.plist`;
    let signatures = 0, stats = 0, command;
    const fakeFs = { async lstat(name) {
        assert.equal(name, plist); stats++;
        return { dev: 1, ino: options.changed && stats > 1 ? 99 : 10, size: 20, mtimeMs: 1, ctimeMs: 2,
            isSymbolicLink: () => options.link === true, isFile: () => true };
    }, async realpath(name) { return options.redirect ? '/other' : name; } };
    const mockedRequire = name => {
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:path') return path.posix;
        if (name === 'node:util') return { promisify: fn => (...args) => new Promise((resolve, reject) =>
            fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) };
        if (name === 'node:child_process') return { execFile(file, args, opts, callback) {
            command = { file, args, opts }; callback(options.commandFails ? new Error('private') : null, options.version ?? '157.0.0.1\n', '');
        } };
        if (name === './edge-mac-broker') return { verifyInstalledEdge: async () => {
            signatures++; if (options.badSignature || options.badSecond && signatures === 2) throw new Error('private');
            return options.wrongExecutable ? '/other' : executable;
        } };
        return require(name);
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, Object });
    return { read: module.exports.readVerifiedMacEdgeVersion, signatures: () => signatures, command: () => command, executable, plist };
}
test('Mac Edge version comes from the twice-verified signed bundle', async () => {
    const h = await harness(), result = await h.read();
    assert.equal(result.executable, h.executable); assert.equal(result.browserVersion, '157.0.0.1'); assert.equal(h.signatures(), 2);
    assert.equal(h.command().file, '/usr/bin/plutil'); assert.equal(h.command().args.at(-1), h.plist);
});
test('Mac Edge version rejects signature errors, replacements, symlinks and malformed output', async () => {
    for (const options of [{ badSignature: true }, { badSecond: true }, { wrongExecutable: true }, { changed: true }, { link: true },
        { redirect: true }, { commandFails: true }, { version: '157.0.0' }, { version: '157.0.0.1\nother' }]) {
        const h = await harness(options); await assert.rejects(h.read(), { code: 'X_EDGE_MAC_BROWSER_INVALID' });
    }
});
