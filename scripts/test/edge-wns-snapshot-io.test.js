'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createECDH, generateKeyPairSync, randomBytes } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { spawnSync } = require('node:child_process');
const { readEdgeSnapshot, inspectEdgeSnapshot } = require('../../src/automation/edge-wns-snapshot-io');
function varint(number) { const out = []; do { let byte = number % 128; number = Math.floor(number / 128); if (number) byte |= 128; out.push(byte); } while (number); return Buffer.from(out); }
function field(number, value) { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]); }
function site(scope) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), app = createECDH('prime256v1'); app.generateKeys();
    const jwk = keys.publicKey.export({ format: 'jwk' });
    const expected = { endpoint: 'https://wns2-pn1p.notify.windows.com/?token=synthetic', publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]),
        auth: randomBytes(16), applicationServerKey: app.getPublicKey() };
    return { expected, record: Buffer.concat([field(1, 'synthetic-channel'), field(3, expected.endpoint), field(6, expected.auth),
        field(7, keys.privateKey.export({ format: 'der', type: 'pkcs8' })), field(8, Buffer.concat([field(1, 'origin'), field(2, scope)])), field(16, expected.applicationServerKey)]) };
}
const dbFactory = directory => new ClassicLevel(directory, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' });
async function setup(t) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-edge-snapshot-test-'));
    t.after(async () => { const checked = await fs.realpath(root); assert.equal(path.dirname(checked).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(checked), /^cbte-edge-snapshot-test-/); await fs.rm(checked, { recursive: true }); });
    const token = randomBytes(16).toString('hex'), snapshotPath = path.join(root, `edge-snapshot-${token}`);
    const directory = path.join(snapshotPath, 'Default', 'EdgePushStorageWithConnectTokenAndKey'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(snapshotPath, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-snapshot-v1', token }));
    const target = site('https://x.com/'), other = site('https://other.example/');
    const db = new ClassicLevel(directory, { keyEncoding: 'buffer', valueEncoding: 'buffer' }); await db.open();
    await db.put(Buffer.from('device'), Buffer.concat([field(2, 'synthetic-token'), field(3, randomBytes(32).toString('base64'))]));
    await db.put(Buffer.from('target'), target.record); await db.put(Buffer.from('other'), other.record); await db.put(Buffer.from('unknown'), Buffer.alloc(8)); await db.close();
    const options = { snapshotPath, token, expected: target.expected, browserVersion: '157.0.0.1',
        agent: { os: 'Windows', osVersion: '1', architecture: 'x64', locale: 'en' },
        client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' }, dbFactory };
    return { options, directory };
}
test('reads a marked snapshot and reports foreign and uncertain records', async t => {
    const { options } = await setup(t), result = await readEdgeSnapshot(options);
    assert.equal(result.file.version, 3); assert.equal(result.otherSubscriptionCount, 1); assert.equal(result.unclassifiedRecordCount, 1);
    assert.equal(result.otherNotificationsPossible, true); assert(!JSON.stringify(result).includes('other.example'));
    assert.deepEqual(await inspectEdgeSnapshot(options), { hasXSubscription: true });
});
test('rejects an invalid marker or unexpected store files before opening LevelDB', async t => {
    const { options, directory } = await setup(t); let opens = 0;
    const guarded = { ...options, dbFactory: dir => { opens++; return dbFactory(dir); } };
    await assert.rejects(readEdgeSnapshot({ ...guarded, token: 'a'.repeat(32) }), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' });
    await fs.writeFile(path.join(directory, 'not-a-leveldb-file'), 'test');
    await assert.rejects(readEdgeSnapshot(guarded), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' }); assert.equal(opens, 0);
});
test('refuses a truncated enumeration and closes the database', async t => {
    const { options } = await setup(t); let closed = false; const borrowed = [];
    const fake = { async open() {}, async *iterator() { for (let i = 0; i < 129; i++) { const value = Buffer.from('v'); borrowed.push(value); yield [Buffer.from('k'), value]; } }, async close() { closed = true; } };
    await assert.rejects(readEdgeSnapshot({ ...options, dbFactory: () => fake }), { code: 'X_EDGE_WNS_SNAPSHOT_INVALID' }); assert.equal(closed, true);
    assert(borrowed.every(value => value.every(byte => byte === 0)));
});
test('local reader returns selected X settings and safe errors over standard streams', async t => {
    const { options } = await setup(t), reader = path.resolve(__dirname, '../edge-setup-reader.cjs');
    const { dbFactory: _factory, ...plain } = options;
    const input = { ...plain, expected: { endpoint: plain.expected.endpoint, publicKey: plain.expected.publicKey.toString('base64url'),
        auth: plain.expected.auth.toString('base64url'), applicationServerKey: plain.expected.applicationServerKey.toString('base64url') } };
    const run = value => spawnSync(process.execPath, [reader], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const result = run(JSON.stringify(input)); assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout); assert.equal(parsed.ok, true); assert.equal(parsed.file.version, 3);
    assert.equal(parsed.otherSubscriptionCount, 1); assert.equal(parsed.otherNotificationsPossible, true);
    assert(!result.stdout.includes('other.example')); assert.equal(result.stderr, '');
    const bad = run(JSON.stringify({ ...input, expected: { ...input.expected, auth: 'private-sentinel' } }));
    assert.notEqual(bad.status, 0); assert.deepEqual(JSON.parse(bad.stdout), { ok: false, errorCode: 'X_EDGE_READER_INPUT_INVALID' });
    assert(!bad.stdout.includes('private-sentinel')); assert.equal(bad.stderr, '');
    const presence = run(JSON.stringify({ mode: 'inspect', snapshotPath: input.snapshotPath, token: input.token }));
    assert.equal(presence.status, 0, presence.stderr); assert.deepEqual(JSON.parse(presence.stdout), { ok: true, hasXSubscription: true });
});
test('bundled Edge reader works without a locally installed dependency', { skip: process.platform !== 'win32' }, async t => {
    const { options } = await setup(t), root = path.dirname(options.snapshotPath);
    const bundles = await require('../build-chrome-setup-bundles.cjs').buildChromeBundles({ includeEdge: true });
    await fs.writeFile(path.join(root, 'EdgeReader.cjs'), bundles['EdgeReader.cjs']);
    await fs.writeFile(path.join(root, 'ChromeLevelDB.node'), bundles['ChromeLevelDB.node']);
    const { dbFactory: _factory, ...plain } = options;
    const input = { ...plain, expected: { endpoint: plain.expected.endpoint, publicKey: plain.expected.publicKey.toString('base64url'),
        auth: plain.expected.auth.toString('base64url'), applicationServerKey: plain.expected.applicationServerKey.toString('base64url') } };
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, [path.join(root, 'EdgeReader.cjs')], { input: JSON.stringify(input), encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
    assert.equal(run.status, 0, run.stderr); const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.ok, true); assert.equal(parsed.file.version, 3); assert.equal(parsed.otherNotificationsPossible, true);
});
test('Windows export uses the bundled reader, consent and private file creation together', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const { options, directory } = await setup(t), root = path.dirname(options.snapshotPath), pkg = path.join(root, 'package'), owned = path.join(root, 'owned');
    const profile = path.join(owned, 'edge-profile'), dest = path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
    await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.cp(directory, dest, { recursive: true }); await fs.mkdir(pkg);
    const source = path.resolve(__dirname, '../../client/angelic-setup');
    for (const [from, to] of [['EdgeExport.ps1', 'EdgeExport.ps1'], ['EdgeSnapshot.ps1', 'EdgeSnapshot.ps1'], ['FirefoxReader.ps1', 'NativeSetup.ps1']])
        await fs.copyFile(path.join(source, from), path.join(pkg, to));
    const bundles = await require('../build-chrome-setup-bundles.cjs').buildChromeBundles({ includeEdge: true });
    for (const name of ['EdgeReader.cjs', 'ChromeLevelDB.node']) await fs.writeFile(path.join(pkg, name), bundles[name]);
    const quoted = value => `'${value.replace(/'/g, "''")}'`, output = path.join(root, 'saved.json');
    const expected = options.expected;
    const capture = { scope: 'https://x.com/', endpoint: expected.endpoint, applicationServerKey: expected.applicationServerKey.toString('base64url'),
        keys: { p256dh: expected.publicKey.toString('base64url'), auth: expected.auth.toString('base64url') } };
    const encoded = Buffer.from(JSON.stringify({ capture, agent: options.agent, client: options.client })).toString('base64');
    const script = `$ErrorActionPreference='Stop'
$script:Root=${quoted(owned)}; $script:Profile=${quoted(profile)}; $script:PackageRoot=${quoted(pkg)}
$script:Utf8=New-Object Text.UTF8Encoding($false); $script:UserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
function Fail-Safely([string]$code,[string]$message) { throw ($code+': '+$message) }
function Get-LocalPath([string]$p) { [IO.Path]::GetFullPath($p) }
function Assert-SafePath([string]$p) { if (-not $p.StartsWith(${quoted(root)},[StringComparison]::OrdinalIgnoreCase)) { throw 'outside' } }
function Test-InPath([string]$p,[string]$parent) { $p.StartsWith($parent+'\\',[StringComparison]::OrdinalIgnoreCase) }
function Get-PathAttributes([string]$p) { if (Test-Path -LiteralPath $p) { [IO.File]::GetAttributes($p) } else { $null } }
function Write-NewJson([string]$p,$v) { [IO.File]::WriteAllText($p,($v|ConvertTo-Json -Compress)) }
function Read-SmallJson([string]$p) { [IO.File]::ReadAllText($p)|ConvertFrom-Json }
function Assert-PropertyNames($o,[string[]]$n) { if (@($o.PSObject.Properties).Count -ne $n.Count) { throw 'bad marker' } }
function Invoke-Helper([string]$name,$inputObject) {
  if ($name -cne 'EdgeReader.cjs') { throw 'wrong helper' }
  $info=New-Object Diagnostics.ProcessStartInfo; $info.FileName=${quoted(process.execPath)}
  $info.Arguments='"'+[IO.Path]::Combine($script:PackageRoot,$name)+'"'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.EnvironmentVariables.Remove('NODE_PATH'); $info.EnvironmentVariables.Remove('NODE_OPTIONS')
  $process=[Diagnostics.Process]::Start($info)
  try { $json=$inputObject|ConvertTo-Json -Depth 12 -Compress; $bytes=$script:Utf8.GetBytes($json); $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length); $process.StandardInput.Close()
    $out=$process.StandardOutput.ReadToEnd(); $null=$process.StandardError.ReadToEnd(); if (-not $process.WaitForExit(15000) -or $process.ExitCode -ne 0) { throw 'reader failed' }; return ($out|ConvertFrom-Json)
  } finally { $process.Dispose() }
}
. ${quoted(path.join(pkg, 'EdgeExport.ps1'))}
$input=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quoted(encoded)}))|ConvertFrom-Json
$rejected=$false; try { Export-XEdgeTransfer -Capture $input.capture -Agent $input.agent -Client $input.client -BrowserVersion '157.0.0.1' -OutputPath ${quoted(output)} } catch { $rejected=$_.Exception.Message -like 'X_EDGE_OTHER_CONSENT_REQUIRED:*' }
if (-not $rejected -or (Test-Path -LiteralPath ${quoted(output)})) { throw 'consent bypassed' }
Export-XEdgeTransfer -Capture $input.capture -Agent $input.agent -Client $input.client -BrowserVersion '157.0.0.1' -OutputPath ${quoted(output)} -AllowOtherNotifications
if (-not (Test-Path -LiteralPath ${quoted(output)})) { throw 'file missing' }
if (@(Get-ChildItem -LiteralPath $script:Root -Directory -Filter 'edge-snapshot-*').Count -ne 0) { throw 'scratch remains' }
'ok'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 25000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ok/);
    const saved = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(saved.version, 3); assert.equal(saved.push.p256dhPublicKey, capture.keys.p256dh);
    assert(!JSON.stringify(saved).includes('other.example'));
});
