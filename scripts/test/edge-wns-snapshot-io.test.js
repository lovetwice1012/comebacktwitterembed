'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createECDH, generateKeyPairSync, randomBytes } = require('node:crypto');
const { ClassicLevel } = require('classic-level');
const { readEdgeSnapshot } = require('../../src/automation/edge-wns-snapshot-io');
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
