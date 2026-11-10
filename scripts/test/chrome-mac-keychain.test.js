'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function harness(mode) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/chrome-mac-keychain.js'), 'utf8');
    const module = { exports: {} }; let calls = 0, argumentsSeen, killed = false;
    const mockedRequire = name => name === 'node:child_process' ? { spawn(file, args, opts) {
        calls++; argumentsSeen = { file, args, opts };
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { killed = true; };
        if (mode !== 'hang') queueMicrotask(() => {
            if (mode === 'good') child.stdout.write(Buffer.from('synthetic-secret\n'));
            if (mode === 'bad') child.stdout.write(Buffer.from('secret\nwith-newline\n'));
            if (mode === 'large') child.stdout.write(Buffer.alloc(5000, 65));
            child.stdout.end(); child.emit('close', mode === 'denied' ? 1 : 0);
        });
        return child;
    } } : require(name);
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire, Buffer, AbortSignal, setTimeout, clearTimeout,
        process: { platform: 'darwin' } });
    return { invoke: module.exports.withMacChromeKeychainPassword, calls: () => calls, args: () => argumentsSeen, killed: () => killed };
}
test('keychain access requires consent, reads only the fixed item and clears the supplied buffer', async () => {
    const h = await harness('good'); let borrowed;
    await assert.rejects(h.invoke({ confirmed: false, work: async () => {} }), { code: 'X_CHROME_MAC_KEYCHAIN_INVALID' });
    assert.equal(h.calls(), 0);
    const result = await h.invoke({ confirmed: true, work: async password => { borrowed = password; assert.equal(password.toString(), 'synthetic-secret'); return 'done'; } });
    assert.equal(result, 'done'); assert(borrowed.every(byte => byte === 0));
    assert.equal(h.args().file, '/usr/bin/security');
    assert.deepEqual(Array.from(h.args().args), ['find-generic-password', '-s', 'Chrome Safe Storage', '-a', 'Chrome', '-w']);
    assert.deepEqual(Array.from(h.args().opts.stdio), ['ignore', 'pipe', 'ignore']);
    await assert.rejects(h.invoke({ confirmed: true, work: async password => { borrowed = password; throw new Error('synthetic failure'); } }), /synthetic failure/);
    assert(borrowed.every(byte => byte === 0));
});
test('keychain denial, malformed data, oversized data and cancellation fail without exposing secrets', async () => {
    for (const [mode, code] of [['denied', 'X_CHROME_MAC_KEYCHAIN_UNAVAILABLE'], ['bad', 'X_CHROME_MAC_KEYCHAIN_INVALID'], ['large', 'X_CHROME_MAC_KEYCHAIN_INVALID']]) {
        const h = await harness(mode);
        await assert.rejects(h.invoke({ confirmed: true, work: async () => { throw new Error('unexpected'); } }), error => error.code === code && !error.message.includes('secret'));
    }
    const h = await harness('hang'), controller = new AbortController();
    const pending = h.invoke({ confirmed: true, signal: controller.signal, work: async () => {} });
    controller.abort(); await assert.rejects(pending, { code: 'X_CHROME_MAC_KEYCHAIN_CANCELLED' }); assert.equal(h.killed(), true);
});
