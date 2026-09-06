'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertAllowed } = require('../../src/recoveryLease');

test('unmanaged development remains explicit while managed workloads need a current matching lease', () => {
    assert.equal(assertAllowed({}), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-lease-test-'));
    const filename = path.join(dir, 'lease.json');
    const env = { CBTE_FLEET_LEASE_FILE: filename, CBTE_FLEET_NODE: 'primary', CBTE_FLEET_EPOCH: '3' };
    const lease = { state: 'active', node: 'primary', epoch: 3, validUntilUnixMs: 2000 };
    try {
        assert.throws(() => assertAllowed(env, 1000), { code: 'FLEET_LEASE_INVALID' });
        for (const state of ['active', 'renewal_unconfirmed']) {
            fs.writeFileSync(filename, JSON.stringify({ ...lease, state }));
            assert.equal(assertAllowed(env, 1000).epoch, 3);
        }
        for (const change of [{ state: 'standby' }, { node: 'oci' }, { epoch: 4 }, { validUntilUnixMs: 999 }]) {
            fs.writeFileSync(filename, JSON.stringify({ ...lease, ...change }));
            assert.throws(() => assertAllowed(env, 1000), { code: 'FLEET_LEASE_INVALID' });
        }
        fs.writeFileSync(filename, '{incomplete');
        assert.throws(() => assertAllowed(env, 1000), { code: 'FLEET_LEASE_INVALID' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an independent admin worker refuses a mutation before schema or transaction work when the lease is missing', async () => {
    const old = { file: process.env.CBTE_FLEET_LEASE_FILE, node: process.env.CBTE_FLEET_NODE, epoch: process.env.CBTE_FLEET_EPOCH };
    process.env.CBTE_FLEET_LEASE_FILE = path.join(os.tmpdir(), 'cbte-never-created-' + Date.now());
    process.env.CBTE_FLEET_NODE = 'primary';
    process.env.CBTE_FLEET_EPOCH = '3';
    const schema = require('../../src/db_schema');
    const original = schema.ensureDatabaseSchema;
    let schemaCalls = 0;
    schema.ensureDatabaseSchema = async () => { schemaCalls++; throw new Error('Must not reach DB'); };
    try {
        await assert.rejects(require('../../src/adminSupport/worker').execute({ type: 'settings.change', input: {} }), { code: 'FLEET_LEASE_INVALID' });
        assert.equal(schemaCalls, 0);
    } finally {
        schema.ensureDatabaseSchema = original;
        for (const [key, value] of [['CBTE_FLEET_LEASE_FILE', old.file], ['CBTE_FLEET_NODE', old.node], ['CBTE_FLEET_EPOCH', old.epoch]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});
