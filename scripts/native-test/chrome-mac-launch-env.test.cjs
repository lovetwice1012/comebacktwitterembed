'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const { assembleMacApp } = require('../build-mac-chrome-preview.cjs');

test('Mac launcher removes unsafe inherited loader and runtime settings', { skip: process.platform === 'win32' }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-launch-env-'));
    t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-launch-env-/); await fs.rm(real, { recursive: true }); });
    const names = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE',
        'NODE_V8_COVERAGE', 'SSLKEYLOGFILE', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH', 'DYLD_VERSIONED_LIBRARY_PATH', 'DYLD_VERSIONED_FRAMEWORK_PATH',
        'DYLD_ROOT_PATH', 'DYLD_IMAGE_SUFFIX'];
    const checks = names.map(name => `[ "\${${name}+set}" != set ] || exit 7`).join('\n');
    const fakeRuntime = Buffer.from(`#!/bin/sh\nset -eu\n${checks}\n[ "$HOME" = "$EXPECTED_HOME" ] || exit 8\nprintf clean\n`);
    const zip = assembleMacApp({ bundle: { 'MacSetup.cjs': Buffer.from('synthetic') }, runtime: fakeRuntime, helper: Buffer.from('fixture'),
        license: Buffer.from('fixture'), projectLicense: Buffer.from('fixture'), guide: Buffer.from('fixture') });
    const files = unzipSync(zip), bin = path.join(root, 'app', 'Contents', 'MacOS'); await fs.mkdir(bin, { recursive: true });
    for (const name of ['Launch', 'MacNode', 'MacSetup.cjs']) {
        await fs.writeFile(path.join(bin, name), files[`X通知の準備.app/Contents/MacOS/${name}`], { mode: name === 'MacSetup.cjs' ? 0o600 : 0o700 });
    }
    for (const name of names) {
        const env = { HOME: root, EXPECTED_HOME: root, PATH: '/usr/bin:/bin', [name]: name === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : '/nonexistent/synthetic' };
        const result = spawnSync('/bin/sh', [path.join(bin, 'Launch')], { env, encoding: 'utf8', timeout: 10000 });
        if (result.status !== 0) t.diagnostic(`synthetic variable=${name} status=${result.status} signal=${result.signal || 'none'} error=${result.error?.code || 'none'}`);
        assert.equal(result.status, 0); assert.equal(result.stdout, 'clean');
    }
});
