'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash, createCipheriv, pbkdf2Sync, generateKeyPairSync, randomBytes } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { ensureMacSetupDirectory } = require('../../src/automation/chrome-mac-app');
const { getOrCreateMacBraveProfile } = require('../../src/automation/chrome-mac-profile-registry');
const { normalizeChromeTransfer } = require('../../src/automation/chrome-x-transfer');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
const helper = process.env.MAC_LOCK_HELPER;
function vint(n) { const out=[]; do { let b=n%128; n=Math.floor(n/128); if(n)b|=128; out.push(b); } while(n); return Buffer.from(out); }
function field(n, value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vint(n*8+2),vint(bytes.length),bytes]); }
async function load(file, overrides) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation', file), 'utf8'), module = { exports: {} };
    const requireModule = name => Object.hasOwn(overrides, name) ? overrides[name]
        : name.startsWith('./') ? require(path.join(__dirname, '../../src/automation', name)) : require(name);
    vm.runInNewContext(source, { module, exports: module.exports, require: requireModule, Object, Number, AbortSignal, setTimeout, clearTimeout });
    return module.exports;
}

test('simulated Brave setup composes owned profile, local capture, snapshot and consented file',
    { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
        const temp = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(temp, 'cbte-brave-composed-'));
        t.after(async () => {
            const real = await fs.realpath(base); assert.equal(path.dirname(real), temp);
            assert.match(path.basename(real), /^cbte-brave-composed-/); await fs.rm(real, { recursive: true });
        });
        const support = path.join(base, 'Application Support'); await fs.mkdir(support, { mode: 0o700 });
        const data = await ensureMacSetupDirectory(support), profile = await getOrCreateMacBraveProfile(data);
        const defaults = path.join(profile.profilePath, 'Default'), store = path.join(defaults, 'GCM Store'), encryption = path.join(store, 'Encryption');
        await fs.mkdir(encryption, { recursive: true });
        const id = 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', sender = 'sender_123';
        await fs.writeFile(path.join(defaults, 'Preferences'), JSON.stringify({ gcm: { product_category_for_subtypes: 'com.brave.macosx',
            push_messaging_application_id_map: { [id]: 'https://x.com/#1#', other: 'https://example.com/#2#' } } }));
        await fs.writeFile(path.join(defaults, 'Cookies'), 'synthetic-must-not-copy');
        const password = Buffer.from('synthetic-password'), key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
        const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
        const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update('456'), cipher.final()]); key.fill(0);
        const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = ec.publicKey.export({ format: 'jwk' }), auth = randomBytes(16);
        const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
        const record = Buffer.concat([field(1, id), field(3, auth), field(4, sender), field(5, ec.privateKey.export({ format: 'der', type: 'pkcs8' }))]);
        for (const [directory, entries] of [[store, [['device_aid_key', Buffer.from('123')], ['device_token_key', encrypted]]], [encryption, [[`${id},${sender}`, record]]]]) {
            const db = new ClassicLevel(directory, { keyEncoding: 'utf8', valueEncoding: 'buffer' });
            try { for (const [name, value] of entries) await db.put(name, value); } finally { await db.close(); }
        }
        const subscription = { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test',
            keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') } };
        let borrowed, finish; const released = new Promise(resolve => { finish = resolve; });
        const chrome = { exitCode: null, signalCode: null, kill() { throw new Error('unexpected kill'); } };
        const flow = await load('brave-mac-export-flow.js', { './chrome-mac-keychain': { withMacBraveKeychainPassword: async options => {
            borrowed = Buffer.from(password); try { return await options.work(borrowed); } finally { borrowed.fill(0); }
        } } });
        const session = await load('brave-mac-setup-session.js', {
            './brave-mac-broker': { startMacBraveBroker: async options => {
                assert.equal(options.rootPath, profile.rootPath); assert.equal(options.profileId, profile.profileId);
                return { port: 12345, token: 'a'.repeat(64), chrome, browserVersion: '157.1.99.55', engineVersion: '157.0.8103.39',
                    releaseComplete: released, stop: async () => {} };
            } },
            './chrome-broker-client': { captureFromBroker: async () => { chrome.exitCode = 0; finish(true); return subscription; } },
            './brave-mac-export-flow': flow,
        });
        const app = await load('brave-mac-app.js', { './brave-mac-setup-session': session });
        const ui = { confirmOpen: async () => true, confirmNotifications: async () => true, retryCapture: async () => false,
            confirmKeychain: async () => true, confirmSave: async details => {
                assert.equal(details.otherSubscriptionCount, 1); assert.equal(details.otherNotificationsMayReachServer, true);
                assert(borrowed.every(byte => byte === 0));
                assert((await fs.readdir(profile.rootPath)).every(name => !name.startsWith('brave-snapshot-')));
                return { confirmed: true, directory: base, filename: 'notifications.json', otherSitesConsent: true };
            } };
        const result = await app.runExperimentalMacBraveApp({ applicationSupport: support, helperPath: helper,
            expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex'), ui, experimental: true });
        assert.equal(result.state, 'saved'); assert.equal(result.uploaded, false);
        const file = JSON.parse(await fs.readFile(path.join(base, 'notifications.json'), 'utf8'));
        assert.equal(normalizeChromeTransfer(file, { allowMac: true, allowBraveMac: true }).push.productCategory, 'com.brave.macosx');
        assert.throws(() => parseTransferFile(JSON.stringify(file)), error => error.code === 'X_SETUP_INVALID_FILE');
        assert.equal(await fs.readFile(path.join(defaults, 'Cookies'), 'utf8'), 'synthetic-must-not-copy'); password.fill(0);
    });
