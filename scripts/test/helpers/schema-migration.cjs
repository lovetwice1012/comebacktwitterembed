'use strict';
const schema = require('../../../src/db_schema');

// Use the production migration runner, and only against disposable fixtures.
async function applyTestMigration(db, file) {
    if (!/^cbte_automation_test_[0-9a-f]{20}$/.test(db.schema || '')) throw new Error('Disposable fixture schema required');
    const table = schema.SCHEMA_STATEMENTS.find(sql => /CREATE TABLE IF NOT EXISTS schema_migrations\s*\(/.test(sql));
    await db.queryDatabase(table);
    await schema._internal.applyMigrationFile(db.queryDatabase, file);
}
module.exports = { applyTestMigration };
