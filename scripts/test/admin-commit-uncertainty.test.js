'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function simulate({ code = 'ECONNRESET', connectFailure = false, committed = false, receiptReadFailure = false, existingReceipt = false } = {}) {
    const dbPath = require.resolve('../../src/db');
    const schemaPath = require.resolve('../../src/db_schema');
    const operationsPath = require.resolve('../../src/adminSupport/operations');
    const workerPath = require.resolve('../../src/adminSupport/worker');
    const schema = require(schemaPath);
    const original = new Map([dbPath, schemaPath, operationsPath, workerPath].map(key => [key, require.cache[key]]));
    const request = { actionId: 'fixture-transaction', type: 'settings.change', input: { guildId: '123456789012345678', providerId: 'twitter', key: 'enabled', value: true, expectedHash: 'fixture' } };
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ type: request.type, input: request.input })).digest('hex');
    const result = { settings: { enabled: true }, hash: 'new-fixture-hash' };
    let callbacks = 0, receiptReads = 0, mutations = 0;
    const transportError = Object.assign(new Error(connectFailure ? 'Connection unavailable' : 'Commit acknowledgement lost'), { code });
    require.cache[schemaPath] = { id: schemaPath, filename: schemaPath, loaded: true, exports: { ...schema, ensureDatabaseSchema: async () => {} } };
    require.cache[operationsPath] = { id: operationsPath, filename: operationsPath, loaded: true, exports: { settingAction: async () => { mutations++; return result; } } };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
        withDatabaseTransaction: async work => {
            if (connectFailure) throw transportError;
            callbacks++;
            await work(async sql => sql.startsWith('SELECT *') ? [{ input_hash: inputHash, action_type: request.type, result_json: existingReceipt ? JSON.stringify(result) : null }] : []);
            throw transportError;
        },
        queryDatabase: async (sql, values, options) => {
            receiptReads++;
            assert.match(sql, /LOCK IN SHARE MODE/);
            assert.deepEqual(values, [request.actionId]);
            assert.equal(options.timeoutMs, 5000);
            if (receiptReadFailure) throw Object.assign(new Error('Receipt database unavailable'), { code: 'ECONNREFUSED' });
            return committed ? [{ input_hash: inputHash, action_type: request.type, result_json: JSON.stringify(result) }] : [];
        },
    } };
    delete require.cache[workerPath];
    try {
        let value, error;
        try { value = await require(workerPath).execute(request); } catch (cause) { error = cause; }
        return { value, error, callbacks, receiptReads, mutations };
    } finally {
        for (const [key, module] of original) { if (module) require.cache[key] = module; else delete require.cache[key]; }
    }
}

test('COMMIT transport loss is reconciled to a confirmed durable receipt without rerunning the mutation', async () => {
    const result = await simulate({ committed: true });
    assert.equal(result.error, undefined);
    assert.equal(result.value.reconciledAfterCommitError, true);
    assert.equal(result.value.settings.enabled, true);
    assert.equal(result.value.commitError.code, 'ECONNRESET');
    assert.equal(result.callbacks, 1);
    assert.equal(result.receiptReads, 1);
});
test('COMMIT transport loss with missing or unreadable receipt remains unknown and preserves original error', async () => {
    for (const receiptReadFailure of [false, true]) {
        const result = await simulate({ receiptReadFailure });
        assert.equal(result.error.code, 'ACTION_OUTCOME_UNKNOWN');
        assert.equal(result.error.originalError.code, 'ECONNRESET');
        assert.equal(result.error.reconciliation.status, receiptReadFailure ? 'receipt_lookup_failed' : 'receipt_not_observed');
        assert.equal(result.callbacks, 1);
    }
});
test('an already committed receipt remains authoritative if its read-only transaction loses COMMIT acknowledgement', async () => {
    const result = await simulate({ existingReceipt: true });
    assert.equal(result.value.replayedReceipt, true);
    assert.equal(result.value.reconciledAfterCommitError, true);
    assert.equal(result.mutations, 0);
    assert.equal(result.receiptReads, 0);
});
test('connection failures before transaction and explicit SQL rejection remain ordinary failures', async () => {
    const connect = await simulate({ connectFailure: true, code: 'ECONNREFUSED' });
    assert.equal(connect.error.code, 'ECONNREFUSED');
    assert.equal(connect.callbacks, 0);
    assert.equal(connect.receiptReads, 0);
    const rejected = await simulate({ code: 'ER_LOCK_DEADLOCK' });
    assert.equal(rejected.error.code, 'ER_LOCK_DEADLOCK');
    assert.equal(rejected.receiptReads, 0);
});
