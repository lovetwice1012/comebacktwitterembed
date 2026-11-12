'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCipheriv, pbkdf2Sync, randomBytes, generateKeyPairSync } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
function vint(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, v) { const b = Buffer.isBuffer(v) ? v : Buffer.from(v); return Buffer.concat([vint(n * 8 + 2), vint(b.length), b]); }

test('Mac local reader exports a synthetic owned snapshot through private pipes', async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-mac-reader-test-'));
    t.after(async () => {
        const real = await fs.realpath(root); assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase());
        assert.match(path.basename(real), /^cbte-mac-reader-test-/); await fs.rm(real, { recursive: true });
    });
    const token = randomBytes(16).toString('hex'), snapshot = path.join(root, `chrome-snapshot-${token}`), store = path.join(snapshot, 'Default', 'GCM Store');
    await fs.mkdir(path.join(store, 'Encryption'), { recursive: true });
    await fs.writeFile(path.join(snapshot, 'snapshot-owner.json'), JSON.stringify({ appId: 'x-notification-setup', kind: 'chrome-snapshot-v1', token }));
    const id = 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', sender = 'sender_123';
    await fs.writeFile(path.join(snapshot, 'Default', 'Preferences'), JSON.stringify({ gcm: { product_category_for_subtypes: 'com.chrome.macosx',
        push_messaging_application_id_map: { [id]: 'https://x.com/#1#', other: 'https://example.com/#2#' } } }));
    const password = Buffer.from('synthetic-password'), key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const tokenValue = Buffer.concat([Buffer.from('v10'), cipher.update('456'), cipher.final()]); key.fill(0);
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = ec.publicKey.export({ format: 'jwk' }), auth = randomBytes(16);
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const record = Buffer.concat([field(1, id), field(3, auth), field(4, sender), field(5, ec.privateKey.export({ format: 'der', type: 'pkcs8' }))]);
    for (const [directory, entries] of [[store, [['device_aid_key', Buffer.from('123')], ['device_token_key', tokenValue]]],
        [path.join(store, 'Encryption'), [[`${id},${sender}`, record]]]]) {
        const db = new ClassicLevel(directory, { keyEncoding: 'utf8', valueEncoding: 'buffer' });
        try { for (const [k, v] of entries) await db.put(k, v); } finally { await db.close(); }
    }
    const input = { snapshotPath: snapshot, token, browserVersion: '140.0.7339.42', macPassword: password.toString('base64url'),
        subscription: { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } } };
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const run = value => spawnSync(process.execPath, [path.join(__dirname, '..', 'chrome-mac-setup-reader.cjs')],
        { input: JSON.stringify(value), encoding: 'utf8', env, timeout: 15000 });
    const good = run(input); assert.equal(good.status, 0, good.stderr);
    const result = JSON.parse(good.stdout); assert.equal(result.ok, true); assert.equal(result.file.push.securityToken, '456');
    assert.equal(result.file.push.productCategory, 'com.chrome.macosx'); assert.equal(result.otherSubscriptionCount, 1);
    for (const value of [{ ...input, macPassword: Buffer.from('wrong').toString('base64url') },
        { ...input, token: '0'.repeat(32) }, { ...input, extra: 'synthetic-password' }]) {
        const bad = run(value); assert.notEqual(bad.status, 0); assert.equal(JSON.parse(bad.stdout).ok, false);
        assert(!bad.stdout.includes('synthetic-password')); assert.equal(bad.stderr, '');
    }
    for (const raw of ['{"macPassword":"a","macPassword":"b"}', 'x'.repeat(32769)]) {
        const bad = spawnSync(process.execPath, [path.join(__dirname, '..', 'chrome-mac-setup-reader.cjs')],
            { input: raw, encoding: 'utf8', env, timeout: 15000 });
        assert.notEqual(bad.status, 0); assert.equal(JSON.parse(bad.stdout).ok, false); assert.equal(bad.stderr, '');
    }
    password.fill(0);
});
