'use strict';

// CI-only experiment. Ad-hoc signing here is not a Developer ID signature or
// notarization and is not a releasable distribution.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('hardened native launcher excludes injected loader state before main',
    { skip: process.platform !== 'darwin', timeout: 60000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-native-launch-'));
        t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-native-launch-/); await fs.rm(real, { recursive: true }); });
        const source = path.resolve(__dirname, '../../client/angelic-setup/mac/launch-native.c');
        const native = path.join(root, 'native'), control = path.join(root, 'control'), hardened = path.join(root, 'hardened'), restricted = path.join(root, 'restricted');
        await fs.mkdir(control); await fs.mkdir(hardened); await fs.mkdir(restricted);
        execFileSync('/usr/bin/clang', ['-O2', source, '-o', native], { timeout: 30000, stdio: 'pipe' });
        const probeSource = path.join(root, 'probe.c'), library = path.join(root, 'probe.dylib');
        await fs.writeFile(probeSource, '#include <stdlib.h>\n#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void probe(void){const char *p=getenv("CBTE_FIXTURE_MARKER");if(p){int f=open(p,O_WRONLY|O_CREAT|O_EXCL,0600);if(f>=0)close(f);}}\n');
        execFileSync('/usr/bin/clang', ['-dynamiclib', probeSource, '-o', library], { timeout: 30000, stdio: 'pipe' });
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', library], { timeout: 30000, stdio: 'pipe' });
        const section = path.join(root, 'restrict-section'); await fs.writeFile(section, Buffer.from([0]));
        execFileSync('/usr/bin/clang', ['-O2', source, '-Wl,-sectcreate,__RESTRICT,__restrict,' + section, '-o', path.join(restricted, 'Launch')], { timeout: 30000, stdio: 'pipe' });
        for (const directory of [control, hardened, restricted]) {
            if (directory !== restricted) await fs.copyFile(native, path.join(directory, 'Launch'));
            await fs.chmod(path.join(directory, 'Launch'), 0o700);
            await fs.writeFile(path.join(directory, 'MacNode'), '#!/bin/sh\n[ "${DYLD_INSERT_LIBRARIES+set}" != set ] || exit 7\n[ "$HOME" = "$EXPECTED_HOME" ] || exit 8\nprintf clean\n', { mode: 0o700 });
            await fs.writeFile(path.join(directory, 'MacSetup.cjs'), 'synthetic');
        }
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path.join(control, 'Launch')], { timeout: 30000, stdio: 'pipe' });
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', path.join(hardened, 'Launch')], { timeout: 30000, stdio: 'pipe' });
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', path.join(restricted, 'Launch')], { timeout: 30000, stdio: 'pipe' });
        const controlMarker = path.join(root, 'control-marker'), hardenedMarker = path.join(root, 'hardened-marker'), restrictedMarker = path.join(root, 'restricted-marker');
        const env = { HOME: root, EXPECTED_HOME: root, PATH: '/usr/bin:/bin', DYLD_INSERT_LIBRARIES: library, CBTE_FIXTURE_MARKER: controlMarker };
        const unprotected = spawnSync(path.join(control, 'Launch'), [], { env, timeout: 10000, encoding: 'utf8' });
        assert.equal(unprotected.status, 0, 'control launcher did not start');
        await fs.access(controlMarker); // Confirms the control really permitted injection.
        const protectedResult = spawnSync(path.join(hardened, 'Launch'), [], { env: { ...env, CBTE_FIXTURE_MARKER: hardenedMarker }, timeout: 10000, encoding: 'utf8' });
        const restrictedResult = spawnSync(path.join(restricted, 'Launch'), [], { env: { ...env, CBTE_FIXTURE_MARKER: restrictedMarker }, timeout: 10000, encoding: 'utf8' });
        const restrictedInjected = await fs.access(restrictedMarker).then(() => true, () => false);
        t.diagnostic(`restricted synthetic launcher status=${restrictedResult.status} injected=${restrictedInjected}`);
        assert.equal(protectedResult.status, 0, 'hardened launcher did not start'); assert.equal(protectedResult.stdout, 'clean');
        await assert.rejects(fs.access(hardenedMarker), { code: 'ENOENT' });
        const invalid = spawnSync(path.join(hardened, 'Launch'), [], { env: { ...env, DYLD_INSERT_LIBRARIES: '/nonexistent/synthetic' }, timeout: 10000, encoding: 'utf8' });
        assert.equal(invalid.status, 0, 'hardened launcher was affected by an invalid injection path'); assert.equal(invalid.stdout, 'clean');
    });
