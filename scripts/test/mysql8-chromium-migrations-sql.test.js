'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { insertSubscription, encrypted } = require('./helpers/x-push-fixture.cjs');
const { createXPushStore } = require('../../src/automation/x-push-store');
const schema = require('../../src/db_schema');

const port = Number(process.env.AUTOMATION_MIGRATION_TEST_DB_PORT || process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw new Error('Explicit isolated migration database port 33621 or 33622 is required');

test('Chromium migrations preserve Firefox ciphertext, survive replay and fail safely on a real SQL engine', { timeout: 120000 }, async () => {
    const db = await createTestDatabase(port);
    try {
        assert.match(db.schema, /^cbte_automation_test_[0-9a-f]{20}$/);
        const migrationTable = schema.SCHEMA_STATEMENTS.find(sql => /CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(sql));
        await db.queryDatabase(migrationTable);
        const subscription = await insertSubscription(db), store = createXPushStore(db);
        const lease = await store.claim({ ...subscription, workerId: 'migration-compat' });
        const wire = await encrypted(subscription.file, { notificationType: 'tweet', text: 'synthetic-retained' });
        const receipt = await store.recordFrame(lease, { version: 'retained', data: wire.data, headers: wire.headers, status: 'received', ackCode: 100 });
        await store.release(lease);
        const before = (await db.queryDatabase('SELECT sealed_json,revision FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0];
        const inboxBefore = (await db.queryDatabase('SELECT data_ciphertext,headers_json,status FROM automation_x_push_inbox WHERE id=?', [receipt.id]))[0];
        await db.queryDatabase('DROP TABLE automation_x_mcs_pending');
        await db.queryDatabase('ALTER TABLE automation_x_subscriptions DROP COLUMN browser_kind');
        for (const name of ['chrome_checkin_at_ms', 'chrome_checkin_interval_seconds', 'chrome_checkin_revision', 'wns_token_sealed_json', 'wns_token_revision', 'wns_token_generation'])
            await db.queryDatabase(`ALTER TABLE automation_x_push_receivers DROP COLUMN ${name}`);
        const browser = '20261110_add_x_subscription_browser_kind.sql';
        await assert.rejects(schema._internal.applyMigrationFile(async (sql, params, options) => {
            if (/^ALTER\s+TABLE/i.test(sql)) throw Object.assign(new Error('fixture denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            return db.queryDatabase(sql, params, options);
        }, browser), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM schema_migrations'))[0].n), 0);
        await Promise.all([schema._internal.applyMigrationFile(db.queryDatabase, browser), schema._internal.applyMigrationFile(db.queryDatabase, browser)]);
        for (const file of ['20261110_add_chrome_mcs_pending.sql', '20261110_add_chrome_checkin.sql', '20261110_add_wns_token_state.sql', '20261110_allow_chrome_mcs_control_pending.sql']) {
            await schema._internal.applyMigrationFile(db.queryDatabase, file);
            await schema._internal.applyMigrationFile(db.queryDatabase, file);
        }
        const after = (await db.queryDatabase('SELECT browser_kind,sealed_json,revision FROM automation_x_subscriptions WHERE id=?', [subscription.subscriptionId]))[0];
        const inboxAfter = (await db.queryDatabase('SELECT data_ciphertext,headers_json,status FROM automation_x_push_inbox WHERE id=?', [receipt.id]))[0];
        assert.equal(after.browser_kind, 'firefox'); assert.equal(after.sealed_json, before.sealed_json); assert.equal(String(after.revision), String(before.revision));
        assert.deepEqual(inboxAfter, inboxBefore);
        const pending = (await db.queryDatabase('SHOW COLUMNS FROM automation_x_mcs_pending WHERE `Field` = ?', ['inbox_id']))[0];
        assert.equal(pending.Null, 'YES');
        await db.queryDatabase('CREATE TABLE exact_column_probe (browserXkind INT NULL)');
        assert.equal(await schema._internal.shouldSkipMigrationStatement(db.queryDatabase, 'ALTER TABLE exact_column_probe ADD COLUMN browser_kind INT NULL'), false);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM schema_migrations'))[0].n), 5);
    } finally { await db.close(); }
});
