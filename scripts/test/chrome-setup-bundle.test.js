'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCipheriv, randomBytes, generateKeyPairSync } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { buildChromeBundles } = require('../build-chrome-setup-bundles.cjs');
function vint(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, v) { const b = Buffer.isBuffer(v) ? v : Buffer.from(v); return Buffer.concat([vint(n * 8 + 2), vint(b.length), b]); }

test('bundled Chrome reader opens only owned snapshots without installed modules', async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-chrome-bundle-test-'));
    t.after(async () => {
        const checked = await fs.realpath(root); assert.equal(path.dirname(checked).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(checked), /^cbte-chrome-bundle-test-/); await fs.rm(checked, { recursive: true });
    });
    const bundles = await buildChromeBundles();
    for (const [name, data] of Object.entries(bundles)) {
        const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
    }
    const token = randomBytes(16).toString('hex'), snapshot = path.join(root, `chrome-snapshot-${token}`), store = path.join(snapshot, 'Default', 'GCM Store');
    await fs.mkdir(path.join(store, 'Encryption'), { recursive: true });
    await fs.writeFile(path.join(snapshot, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'chrome-snapshot-v1', token }));
    const id = 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', sender = 'sender_123';
    await fs.writeFile(path.join(snapshot, 'Default', 'Preferences'), JSON.stringify({ gcm: { product_category_for_subtypes: 'com.chrome.windows',
        push_messaging_application_id_map: { [id]: 'https://x.com/#1#' } } }));
    await fs.writeFile(path.join(snapshot, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('wrapped')]).toString('base64') } }));
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const tokenValue = Buffer.concat([Buffer.from('v10'), iv, cipher.update('456'), cipher.final(), cipher.getAuthTag()]);
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = ec.publicKey.export({ format: 'jwk' }), auth = randomBytes(16);
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const keyRecord = Buffer.concat([field(1, id), field(3, auth), field(4, sender), field(5, ec.privateKey.export({ format: 'der', type: 'pkcs8' }))]);
    for (const [directory, entries] of [[store, [['device_aid_key', Buffer.from('123')], ['device_token_key', tokenValue]]],
        [path.join(store, 'Encryption'), [[`${id},${sender}`, keyRecord]]]]) {
        const db = new ClassicLevel(directory, { keyEncoding: 'utf8', valueEncoding: 'buffer' });
        try { for (const [k, v] of entries) await db.put(k, v); } finally { await db.close(); }
    }
    const input = { snapshotPath: snapshot, token, browserVersion: '140.0.7339.42', profileKey: key.toString('base64url'),
        subscription: { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } } };
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = value => spawnSync(process.execPath, [path.join(root, 'ChromeReader.cjs')], { input: JSON.stringify(value), encoding: 'utf8', env, timeout: 15000 });
    const result = run(input); assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout); assert.equal(data.ok, true); assert.equal(data.file.push.deviceId, '123');
    assert.equal(data.file.push.securityToken, '456'); assert.equal(data.otherSubscriptionCount, 0);
    const rejected = run({ ...input, token: '0'.repeat(32) });
    assert.notEqual(rejected.status, 0); assert.equal(JSON.parse(rejected.stdout).ok, false);
});
