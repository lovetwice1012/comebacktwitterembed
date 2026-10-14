'use strict';

// Explicit opt-in integration test. Only an agent-created synthetic fixture
// below the disposable temp prefix is accepted; ordinary profiles are refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const { buildPackage, FILES } = require('../build-angelic-setup-package.cjs');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');

const firefox = process.env.X_SETUP_NATIVE_FIREFOX;
const sourceRoot = process.env.X_SETUP_NATIVE_PRIVATE_ROOT;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function assertSyntheticFixture() {
    assert.equal(process.platform, 'win32', 'This native integration requires Windows.');
    assert.ok(firefox && sourceRoot, 'Set explicit X_SETUP_NATIVE_FIREFOX and X_SETUP_NATIVE_PRIVATE_ROOT.');
    const relative = path.relative(os.tmpdir(), path.resolve(sourceRoot));
    assert.equal(path.isAbsolute(relative), false); assert.equal(relative.startsWith('..'), false);
    assert.match(relative.split(path.sep)[0], /^x-export-native-fixture-[0-9a-f]{32}$/);
}
async function originalHashes() {
    const result = {};
    for (const filename of ['prefs.js', 'parent.lock', 'storage/permanent/chrome/idb/2918063365piupsah.sqlite', 'storage/permanent/chrome/idb/2918063365piupsah.sqlite-wal', 'storage/permanent/chrome/idb/2918063365piupsah.sqlite-shm']) {
        try { result[filename] = digest(await fs.readFile(path.join(sourceRoot, 'firefox-profile', filename))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result;
}
const engines = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh.exe'];
function run(engine, script, args, env = process.env) {
    const result = spawnSync(engine, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env, encoding: 'utf8', timeout: 180000, windowsHide: true });
    if (result.error) throw result.error;
    return result;
}

test('native signed Firefox storage → local file, both engines, isolated environment and unchanged originals', { timeout: 420000 }, async t => {
    assertSyntheticFixture();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-x-export-native-check-'));
    t.after(async () => {
        assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.match(path.basename(directory), /^cbte-x-export-native-check-/);
        await fs.rm(directory, { recursive: true, force: true });
    });
    const built = await buildPackage({ output: path.join(directory, 'distribution.zip') });
    const bundle = path.join(directory, 'bundle'); await fs.mkdir(bundle);
    for (const [name, bytes] of Object.entries(unzipSync(await fs.readFile(built.path)))) await fs.writeFile(path.join(bundle, name), bytes);
    const core = path.join(bundle, 'Setup-XNotifications.ps1');
    const before = await originalHashes();
    assert.ok(before['prefs.js'] && before['storage/permanent/chrome/idb/2918063365piupsah.sqlite']);
    const foreign = path.join(directory, 'foreign-synthetic-profile'); await fs.mkdir(foreign);
    const sentinel = Buffer.from('Synthetic foreign profile: must not be opened or changed.');
    await fs.writeFile(path.join(foreign, 'prefs.js'), sentinel);
    const env = { ...process.env, XRE_PROFILE_PATH: foreign, XRE_PROFILE_LOCAL_PATH: foreign, XUL_APP_FILE: path.join(foreign, 'not-an-application.ini'), SELECTABLE_PROFILE_RESET_TEST: foreign };

    const aclScript = path.join(directory, 'inspect-file-acl.ps1');
    await fs.writeFile(aclScript, `param([string] $FilePath)
$ErrorActionPreference='Stop'
$file=New-Object IO.FileInfo($FilePath)
if($PSVersionTable.PSVersion.Major -le 5){$acl=$file.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)}else{$acl=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access)}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2){throw 'Output ACL is not private'}
foreach($rule in $rules){if($rule.IdentityReference.Value -notin @($owner,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Unexpected output grant'}}
'private-acl-pass'
`, 'utf8');

    for (const [index, engine] of engines.entries()) {
        await t.test(`PowerShell ${index === 0 ? '5.1' : '7'}: creates only a new, private local export and performs no upload`, async () => {
            const output = path.join(directory, `X通知引継ぎ-${index}.json`);
            const args = ['-Action', 'Export', '-PrivateRoot', sourceRoot, '-FirefoxPath', firefox, '-OutputPath', output];
            const preview = run(engine, core, [...args, '-WhatIf'], env);
            assert.equal(preview.status, 0, preview.stderr);
            await assert.rejects(fs.stat(output), { code: 'ENOENT' });
            const actual = run(engine, core, args, env);
            assert.equal(actual.status, 0, actual.stderr);
            const status = JSON.parse(actual.stdout);
            assert.equal(status.fileCreated, true); assert.equal(status.exportPath, output);
            assert.equal(status.capabilities.serverTransfer, false);
            const bytes = await fs.readFile(output), record = JSON.parse(bytes.toString('utf8'));
            assert.deepEqual(parseTransferFile(bytes.toString('utf8')), record, 'the exact native output is accepted by the web intake validator');
            assert.equal(record.format, 'x-notification-subscription'); assert.equal(record.version, 1);
            assert.equal(record.provenance.kind, 'firefox-pushdb'); assert.equal(record.push.scope, 'https://x.com/');
            assert.equal(Buffer.from(record.push.p256dhPublicKey, 'base64url').length, 65);
            assert.equal(Buffer.from(record.push.authenticationSecret, 'base64url').length, 16);
            assert.equal(Buffer.from(record.push.p256dhPrivateKey.d, 'base64url').length, 32);
            assert.equal(actual.stdout.includes(record.push.p256dhPrivateKey.d), false);
            assert.equal(actual.stdout.includes(record.push.uaid), false);
            const acl = run(engine, aclScript, [output]);
            assert.equal(acl.status, 0, acl.stderr); assert.match(acl.stdout, /private-acl-pass/);
            const again = run(engine, core, args, env);
            assert.notEqual(again.status, 0); assert.deepEqual(await fs.readFile(output), bytes);
            assert.deepEqual(await originalHashes(), before);
            assert.deepEqual(await fs.readFile(path.join(foreign, 'prefs.js')), sentinel);
            assert.deepEqual(await fs.readdir(foreign), ['prefs.js']);
            assert.equal((await fs.readdir(sourceRoot)).some(name => name.startsWith('export-scratch-')), false);
        });
    }

    await t.test('real Gecko mixed metadata permits only explicit consent and exports no foreign subscription values', async () => {
        // A fixture-only prelude adds a synthetic foreign record to the isolated
        // reader copy. It cannot run against the source profile. The production
        // reader below it is unchanged and still uses a readonly transaction.
        const source = path.join(directory, 'mixed-package-source'); await fs.mkdir(source);
        for (const name of FILES) await fs.copyFile(path.resolve(__dirname, '../../client/angelic-setup', name), path.join(source, name));
        await fs.appendFile(path.join(source, 'Read-PushSubscription.js'), `
const xSetupUnchangedProductionReader = ReadPushSubscription;
ReadPushSubscription = async function(input) {
 if (Services.dirsvc.get('ProfD', Ci.nsIFile).path !== input.expectedProfilePath ||
     !/[\\\\/]export-scratch-[0-9a-f]{32}[\\\\/]reader-profile$/i.test(input.expectedProfilePath) ||
     Services.io.offline !== true || Services.prefs.getBoolPref('dom.push.enabled', true) !== false) {
  return {ok:false,errorCode:'X_EXPORT_PROFILE_MISMATCH'};
 }
 await new Promise((resolve,reject)=>{
  const request=indexedDB.openForPrincipal(Services.scriptSecurityManager.getSystemPrincipal(),'pushapi',5);
  request.onupgradeneeded=()=>{request.transaction.abort();reject(new Error('Synthetic seed requires existing DB'));};
  request.onerror=()=>reject(new Error('Synthetic seed open failed'));
  request.onsuccess=()=>{
   const db=request.result;
   const tx=db.transaction('pushapi','readwrite');
   tx.objectStore('pushapi').add({channelID:'33333333-3333-4333-8333-333333333333',
    scope:'https://example.invalid/synthetic-worker/?lang=ja',originAttributes:'^userContextId=1',systemRecord:false,
    p256dhPrivateKey:'SYNTHETIC-FOREIGN-KEY-MUST-NOT-READ',p256dhPublicKey:'SYNTHETIC-FOREIGN-KEY-MUST-NOT-READ',
    authenticationSecret:'SYNTHETIC-FOREIGN-AUTH-MUST-NOT-READ'});
   tx.oncomplete=()=>{db.close();resolve();};
   tx.onabort=()=>{db.close();reject(new Error('Synthetic seed failed'));};
  };
 });
 return xSetupUnchangedProductionReader(input);
};
`, 'utf8');
        const mixedBuilt = await buildPackage({ source, output: path.join(directory, 'mixed-distribution.zip') });
        const mixedBundle = path.join(directory, 'mixed-bundle'); await fs.mkdir(mixedBundle);
        for (const [name, bytes] of Object.entries(unzipSync(await fs.readFile(mixedBuilt.path)))) await fs.writeFile(path.join(mixedBundle, name), bytes);
        for (const [index, engine] of engines.entries()) {
            const output = path.join(directory, `mixed-explicit-${index}.json`);
            const args = ['-Action', 'Export', '-PrivateRoot', sourceRoot, '-FirefoxPath', firefox, '-OutputPath', output];
            const refused = run(engine, path.join(mixedBundle, 'Setup-XNotifications.ps1'), args, env);
            assert.equal(refused.status, 5); assert.match(refused.stderr, /X_SETUP_OTHER_NOTIFICATIONS_CONSENT_REQUIRED/);
            assert.match(refused.stderr, /1 件/);
            await assert.rejects(fs.stat(output), { code: 'ENOENT' });
            assert.equal((await fs.readdir(sourceRoot)).some(name => name.startsWith('export-scratch-')), false);
            const accepted = run(engine, path.join(mixedBundle, 'Setup-XNotifications.ps1'), [...args, '-AllowOtherNotifications'], env);
            assert.equal(accepted.status, 0, accepted.stderr);
            const text = await fs.readFile(output, 'utf8');
            const data = parseTransferFile(text);
            assert.equal(data.push.scope, 'https://x.com/');
            for (const secret of ['SYNTHETIC-FOREIGN', 'example.invalid', '33333333-3333-4333-8333-333333333333', 'otherSubscriptionCount']) assert.equal(text.includes(secret), false);
            assert.deepEqual(await originalHashes(), before);
            assert.equal((await fs.readdir(sourceRoot)).some(name => name.startsWith('export-scratch-')), false);
        }
    });

    await t.test('both GUI process bridges create a Japanese-named file and return only a safe UTF-8 summary', async () => {
        const bridge = path.join(directory, 'gui-export-bridge.ps1');
        await fs.writeFile(bridge, `param([string] $GuiPath,[string] $OwnRoot,[string] $Browser,[string] $Destination)
$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. $GuiPath -PrivateRoot $OwnRoot -FirefoxPath $Browser
Assert-Distribution
$form=New-SetupForm -RootPath $OwnRoot
try {$result=Invoke-SetupAction -Action Export -OutputPath $Destination; $result|ConvertTo-Json -Depth 8} finally {$form.Dispose()}
`, 'utf8');
        for (const [index, engine] of engines.entries()) {
            const output = path.join(directory, `画面から作成した通知-${index}.json`);
            const result = run(engine, bridge, [path.join(bundle, 'Start-Setup.ps1'), sourceRoot, firefox, output], env);
            assert.equal(result.status, 0, result.stderr);
            const actual = JSON.parse(result.stdout);
            assert.equal(actual.Code, 0); assert.equal(actual.Data.fileCreated, true); assert.equal(actual.Data.exportPath, output);
            const text = await fs.readFile(output, 'utf8'), data = JSON.parse(text);
            assert.deepEqual(parseTransferFile(text), data, 'the GUI-created file uses the same accepted intake format');
            assert.equal(result.stdout.includes(data.push.p256dhPrivateKey.d), false);
        }
        assert.deepEqual(await originalHashes(), before);
        assert.equal((await fs.readdir(sourceRoot)).some(name => name.startsWith('export-scratch-')), false);
    });

    await t.test('cooperative cancellation creates no output and removes the isolated reader and scratch', async () => {
        const cancel = path.join(directory, 'cancel-now'); await fs.writeFile(cancel, 'cancel');
        const output = path.join(directory, 'cancelled-export.json');
        const result = run(engines[1], core, ['-Action', 'Export', '-PrivateRoot', sourceRoot, '-FirefoxPath', firefox, '-OutputPath', output, '-CancellationPath', cancel], env);
        assert.notEqual(result.status, 0); assert.match(result.stderr, /X_SETUP_EXPORT_CANCELLED/);
        await assert.rejects(fs.stat(output), { code: 'ENOENT' });
        assert.deepEqual(await originalHashes(), before);
        assert.equal((await fs.readdir(sourceRoot)).some(name => name.startsWith('export-scratch-')), false);
    });
});
