'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const { splitSqlStatements, shouldSkipMigrationStatement } = require('../../src/db_schema')._internal;
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('Square payment interval migration preserves legacy bindings and unknown request identity on repeated and fresh-schema application', { skip: !port, timeout: 30000 }, async () => {
    const db = await createTestDatabase(port);
    const migration = fs.readFileSync(path.join(__dirname, '../../migrations/20261014_add_square_payment_intervals.sql'), 'utf8');
    const apply = async () => { for (const sql of splitSqlStatements(migration)) if (!await shouldSkipMigrationStatement(db.queryDatabase, sql)) await db.queryDatabase(sql); };
    const adminId = '444444444444444444';
    try {
        await apply(); await apply();
        await db.queryDatabase('ALTER TABLE automation_square_bindings DROP PRIMARY KEY, ADD PRIMARY KEY (plan_id,environment,merchant_id)');
        await db.queryDatabase('ALTER TABLE automation_square_catalog_creations DROP INDEX unique_square_catalog_plan, ADD UNIQUE KEY unique_square_catalog_plan (environment,merchant_id,plan_id), DROP COLUMN cadence');
        const fields = ['legacy', 'sandbox', 'MERCHANT', 'LEGACY-VAR', 0, 'Legacy annual', 'ANNUAL', 12000, 'JPY', '17', 123, adminId];
        const insertBinding = 'INSERT INTO automation_square_bindings (plan_id,environment,merchant_id,variation_id,enabled,catalog_name,cadence,amount,currency,catalog_version,verified_at_ms,actor_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
        await db.queryDatabase(insertBinding, fields);
        const id = '11111111-2222-4333-8444-555555555555', terms = JSON.stringify({ planId: 'pending', name: 'Pending monthly', cadence: 'MONTHLY', amount: 1000, currency: 'JPY' });
        const frozenRequest = JSON.stringify({ idempotency_key: id, object: { id: '#plan-' + id } });
        await db.queryDatabase('INSERT INTO automation_square_catalog_creations (id,environment,merchant_id,plan_id,terms_json,request_json,state,variation_id,lease_token,lease_until_at_ms,expires_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, 'sandbox', 'MERCHANT', 'pending', terms, frozenRequest, 'UNKNOWN', 'CREATED-BUT-UNCONFIRMED', id, 700, 800, 500, 600]);
        const binding = (await db.queryDatabase('SELECT * FROM automation_square_bindings'))[0], creation = (await db.queryDatabase('SELECT * FROM automation_square_catalog_creations'))[0];
        for (let repeat = 0; repeat < 2; repeat++) {
            await apply();
            assert.deepEqual((await db.queryDatabase('SELECT * FROM automation_square_bindings'))[0], binding);
            const migrated = (await db.queryDatabase('SELECT * FROM automation_square_catalog_creations'))[0];
            assert.equal(migrated.cadence, 'MONTHLY'); delete migrated.cadence; assert.deepEqual(migrated, creation);
        }
        const primary = await db.queryDatabase("SHOW INDEX FROM automation_square_bindings WHERE Key_name='PRIMARY'");
        assert.deepEqual(primary.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(item => item.Column_name), ['plan_id', 'environment', 'merchant_id', 'cadence']);
        const unique = await db.queryDatabase("SHOW INDEX FROM automation_square_catalog_creations WHERE Key_name='unique_square_catalog_plan'");
        assert.deepEqual(unique.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(item => item.Column_name), ['environment', 'merchant_id', 'plan_id', 'cadence']);
        await db.queryDatabase(insertBinding, [...fields.slice(0, 3), 'MONTHLY-VAR', 1, 'Legacy monthly', 'MONTHLY', 1200, 'JPY', '18', 124, adminId]);
        assert.equal((await db.queryDatabase("SELECT * FROM automation_square_bindings WHERE plan_id='legacy'")).length, 2);
    } finally { await db.close(); }
});
