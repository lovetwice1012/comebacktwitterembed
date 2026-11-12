'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createECDH, randomBytes } = require('node:crypto');
const { writeExperimentalMacEdgeExport } = require('../../src/automation/edge-mac-private-export');
const { parseTransferFile } = require('../../src/automation/x-setup-transfer');
const b64 = bytes => bytes.toString('base64url');
function fixture() {
    const key = createECDH('prime256v1'); key.generateKeys(); const pub = key.getPublicKey();
    const app = createECDH('prime256v1'); app.generateKeys();
    return { format: 'x-notification-subscription', version: 3,
        provenance: { kind: 'edge-wns', adapterVersion: '1.0.0', browserVersion: '157.0.1.2', readMethod: 'edge-wns-snapshot' },
        push: { scope: 'https://x.com/', siteChannel: 'site-1', deviceKey: b64(randomBytes(32)), reconnectToken: 'synthetic-token',
            agent: { os: 'SyntheticOS', osVersion: '1', architecture: 'synthetic64', locale: 'ja-JP' },
            client: { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' },
            p256dhPublicKey: b64(pub), authenticationSecret: b64(randomBytes(16)),
            p256dhPrivateKey: { kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)),
                d: b64(Buffer.from(key.getPrivateKey().toString('hex').padStart(64, '0'), 'hex')) }, applicationServerKey: b64(app.getPublicKey()) } };
}

test('experimental Edge output requires consent for other or unclassified records and never overwrites', { skip: process.platform === 'win32' }, async t => {
    const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'cbte-edge-mac-output-'));
    t.after(async () => {
        const real = await fs.realpath(base); assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^cbte-edge-mac-output-/); await fs.rm(real, { recursive: true });
    });
    const file = fixture(), options = { directory: base, filename: 'notifications.json', file, confirmed: true, experimental: true,
        otherSubscriptionCount: 0, unclassifiedRecordCount: 1, otherNotificationsPossible: true, otherSitesConsent: true };
    for (const change of [{ experimental: false }, { confirmed: false }, { otherSitesConsent: false },
        { otherNotificationsPossible: false }, { unclassifiedRecordCount: -1 }, { unclassifiedRecordCount: 128 },
        { otherSubscriptionCount: 128 }, { file: { ...file, version: 2 } }, { filename: '../escape' }])
        await assert.rejects(writeExperimentalMacEdgeExport({ ...options, ...change }), { code: 'X_EDGE_MAC_EXPORT_INVALID' });
    assert.deepEqual(await fs.readdir(base), []);
    const race = await Promise.allSettled([writeExperimentalMacEdgeExport(options), writeExperimentalMacEdgeExport(options)]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected' && result.reason.code === 'X_EDGE_MAC_EXPORT_EXISTS').length, 1);
    const saved = race.find(result => result.status === 'fulfilled').value;
    assert.equal(saved.uploaded, false); assert.equal(saved.encrypted, false);
    const filename = path.join(base, options.filename), stat = await fs.stat(filename);
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
    assert.deepEqual(parseTransferFile(await fs.readFile(filename, 'utf8')), file);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(writeExperimentalMacEdgeExport({ ...options, filename: 'cancelled.json', signal: controller.signal }), { code: 'X_EDGE_MAC_EXPORT_CANCELLED' });
    await assert.rejects(fs.access(path.join(base, 'cancelled.json')), { code: 'ENOENT' });
    const normal = { ...options, filename: 'normal.json', unclassifiedRecordCount: 0, otherNotificationsPossible: false, otherSitesConsent: false };
    assert.equal((await writeExperimentalMacEdgeExport(normal)).uploaded, false);
});
