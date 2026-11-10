'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { ClassicLevel } = require('classic-level');
const { createHash, createCipheriv, createECDH, pbkdf2Sync, randomBytes, generateKeyPairSync } = require('node:crypto');
const { createMacChromeProfile, createMacEdgeProfile } = require('../../src/automation/chrome-mac-profile');
const { acquireMacProfileLease, beginMacProfileLease, releaseMacProfileLease } = require('../../src/automation/chrome-mac-profile-lease');
const { withMacStoreLocks } = require('../../src/automation/chrome-mac-store-locks');
const { withMacChromeSnapshot, withMacEdgeSnapshot } = require('../../src/automation/chrome-mac-snapshot');
const { readEdgeSnapshot } = require('../../src/automation/edge-wns-snapshot-io');
const { readChromeSnapshot } = require('../../src/automation/chrome-snapshot-io');
const { parseUniqueJson } = require('../../src/automation/strict-json');
const helper = process.env.MAC_LOCK_HELPER;
function vint(n) { const a = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n, value) { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vint(n * 8 + 2), vint(b.length), b]); }

function runLock(...locks) {
    const child = spawn(helper, locks, { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const ready = Promise.race([
        once(child.stdout, 'data').then(([data]) => data.toString('ascii')),
        exited.then(() => { throw new Error('helper exited without a status'); }),
        new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('helper timed out')), 5000); timer.unref(); }),
    ]);
    return { child, ready, exited };
}
test('native helper holds real LevelDB fcntl locks and releases them on EOF', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'cbte-mac-lock-test-'));
    const processes = [];
    t.after(async () => {
        for (const item of processes) if (item.child.exitCode === null) { item.child.stdin.end(); await item.exited.catch(() => {}); }
        const real = await fs.realpath(root); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-lock-test-/); await fs.rm(real, { recursive: true });
    });
    const dirs = ['first', 'second', 'third', 'fourth'].map(name => path.join(root, name));
    for (const dir of dirs) { const db = new ClassicLevel(dir); await db.put('test', 'synthetic'); await db.close(); }
    const locks = dirs.map(dir => path.join(dir, 'LOCK'));
    const first = runLock(locks[0], locks[1]); processes.push(first); assert.equal(await first.ready, 'R');
    const contender = runLock(locks[0], locks[1]); processes.push(contender); assert.equal(await contender.ready, 'B'); await contender.exited;
    const db = new ClassicLevel(dirs[0], { createIfMissing: false });
    try { await assert.rejects(db.open(), error => error.code === 'LEVEL_LOCKED' || /lock/i.test(String(error.cause?.message || error.message))); }
    finally { await db.close().catch(() => {}); }
    first.child.stdin.end(); assert.equal((await first.exited)[0], 0);
    const successor = runLock(locks[0], locks[1]); processes.push(successor); assert.equal(await successor.ready, 'R');
    successor.child.stdin.end(); await successor.exited;
    const holder = runLock(locks[1], locks[2]); processes.push(holder); assert.equal(await holder.ready, 'R');
    const partial = runLock(locks[0], locks[1]); processes.push(partial); assert.equal(await partial.ready, 'B'); await partial.exited;
    const afterPartial = runLock(locks[0], locks[3]); processes.push(afterPartial); assert.equal(await afterPartial.ready, 'R');
    afterPartial.child.stdin.end(); await afterPartial.exited; holder.child.stdin.end(); await holder.exited;
    const single = runLock(locks[0]); processes.push(single); assert.equal(await single.ready, 'R');
    const blocked = new ClassicLevel(dirs[0], { createIfMissing: false });
    try { await assert.rejects(blocked.open(), error => /lock/i.test(String(error.cause?.message || error.message))); }
    finally { await blocked.close().catch(() => {}); }
    single.child.stdin.end(); assert.equal((await single.exited)[0], 0);
    const link = path.join(root, 'link'); await fs.symlink(locks[0], link);
    const invalid = runLock(link, locks[1]); processes.push(invalid); assert.equal(await invalid.ready, 'E'); await invalid.exited;
    const same = runLock(locks[0], path.join(dirs[0], '.', 'LOCK')); processes.push(same); assert.equal(await same.ready, 'E'); await same.exited;
});
test('Mac snapshot copies only notification data under both locks and is removed after reading', { skip: !helper || process.platform === 'win32', timeout: 20000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-snapshot-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-snapshot-test-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacChromeProfile(base), defaults = path.join(profile.profilePath, 'Default');
    const store = path.join(defaults, 'GCM Store'), nested = path.join(store, 'Encryption'); await fs.mkdir(nested, { recursive: true });
    const appId = 'wp:https://x.com/#01234567-89AB-4CDE-8FAB-012345678-V2', sender = 'sender_123';
    await fs.writeFile(path.join(defaults, 'Preferences'), JSON.stringify({ gcm: { product_category_for_subtypes: 'com.chrome.macosx',
        push_messaging_application_id_map: { [appId]: 'https://x.com/#1#', other: 'https://example.com/#2#' } } }));
    for (const name of ['Cookies', 'History', 'Login Data']) await fs.writeFile(path.join(defaults, name), 'must not be copied');
    const password = Buffer.from('synthetic-password'), key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update('456'), cipher.final()]); key.fill(0);
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = ec.publicKey.export({ format: 'jwk' }), auth = randomBytes(16);
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const record = Buffer.concat([field(1, appId), field(3, auth), field(4, sender), field(5, ec.privateKey.export({ format: 'der', type: 'pkcs8' }))]);
    for (const [dir, entries] of [[store, [['device_aid_key', Buffer.from('123')], ['device_token_key', encrypted]]], [nested, [[`${appId},${sender}`, record]]]]) {
        const db = new ClassicLevel(dir, { keyEncoding: 'utf8', valueEncoding: 'buffer' });
        try { for (const [keyName, value] of entries) await db.put(keyName, value); } finally { await db.close(); }
    }
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    const subscription = { scope: 'https://x.com/', endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
    let snapshotPath;
    const result = await withMacChromeSnapshot({ ...args, work: async snapshot => {
        snapshotPath = snapshot.snapshotPath;
        for (const name of ['Cookies', 'History', 'Login Data']) await assert.rejects(fs.access(path.join(snapshotPath, 'Default', name)), { code: 'ENOENT' });
        const read = await readChromeSnapshot({ ...snapshot, subscription, browserVersion: '140.0.7339.42', platform: 'macos', macPassword: password,
            parseJson: text => parseUniqueJson(text, 64), dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }) });
        return read.file;
    } });
    assert.equal(result.push.securityToken, '456'); assert.equal(result.push.productCategory, 'com.chrome.macosx');
    await assert.rejects(fs.access(snapshotPath), { code: 'ENOENT' });
    assert((await fs.readdir(profile.rootPath)).every(name => !name.startsWith('chrome-snapshot-')));
    const flowFile = path.join(__dirname, '../../src/automation/chrome-mac-export-flow.js');
    const flowSource = await fs.readFile(flowFile, 'utf8'), module = { exports: {} }; let borrowed;
    const mockedRequire = name => {
        if (name === './chrome-mac-keychain') return { withMacChromeKeychainPassword: async options => {
            assert.equal(options.confirmed, true); borrowed = Buffer.from(password);
            try { return await options.work(borrowed); } finally { borrowed.fill(0); }
        } };
        if (name.startsWith('./')) return require(path.join(path.dirname(flowFile), name));
        return require(name);
    };
    vm.runInNewContext(flowSource, { module, exports: module.exports, require: mockedRequire, AbortSignal, Object, Number });
    const flowArgs = { ...args, subscription, browserVersion: '140.0.7339.42', keychainConfirmed: true };
    const confirm = async details => {
        assert.equal(details.otherSubscriptionCount, 1); assert.equal(details.otherNotificationsMayReachServer, true);
        assert(borrowed.every(byte => byte === 0));
        assert((await fs.readdir(profile.rootPath)).every(name => !name.startsWith('chrome-snapshot-')));
    };
    assert.equal((await module.exports.exportMacChromeNotifications({ ...flowArgs, confirmSave: async details => { await confirm(details); return null; } })).state, 'cancelled');
    await assert.rejects(module.exports.exportMacChromeNotifications({ ...flowArgs, confirmSave: async details => {
        await confirm(details); return { confirmed: true, otherSitesConsent: false, directory: base, filename: 'rejected.json' };
    } }), { code: 'X_CHROME_MAC_FLOW_CONFIRMATION_REQUIRED' });
    await assert.rejects(fs.access(path.join(base, 'rejected.json')), { code: 'ENOENT' });
    const output = await module.exports.exportMacChromeNotifications({ ...flowArgs, confirmSave: async details => {
        await confirm(details); return { confirmed: true, otherSitesConsent: true, directory: base, filename: 'notifications.json' };
    } });
    assert.equal(output.state, 'saved'); assert.equal(output.uploaded, false);
    const saved = JSON.parse(await fs.readFile(path.join(base, 'notifications.json'), 'utf8'));
    assert.equal(saved.push.securityToken, '456'); assert(!JSON.stringify(saved).includes('synthetic-password'));
    await assert.rejects(withMacChromeSnapshot({ ...args, work: async () => { throw new Error('synthetic read failure'); } }), { code: 'X_CHROME_MAC_LOCK_FAILED' });
    assert((await fs.readdir(profile.rootPath)).every(name => !name.startsWith('chrome-snapshot-')));
    await fs.writeFile(path.join(store, 'unexpected.txt'), 'must reject');
    await assert.rejects(withMacChromeSnapshot({ ...args, work: async () => { throw new Error('must not run'); } }), { code: 'X_CHROME_MAC_SNAPSHOT_INVALID' });
    assert((await fs.readdir(profile.rootPath)).every(name => !name.startsWith('chrome-snapshot-')));
    password.fill(0);
});
test('profile lock wrapper fences browser starts and real LevelDB access until work finishes', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-lock-wrapper-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-lock-wrapper-test-/); await fs.rm(real, { recursive: true });
    });
    const profile = await createMacChromeProfile(base), store = path.join(profile.profilePath, 'Default', 'GCM Store');
    const nested = path.join(store, 'Encryption'); await fs.mkdir(nested, { recursive: true });
    for (const dir of [store, nested]) { const db = new ClassicLevel(dir); await db.put('test', 'synthetic'); await db.close(); }
    const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    await assert.rejects(withMacStoreLocks({ ...args, expectedSha256: '0'.repeat(64), work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_INVALID' });
    const busyDb = new ClassicLevel(store, { createIfMissing: false }); await busyDb.open();
    try { await assert.rejects(withMacStoreLocks({ ...args, work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_BUSY' }); }
    finally { await busyDb.close(); }
    const result = await withMacStoreLocks({ ...args, work: async ({ profilePath, signal }) => {
        assert.equal(profilePath, profile.profilePath); assert.equal(signal.aborted, false);
        await assert.rejects(withMacStoreLocks({ ...args, work: async () => {} }), { code: 'X_CHROME_MAC_LOCK_BUSY' });
        for (const dir of [store, nested]) {
            const db = new ClassicLevel(dir, { createIfMissing: false });
            try { await assert.rejects(db.open(), error => /lock/i.test(String(error.cause?.message || error.message))); }
            finally { await db.close().catch(() => {}); }
        }
        return 'snapshot-ready';
    } });
    assert.equal(result, 'snapshot-ready');
    assert.equal(await withMacStoreLocks({ ...args, work: async () => 'reacquired' }), 'reacquired');
    await assert.rejects(withMacStoreLocks({ ...args, work: async () => { throw new Error('sensitive'); } }), { code: 'X_CHROME_MAC_LOCK_FAILED' });
    assert.equal(await withMacStoreLocks({ ...args, work: async () => 'released-after-failure' }), 'released-after-failure');
    const failingHelper = path.join(base, 'synthetic-exit-helper');
    await fs.writeFile(failingHelper, '#!/bin/sh\nprintf R\nsleep 0.1\n', { mode: 0o700 });
    const badHash = createHash('sha256').update(await fs.readFile(failingHelper)).digest('hex');
    await assert.rejects(withMacStoreLocks({ ...args, helperPath: failingHelper, expectedSha256: badHash,
        work: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }), { code: 'X_CHROME_MAC_LOCK_LOST' });
    assert.equal(await withMacStoreLocks({ ...args, work: async () => 'released-after-exit' }), 'released-after-exit');
});
test('experimental Edge profile locks one real LevelDB and rejects Chrome profile confusion', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-edge-lock-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-edge-lock-test-/); await fs.rm(real, { recursive: true });
    });
    const edge = await createMacEdgeProfile(base), chrome = await createMacChromeProfile(base);
    const store = path.join(edge.profilePath, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
    await fs.mkdir(path.dirname(store), { recursive: true });
    const db = new ClassicLevel(store); await db.put('fixture', 'synthetic'); await db.close();
    const args = { browser: 'edge', rootPath: edge.rootPath, profileId: edge.profileId, helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    await assert.rejects(withMacStoreLocks({ ...args, rootPath: chrome.rootPath, profileId: chrome.profileId, work: async () => {} }), { code: 'X_CHROME_MAC_PROFILE_INVALID' });
    assert.equal(await withMacStoreLocks({ ...args, work: async () => {
        const occupied = new ClassicLevel(store, { createIfMissing: false });
        try { await assert.rejects(occupied.open(), error => /lock/i.test(String(error.cause?.message || error.message))); }
        finally { await occupied.close().catch(() => {}); }
        return 'protected';
    } }), 'protected');
    const reopen = new ClassicLevel(store, { createIfMissing: false });
    try { assert.equal(await reopen.get('fixture'), 'synthetic'); } finally { await reopen.close(); }
});
test('experimental Mac Edge snapshot copies one store, filters other files and cleans up', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-edge-snapshot-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-edge-snapshot-test-/); await fs.rm(real, { recursive: true });
    });
    const edge = await createMacEdgeProfile(base), defaults = path.join(edge.profilePath, 'Default');
    const store = path.join(defaults, 'EdgePushStorageWithConnectTokenAndKey'); await fs.mkdir(path.dirname(store), { recursive: true });
    await fs.writeFile(path.join(defaults, 'Cookies'), 'must not be copied');
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = key.publicKey.export({ format: 'jwk' });
    const app = createECDH('prime256v1'); app.generateKeys();
    const expected = { endpoint: 'https://wns2-pn1p.notify.windows.com/?token=synthetic',
        publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]),
        auth: randomBytes(16), applicationServerKey: app.getPublicKey() };
    const record = Buffer.concat([field(1, 'synthetic-channel'), field(3, expected.endpoint), field(6, expected.auth),
        field(7, key.privateKey.export({ format: 'der', type: 'pkcs8' })), field(8, Buffer.concat([field(1, 'origin'), field(2, 'https://x.com/')])), field(16, expected.applicationServerKey)]);
    const db = new ClassicLevel(store, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    try { await db.put(Buffer.from('device'), Buffer.concat([field(2, 'synthetic-token'), field(3, randomBytes(32).toString('base64'))]));
        await db.put(Buffer.from('target'), record); await db.put(Buffer.from('unknown'), Buffer.alloc(8)); } finally { await db.close(); }
    const args = { rootPath: edge.rootPath, profileId: edge.profileId, helperPath: helper,
        expectedSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') };
    let snapshotPath;
    const result = await withMacEdgeSnapshot({ ...args, work: async snapshot => {
        snapshotPath = snapshot.snapshotPath;
        await assert.rejects(fs.access(path.join(snapshotPath, 'Default', 'Cookies')), { code: 'ENOENT' });
        await assert.rejects(fs.access(path.join(snapshotPath, 'Default', 'Preferences')), { code: 'ENOENT' });
        return readEdgeSnapshot({ ...snapshot, expected, browserVersion: '157.0.0.1',
            agent: { os: 'Fixture OS', osVersion: '1', architecture: 'fixture', locale: 'en' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' },
            dbFactory: directory => new ClassicLevel(directory, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) });
    } });
    assert.equal(result.file.version, 3); assert.equal(result.file.push.scope, 'https://x.com/');
    assert.equal(result.otherNotificationsPossible, true); assert.equal(result.unclassifiedRecordCount, 1);
    await assert.rejects(fs.access(snapshotPath), { code: 'ENOENT' });
    await fs.writeFile(path.join(store, 'unexpected.txt'), 'must reject');
    await assert.rejects(withMacEdgeSnapshot({ ...args, work: async () => {} }), { code: 'X_CHROME_MAC_SNAPSHOT_INVALID' });
    assert((await fs.readdir(edge.rootPath)).every(name => !name.startsWith('edge-snapshot-')));
});
test('Mac Edge inspection and launch retain one profile lease without an intervening gap', { skip: !helper || process.platform === 'win32', timeout: 15000 }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-mac-edge-open-test-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-mac-edge-open-test-/); await fs.rm(real, { recursive: true });
    });
    const sourceFile = path.join(__dirname, '../../src/automation/edge-mac-open.js');
    const source = await fs.readFile(sourceFile, 'utf8'), module = { exports: {} }, calls = [];
    let failPending = false, releasePending;
    const mockedRequire = name => {
        if (name === './edge-mac-broker') return { startMacEdgeBroker: async options => {
            await assert.rejects(acquireMacProfileLease({ rootPath: options.rootPath, profileId: options.profileId, browser: 'edge' }), { code: 'X_CHROME_MAC_LEASE_BUSY' });
            const names = await fs.readdir(options.rootPath); assert(names.every(name => !name.startsWith('edge-snapshot-')));
            const operation = beginMacProfileLease(options.profileLease, { rootPath: options.rootPath, profileId: options.profileId, browser: 'edge' });
            calls.push(options.suppressReceive);
            if (failPending) {
                releasePending = async () => { operation.end(); await releaseMacProfileLease(options.profileLease); };
                throw Object.assign(new Error('synthetic'), { code: 'X_EDGE_MAC_BROKER_CLEANUP_PENDING' });
            }
            return { release: async () => { operation.end(); await releaseMacProfileLease(options.profileLease); } };
        } };
        if (name.startsWith('./')) return require(path.join(path.dirname(sourceFile), name));
        return require(name);
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: mockedRequire });
    const hash = createHash('sha256').update(await fs.readFile(helper)).digest('hex');
    for (const origin of ['fresh', 'https://x.com/', 'https://example.com/']) {
        const profile = await createMacEdgeProfile(base);
        if (origin !== 'fresh') {
            const store = path.join(profile.profilePath, 'Default', 'EdgePushStorageWithConnectTokenAndKey');
            await fs.mkdir(path.dirname(store), { recursive: true });
            const db = new ClassicLevel(store, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
            try { await db.put(Buffer.from('site'), Buffer.concat([field(8, Buffer.concat([field(1, 'origin'), field(2, origin)]))])); }
            finally { await db.close(); }
        }
        const args = { rootPath: profile.rootPath, profileId: profile.profileId, helperPath: helper, expectedSha256: hash };
        const broker = await module.exports.openMacEdgeForSetup(args);
        assert.equal(calls.at(-1), origin === 'https://x.com/');
        await assert.rejects(acquireMacProfileLease({ ...args, browser: 'edge' }), { code: 'X_CHROME_MAC_LEASE_BUSY' });
        await broker.release();
    }
    const ambiguous = await createMacEdgeProfile(base); await fs.mkdir(path.join(ambiguous.profilePath, 'Default'));
    await assert.rejects(module.exports.openMacEdgeForSetup({ rootPath: ambiguous.rootPath, profileId: ambiguous.profileId,
        helperPath: helper, expectedSha256: hash }));
    assert.equal(calls.length, 3);
    const recovered = await acquireMacProfileLease({ rootPath: ambiguous.rootPath, profileId: ambiguous.profileId, browser: 'edge' });
    await releaseMacProfileLease(recovered);
    const failing = await createMacEdgeProfile(base); failPending = true;
    const failingArgs = { rootPath: failing.rootPath, profileId: failing.profileId, helperPath: helper, expectedSha256: hash };
    await assert.rejects(module.exports.openMacEdgeForSetup(failingArgs), { code: 'X_EDGE_MAC_BROKER_CLEANUP_PENDING' });
    await assert.rejects(acquireMacProfileLease({ ...failingArgs, browser: 'edge' }), { code: 'X_CHROME_MAC_LEASE_BUSY' });
    await releasePending();
    const afterFailure = await acquireMacProfileLease({ ...failingArgs, browser: 'edge' }); await releaseMacProfileLease(afterFailure);
});
