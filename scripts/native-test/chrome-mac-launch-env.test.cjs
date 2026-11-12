'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const exec = promisify(execFile);

test('packaged Mac launcher removes unsafe inherited loader and runtime settings', { skip: process.platform !== 'darwin' }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-launch-env-'));
    t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
        assert.match(path.basename(real), /^cbte-launch-env-/); await fs.rm(real, { recursive: true }); });
    const names = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE',
        'NODE_V8_COVERAGE', 'SSLKEYLOGFILE', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH', 'DYLD_VERSIONED_LIBRARY_PATH', 'DYLD_VERSIONED_FRAMEWORK_PATH',
        'DYLD_ROOT_PATH', 'DYLD_IMAGE_SUFFIX'];
    const checks = names.map(name => `[ "\${${name}+set}" != set ] || exit 7`).join('\n');
    const fakeRuntime = Buffer.from(`#!/bin/sh\nset -eu\n${checks}\n[ "$HOME" = "$EXPECTED_HOME" ] || exit 8\nprintf clean\n`);
    assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
    await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
    const bin = path.join(root, 'X通知の準備.app', 'Contents', 'MacOS');
    await fs.writeFile(path.join(bin, 'MacNode'), fakeRuntime, { mode: 0o700 }); await fs.chmod(path.join(bin, 'MacNode'), 0o700);
    for (const name of names) {
        const env = { HOME: root, EXPECTED_HOME: root, PATH: '/usr/bin:/bin', [name]: name === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : '/nonexistent/synthetic' };
        const result = spawnSync(path.join(bin, 'Launch'), [], { env, encoding: 'utf8', timeout: 10000 });
        if (result.status !== 0) t.diagnostic(`synthetic variable=${name} status=${result.status} signal=${result.signal || 'none'} error=${result.error?.code || 'none'}`);
        assert.equal(result.status, 0); assert.equal(result.stdout, 'clean');
    }
    const probeSource = path.join(root, 'probe.c'), library = path.join(root, 'probe.dylib'), marker = path.join(root, 'injected');
    await fs.writeFile(probeSource, '#include <stdlib.h>\n#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void probe(void){const char *p=getenv("CBTE_FIXTURE_MARKER");if(p){int f=open(p,O_WRONLY|O_CREAT|O_EXCL,0600);if(f>=0)close(f);}}\n');
    await exec('/usr/bin/clang', ['-dynamiclib', probeSource, '-o', library], { timeout: 30000 });
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', library], { timeout: 30000 });
    const injection = spawnSync(path.join(bin, 'Launch'), [], { env: { HOME: root, EXPECTED_HOME: root, PATH: '/usr/bin:/bin',
        DYLD_INSERT_LIBRARIES: library, CBTE_FIXTURE_MARKER: marker }, timeout: 10000, encoding: 'utf8' });
    assert.equal(injection.status, 0); assert.equal(injection.stdout, 'clean');
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});
