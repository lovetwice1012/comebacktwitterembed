'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, generateKeyPairSync, createCipheriv } = require('node:crypto');
const { readChromeSnapshot } = require('../../src/automation/chrome-snapshot-io');
const { parseChromeSnapshotJson } = require('../../src/automation/x-setup-transfer');
function vint(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, value) { const v = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vint(n * 8 + 2), vint(v.length), v]); }
async function fixture(t) {
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
    await fs.writeFile(path.join(root, 'Default', 'Preferences'), JSON.stringify({ gcm: { product_category_for_subtypes: 'com.chrome.windows',
        push_messaging_application_id_map: { [id]: 'https://x.com/#1#' } } }));
    await fs.writeFile(path.join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from('wrapped')]).toString('base64') } }));
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([Buffer.from('v10'), iv, cipher.update('456'), cipher.final(), cipher.getAuthTag()]);
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
        unprotect: async () => Buffer.from(key), parseJson: parseChromeSnapshotJson } };
}
test('reads only a marked snapshot and binds Chrome keys to selected X subscription', async t => {
    const f = await fixture(t), result = await readChromeSnapshot(f.input);
    assert.equal(result.file.push.deviceId, '123'); assert.equal(result.file.push.securityToken, '456');
    assert.equal(result.otherSubscriptionCount, 0); assert.equal(f.opened.length, 2);
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
