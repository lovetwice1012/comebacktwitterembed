'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, generateKeyPairSync, createCipheriv, pbkdf2Sync } = require('node:crypto');
const { readChromeSnapshot } = require('../../src/automation/chrome-snapshot-io');
const { parseChromeSnapshotJson } = require('../../src/automation/x-setup-transfer');
function vint(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, value) { const v = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vint(n * 8 + 2), vint(v.length), v]); }
async function fixture(t, platform = 'windows') {
    const token = randomBytes(16).toString('hex'), root = path.join(await fs.realpath(os.tmpdir()), `chrome-snapshot-${token}`);
    await fs.mkdir(root);
    t.after(async () => {
        const target = await fs.realpath(root), parent = await fs.realpath(os.tmpdir());
        assert.equal(path.dirname(target).toLowerCase(), parent.toLowerCase());
        assert.equal(path.basename(target), `chrome-snapshot-${token}`);
        await fs.rm(target, { recursive: true });
    });
    await fs.mkdir(path.join(root, 'Default', 'GCM Store', 'Encryption'), { recursive: true });
    await fs.writeFile(path.join(root, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'chrome-snapshot-v1', token }));
    const id = 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', sender = 'sender_123';
    await fs.writeFile(path.join(root, 'Default', 'Preferences'), JSON.stringify({ gcm: { product_category_for_subtypes: platform === 'macos' ? 'com.chrome.macosx' : 'com.chrome.windows',
        push_messaging_application_id_map: { [id]: 'https://x.com/#1#' } } }));
    if (platform === 'windows') await fs.writeFile(path.join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('wrapped')]).toString('base64') } }));
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted;
    const macPassword = Buffer.from('synthetic-mac-password');
    if (platform === 'macos') {
        const macKey = pbkdf2Sync(macPassword, 'saltysalt', 1003, 16, 'sha1');
        const macCipher = createCipheriv('aes-128-cbc', macKey, Buffer.alloc(16, 0x20));
        encrypted = Buffer.concat([Buffer.from('v10'), macCipher.update('456'), macCipher.final()]); macKey.fill(0);
    } else encrypted = Buffer.concat([Buffer.from('v10'), iv, cipher.update('456'), cipher.final(), cipher.getAuthTag()]);
    const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), pub = ecdh.publicKey.export({ format: 'jwk' }), auth = randomBytes(16);
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
    const record = Buffer.concat([field(1, id), field(3, auth), field(4, sender), field(5, ecdh.privateKey.export({ format: 'der', type: 'pkcs8' }))]);
    const opened = [];
    const dbFactory = name => ({ async open() { opened.push(name); }, async close() {},
        async get(keyName) { return keyName === 'device_aid_key' ? Buffer.from('123') : encrypted; },
        async *iterator() { yield [id + ',' + sender, record]; } });
    const subscription = { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') } };
    return { root, token, key, opened, input: { snapshotPath: root, token, subscription, browserVersion: '140.0.7339.42', dbFactory,
        ...(platform === 'macos' ? { platform, macPassword } : { unprotect: async () => Buffer.from(key) }), parseJson: parseChromeSnapshotJson } };
}
test('reads only a marked snapshot and binds Chrome keys to selected X subscription', async t => {
    const f = await fixture(t), result = await readChromeSnapshot(f.input);
    assert.equal(result.file.push.deviceId, '123'); assert.equal(result.file.push.securityToken, '456');
    assert.equal(result.otherSubscriptionCount, 0); assert.equal(f.opened.length, 2);
});
test('reads a synthetic Mac Chrome snapshot with explicit platform and rejects cross-platform imports', async t => {
    const f = await fixture(t, 'macos'), result = await readChromeSnapshot(f.input);
    assert.equal(result.file.push.deviceId, '123'); assert.equal(result.file.push.securityToken, '456');
    assert.equal(result.file.push.productCategory, 'com.chrome.macosx'); assert.equal(f.opened.length, 2);
    // Strict validation can explicitly exclude the experimental Mac category.
    const { normalizeChromeTransfer } = require('../../src/automation/chrome-x-transfer');
    assert.throws(() => normalizeChromeTransfer(result.file, { allowMac: false }), { code: 'X_CHROME_TRANSFER_INVALID' });
    await assert.rejects(readChromeSnapshot({ ...f.input, platform: 'windows', unprotect: async () => Buffer.alloc(32) }), { code: 'X_CHROME_SNAPSHOT_UNSUPPORTED' });
    await assert.rejects(readChromeSnapshot({ ...f.input, macPassword: Buffer.from('wrong') }), { code: 'X_CHROME_SNAPSHOT_INVALID' });
});
test('a Windows snapshot is rejected by the Mac reader before opening LevelDB', async t => {
    const f = await fixture(t);
    await assert.rejects(readChromeSnapshot({ ...f.input, platform: 'macos', macPassword: Buffer.from('synthetic') }), { code: 'X_CHROME_SNAPSHOT_UNSUPPORTED' });
    assert.equal(f.opened.length, 0);
});
test('Mac snapshot reader processes real isolated LevelDB stores', async t => {
    const { ClassicLevel } = require('classic-level');
    const f = await fixture(t, 'macos');
    const storeDir = path.join(f.root, 'Default', 'GCM Store'), keyDir = path.join(storeDir, 'Encryption');
    const original = f.input.dbFactory(storeDir), deviceId = await original.get('device_aid_key'), token = await original.get('device_token_key');
    const originalKeys = f.input.dbFactory(keyDir); let record;
    for await (const item of originalKeys.iterator()) record = item;
    const device = new ClassicLevel(storeDir, { valueEncoding: 'buffer' });
    await device.open(); await device.put('device_aid_key', deviceId); await device.put('device_token_key', token); await device.close();
    const keys = new ClassicLevel(keyDir, { valueEncoding: 'buffer' });
    await keys.open(); await keys.put(record[0], record[1]); await keys.close();
    const file = (await readChromeSnapshot({ ...f.input, dbFactory: location => new ClassicLevel(location,
        { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }) })).file;
    assert.equal(file.push.productCategory, 'com.chrome.macosx'); assert.equal(file.push.securityToken, '456');
});
test('rejects wrong ownership and unexpected files before opening LevelDB', async t => {
    const f = await fixture(t);
    await assert.rejects(readChromeSnapshot({ ...f.input, token: '0'.repeat(32) }), e => e.code === 'X_CHROME_SNAPSHOT_INVALID');
    await fs.writeFile(path.join(f.root, 'Default', 'GCM Store', 'unexpected.txt'), 'private');
    await assert.rejects(readChromeSnapshot(f.input), e => e.code === 'X_CHROME_SNAPSHOT_INVALID');
    assert.equal(f.opened.length, 0);
});
test('rejects duplicate preference fields rather than hiding other subscriptions', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'Default', 'Preferences'), '{"gcm":{},"gcm":{}}');
    await assert.rejects(readChromeSnapshot(f.input), e => e.code === 'X_CHROME_SNAPSHOT_INVALID');
});
