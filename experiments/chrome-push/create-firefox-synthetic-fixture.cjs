'use strict';
// Generate a local-only Firefox PushDB fixture. The copied Firefox runs
// offline, and the record and keys are newly generated synthetic values.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const { buildArchive } = require('../../scripts/build-angelic-setup-package.cjs');

async function main() {
    if (process.platform !== 'win32') throw new Error('FIXTURE_WINDOWS_REQUIRED');
    const root = path.join(await fs.realpath(os.tmpdir()), `x-export-native-fixture-${randomBytes(16).toString('hex')}`);
    await fs.mkdir(root); const bundle = path.join(root, 'bundle'), seed = path.join(root, 'seed'), owned = path.join(root, 'owned');
    await fs.mkdir(bundle); await fs.mkdir(seed);
    const built = await buildArchive();
    for (const [name, bytes] of Object.entries(unzipSync(built.archive))) {
        if (path.basename(name) !== name) throw new Error('FIXTURE_PACKAGE_INVALID');
        await fs.writeFile(path.join(bundle, name), bytes, { flag: 'wx' });
    }
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const prepare = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle, 'Setup-XNotifications.ps1'), '-Action', 'Prepare', '-PrivateRoot', owned],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (prepare.status !== 0) throw new Error('FIXTURE_PREPARE_FAILED');
    const profile = path.join(owned, 'firefox-profile'), uaid = '22222222-2222-4222-8222-222222222222';
    await fs.writeFile(path.join(profile, 'prefs.js'), `user_pref("dom.push.userAgentID", "${uaid}");\n`, { flag: 'wx' });
    const seeder = `async function ReadPushSubscription() {
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const publicKey=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
 const privateKey=await crypto.subtle.exportKey('jwk',pair.privateKey);
 const auth=crypto.getRandomValues(new Uint8Array(16));
 const db=await new Promise((resolve,reject)=>{const req=indexedDB.openForPrincipal(Services.scriptSecurityManager.getSystemPrincipal(),'pushapi',5);
  req.onupgradeneeded=()=>{const s=req.result.createObjectStore('pushapi',{keyPath:'channelID'});s.createIndex('identifiers',['scope','originAttributes'],{unique:true});};
  req.onerror=()=>reject(new Error('seed open failed'));req.onsuccess=()=>resolve(req.result);});
 await new Promise((resolve,reject)=>{const tx=db.transaction('pushapi','readwrite');tx.objectStore('pushapi').put({
  channelID:'11111111-1111-4111-8111-111111111111',scope:'https://x.com/',originAttributes:'',systemRecord:false,
  pushEndpoint:'https://updates.push.services.mozilla.com/wpush/v2/SYNTHETIC-ONLY',p256dhPublicKey:publicKey,
  p256dhPrivateKey:privateKey,authenticationSecret:auth});tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('seed write failed'));});
 db.close();return {ok:true}; }`;
    await fs.writeFile(path.join(seed, 'Read-PushSubscription.js'), seeder, { flag: 'wx' });
    const script = `
$ErrorActionPreference='Stop'
. $env:CBTE_BUNDLE_READER
function Assert-SafePath([string]$Path) { }
function Write-XSetupNewText([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false))) }
function ConvertTo-WindowsArgument([string]$Value) { if($Value.Contains('"')){throw 'fixture argument invalid'}; return '"'+$Value+'"' }
$script:PackageRoot=$env:CBTE_SEED_ROOT
$script:Utf8=New-Object Text.UTF8Encoding($false)
$application=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'application')
$result=[IO.Path]::Combine($env:CBTE_FIXTURE_ROOT,'result.json')
Copy-XSetupFirefoxApplication -Executable $env:CBTE_FIREFOX -Destination $application
Write-XSetupReaderConfiguration -Application $application -Profile $env:CBTE_PROFILE -ResultPath $result -Uaid '22222222-2222-4222-8222-222222222222'
$job=Start-XSetupReaderJob -Executable ([IO.Path]::Combine($application,'firefox.exe')) -Profile $env:CBTE_PROFILE
try { if(-not $job.WaitForExit(60000)){throw 'fixture timeout'}; $job.Stop() } finally {$job.Dispose()}
if(-not (ConvertFrom-Json ([IO.File]::ReadAllText($result))).ok){throw 'fixture seed failed'}
Write-Output 'synthetic-firefox-fixture-ready'
`;
    const browser = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 100000, env: { ...process.env, CBTE_BUNDLE_READER: path.join(bundle, 'FirefoxReader.ps1'),
            CBTE_SEED_ROOT: seed, CBTE_FIXTURE_ROOT: root, CBTE_PROFILE: profile, CBTE_FIREFOX: browser } });
    if (result.error || result.status !== 0 || !result.stdout.includes('synthetic-firefox-fixture-ready')) {
        if (process.env.FIXTURE_DIAGNOSTIC === '1') console.error(JSON.stringify({ status: result.status, code: result.error?.code || null,
            stderr: String(result.stderr || '').slice(-1500).replaceAll(root, '[fixture]') }));
        throw new Error('FIXTURE_SEED_FAILED');
    }
    console.log(JSON.stringify({ syntheticOnly: true, offline: true, browser, privateRoot: owned }));
}
main().catch(error => { console.error(/^FIXTURE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FIXTURE_FAILED'); process.exitCode = 1; });
