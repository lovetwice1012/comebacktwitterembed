'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { createXPushRuntimeFromEnvironment } = require('../../src/automation/x-push-runtime');

test('disabled worker never reads key configuration or queries/connects', async () => {
    const env = new Proxy({}, { get(_target, key) {
        if (key === 'X_NOTIFICATION_RECEIVER_ENABLED') return '0';
        throw new Error('Disabled worker must not read key configuration');
    } });
    const runtime = createXPushRuntimeFromEnvironment(new Proxy({}, { get() { throw new Error('No disabled DB access'); } }), null, { env });
    runtime.start(); assert.equal(runtime.status().enabled, false);
    assert.equal((await runtime.tick()).state, 'disabled'); await runtime.stop();
});

test('opt-in with an invalid key path fails with a fixed safe error', () => {
    assert.throws(() => createXPushRuntimeFromEnvironment({}, null, { env: { X_NOTIFICATION_RECEIVER_ENABLED: '1', X_NOTIFICATION_RECEIVER_KEY_FILE: 'private-relative-path' } }),
        error => error.code === 'X_PUSH_WORKER_KEY_UNAVAILABLE' && !error.message.includes('private-relative-path'));
});

test('worker key file is bounded, private-role only, and defaults to batch without accepting realtime', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-x-key-config-'));
    t.after(() => {
        assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.match(path.basename(directory), /^cbte-x-key-config-/);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const filename = path.join(directory, 'private-fixture.json');
    const env = { X_NOTIFICATION_RECEIVER_ENABLED: '1', X_NOTIFICATION_RECEIVER_KEY_FILE: filename };
    const db = { queryDatabase() { throw new Error('No unconfigured DB access'); }, withDatabaseTransaction() { throw new Error('No unconfigured DB transaction'); } };
    const attempt = () => createXPushRuntimeFromEnvironment(db, null, { env, assertAllowed() { throw new Error('No unconfigured authority check'); } });
    fs.writeFileSync(filename, ' '.repeat(65537), { mode: 0o600 });
    assert.throws(attempt, error => error.code === 'X_PUSH_WORKER_KEY_UNAVAILABLE');
    fs.writeFileSync(filename, '{"activeKeyId":"fixture","privateKeys":{"fixture":"not a private key"}}');
    assert.throws(attempt, error => error.code === 'X_PUSH_WORKER_KEY_UNAVAILABLE' && !error.message.includes('not a private key'));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    fs.writeFileSync(filename, JSON.stringify({ activeKeyId: 'fixture', privateKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } }));
    assert.throws(attempt, error => error.code === 'X_PUSH_WORKER_KEY_UNAVAILABLE');
    fs.writeFileSync(filename, JSON.stringify({ activeKeyId: 'fixture', privateKeys: { fixture: privateKey.export({ type: 'pkcs8', format: 'pem' }) } }));
    const runtime = attempt();
    assert.equal(runtime.status().processingConfigured, true);
    assert.equal(runtime.status().processingPolicy, 'batch');
    await runtime.stop();
    env.X_NOTIFICATION_PROCESSING_POLICY = 'realtime';
    const unsupported = attempt(); unsupported.start();
    assert.equal(unsupported.status().processingConfigured, false);
    assert.equal((await unsupported.tick()).state, 'not_configured'); await unsupported.stop();
});
