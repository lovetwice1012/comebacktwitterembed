'use strict';

// CI-only preview inspection. It does not launch a browser, show dialogs,
// inspect existing profiles, or upload anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

test('unpacked macOS preview loads bundled runtime, application and LevelDB',
    { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
        assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-preview-hosted-'));
        t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-preview-hosted-/); await fs.rm(real, { recursive: true }); });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
        const app = path.join(root, 'X通知の準備.app', 'Contents'), bin = path.join(app, 'MacOS');
        for (const name of ['Launch', 'MacNode', 'MacStoreLock']) {
            const stat = await fs.lstat(path.join(bin, name));
            assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111), `${name} is not executable`);
        }
        // Load the real bundled entry without executing its UI, then create a
        // disposable database with the packaged addon and bundled runtime.
        const probe = `require(${JSON.stringify(path.join(bin, 'MacSetup.cjs'))});` +
            `const addon=require(${JSON.stringify(path.join(bin, 'MacLevelDB.node'))});` +
            `(async()=>{const db=addon.db_init();await addon.db_open(db,${JSON.stringify(path.join(root, 'synthetic-leveldb'))},` +
            `{createIfMissing:true});try{await addon.db_put(db,'fixture','value',{});}finally{await addon.db_close(db);}` +
            `process.stdout.write('preview-load-ok');})().catch(()=>{process.exitCode=1});`;
        const result = await exec(path.join(bin, 'MacNode'), ['-e', probe], { timeout: 30000, maxBuffer: 16384,
            env: { HOME: root, PATH: '/usr/bin:/bin' } });
        assert.equal(result.stdout, 'preview-load-ok');
    });
