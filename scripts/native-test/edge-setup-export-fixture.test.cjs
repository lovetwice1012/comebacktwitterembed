'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createECDH, generateKeyPairSync, randomBytes } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { unzipSync } = require('fflate');
const { buildArchive } = require('../build-edge-setup-package.cjs');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
function varint(n) { const out = []; do { let byte = n % 128; n = Math.floor(n / 128); if (n) byte |= 128; out.push(byte); } while (n); return Buffer.from(out); }
function field(n, value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]); }
test('packaged Edge setup exports a synthetic subscription after isolated calibration', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
    const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'cbte-edge-export-package-')); let broker;
    t.after(async () => {
        if (broker && broker.exitCode === null && broker.signalCode === null) { broker.kill(); await once(broker, 'exit').catch(() => {}); }
        const actual = await fs.realpath(root); assert.equal(path.dirname(actual).toLowerCase(), temp.toLowerCase());
        assert.match(path.basename(actual), /^cbte-edge-export-package-/); await fs.rm(actual, { recursive: true });
    });
    const packageRoot = path.join(root, 'package'), owned = path.join(root, 'owned'); await fs.mkdir(packageRoot);
    for (const [name, bytes] of Object.entries(unzipSync((await buildArchive({ nodeExecutable: process.execPath })).archive))) {
        assert.match(name, /^(?:_app\/)?[^/\\]+$/); const file = path.join(packageRoot, name);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    const app = path.join(packageRoot, '_app'), setup = path.join(app, 'EdgeSetup.ps1');
    const call = args => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', setup, ...args],
        { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    const prepared = call(['-Action', 'Prepare', '-PrivateRoot', owned]); assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).prepared, true);
    const profile = path.join(owned, 'edge-profile'), store = path.join(profile, 'Default', 'EdgePushStorageWithConnectTokenAndKey'); await fs.mkdir(store, { recursive: true });
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), appKey = createECDH('prime256v1'); appKey.generateKeys();
    const jwk = keys.publicKey.export({ format: 'jwk' }), publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const auth = randomBytes(16), endpoint = 'https://wns2-pn1p.notify.windows.com/?token=synthetic', siteChannel = 'synthetic-channel';
    const record = Buffer.concat([field(1, siteChannel), field(3, endpoint), field(6, auth), field(7, keys.privateKey.export({ format: 'der', type: 'pkcs8' })),
        field(8, Buffer.concat([field(1, 'origin'), field(2, 'https://x.com/')])), field(16, appKey.getPublicKey())]);
    const database = new ClassicLevel(store, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    try { await database.put(Buffer.from('device'), Buffer.concat([field(2, 'synthetic-reconnect-token'), field(3, randomBytes(32).toString('base64'))]));
        await database.put(Buffer.from('site'), record); } finally { await database.close(); }
    const token = randomBytes(32).toString('hex'), subscription = { scope: 'https://x.com/', endpoint,
        keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') }, applicationServerKey: appKey.getPublicKey().toString('base64url') };
    const script = path.join(root, 'synthetic-broker.cjs');
    await fs.writeFile(script, `const net=require('node:net');const token=process.env.FIXTURE_TOKEN;const value=JSON.parse(process.env.FIXTURE_SUBSCRIPTION);const server=net.createServer(socket=>{let input='';socket.on('data',chunk=>{input+=chunk.toString();if(!input.endsWith('\\n'))return;let request;try{request=JSON.parse(input)}catch{socket.destroy();return}if(request.command!=='capture'||request.token!==token){socket.destroy();return}socket.end(JSON.stringify({ok:true,subscription:value})+'\\n');server.close();});});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));setTimeout(()=>process.exit(2),60000).unref();`);
    broker = spawn(path.join(app, 'ChromeNode.exe'), [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, FIXTURE_TOKEN: token, FIXTURE_SUBSCRIPTION: JSON.stringify(subscription) } });
    const portLine = await new Promise((resolve, reject) => { let text = ''; broker.stdout.on('data', chunk => { text += chunk.toString(); if (text.includes('\n')) resolve(text.trim()); }); broker.once('error', reject); });
    const port = Number(portLine); assert(port >= 1024 && port <= 65535);
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const infoScript = `$p=Get-Process -Id ${broker.pid};try{$p.StartTime.ToUniversalTime().ToString('o')}finally{$p.Dispose()};(Get-Item -LiteralPath '${edge.replace(/'/g, "''")}').VersionInfo.FileVersion`;
    const info = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(infoScript, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(info.status, 0, info.stderr); const [started, version] = info.stdout.trim().split(/\r?\n/);
    const owner = JSON.parse(await fs.readFile(path.join(owned, 'owner.json'), 'utf8'));
    await fs.writeFile(path.join(owned, 'launches', 'launch-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ schemaVersion: 1,
        appId: 'x-notification-setup', profileId: owner.profileId, pid: broker.pid, processStartedUtc: started, browserVersion: version, engineVersion: version, port, brokerToken: token }));
    const destination = path.join(root, 'notification.json');
    const result = call(['-Action', 'Export', '-PrivateRoot', owned, '-OutputPath', destination]);
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(JSON.parse(result.stdout).fileCreated, true);
    const file = parseTransferFile(await fs.readFile(destination, 'utf8')); assert.equal(file.version, 3); assert.equal(file.push.siteChannel, siteChannel);
    assert.equal(file.push.p256dhPublicKey, subscription.keys.p256dh);
    assert.equal((await fs.readdir(owned)).filter(name => name.startsWith('edge-calibration-') || name.startsWith('edge-snapshot-')).length, 0);
});
