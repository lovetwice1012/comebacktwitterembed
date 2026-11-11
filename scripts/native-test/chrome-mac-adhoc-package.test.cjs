'use strict';

// Disposable CI experiment only. Ad-hoc signatures are not Developer ID,
// notarization, publisher identity, or authorization to distribute.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

test('ad-hoc hardened Mac preview can load its native database',
    { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
        assert.ok(path.isAbsolute(process.env.MAC_PREVIEW_ZIP || ''), 'missing synthetic preview');
        const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-adhoc-package-'));
        t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-adhoc-package-/); await fs.rm(real, { recursive: true }); });
        await exec('/usr/bin/ditto', ['-x', '-k', process.env.MAC_PREVIEW_ZIP, root], { timeout: 30000 });
        const app = path.join(root, 'X通知の準備.app'), bin = path.join(app, 'Contents', 'MacOS');
        const entitlements = path.join(root, 'node-entitlements.plist');
        await fs.writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
        const sign = async (name, options = []) => exec('/usr/bin/codesign', ['--force', '--sign', '-', ...options, name], { timeout: 30000 });
        await sign(path.join(bin, 'MacLevelDB.node'));
        await sign(path.join(bin, 'MacNode'), ['--options', 'runtime', '--entitlements', entitlements]);
        await sign(path.join(bin, 'MacStoreLock'), ['--options', 'runtime']);
        await sign(app, ['--options', 'runtime']);
        await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 30000 });
        const probe = `require(${JSON.stringify(path.join(app, 'Contents', 'Resources', 'MacSetup.cjs'))});` +
            `const addon=require(${JSON.stringify(path.join(bin, 'MacLevelDB.node'))});` +
            `(async()=>{const db=addon.db_init();await addon.db_open(db,${JSON.stringify(path.join(root, 'synthetic-db'))},{createIfMissing:true});` +
            `try{await addon.db_put(db,'fixture','value',{});}finally{await addon.db_close(db);}process.stdout.write('signed-preview-ok');})().catch(()=>{process.exitCode=1});`;
        const result = await exec(path.join(bin, 'MacNode'), ['-e', probe], { timeout: 30000, maxBuffer: 16384, env: { HOME: root, PATH: '/usr/bin:/bin' } });
        assert.equal(result.stdout, 'signed-preview-ok');
    });
