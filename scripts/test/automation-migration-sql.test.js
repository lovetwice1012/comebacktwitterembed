'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { newWorkflow } = require('../../src/automation/schema');
const { createMarketplace } = require('../../src/automation/marketplace');
const { splitSqlStatements, shouldSkipMigrationStatement } = require('../../src/db_schema')._internal;
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL migration preserves early rows, fails closed for unreviewed old editions, and is idempotent', { skip: !port, timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), query = db.queryDatabase, owner = { userId: '222222222222222222' }, viewer = { userId: '333333333333333333' }, admin = { userId: '444444444444444444', isAdmin: true };
    try {
        const service = createService(db), rule = await service.createWorkflow(owner, { definition: newWorkflow('旧ルール') });
        await service.activateWorkflow(owner, rule.id, { expectedRevision: 1 });
        // Only this test's freshly-created disposable schema is changed.
        await query('ALTER TABLE automation_runs DROP COLUMN owner_user_id, DROP COLUMN guild_id, DROP COLUMN scope');
        await query('ALTER TABLE automation_runs MODIFY COLUMN workflow_id CHAR(36) NOT NULL, MODIFY COLUMN revision INT UNSIGNED NOT NULL');
        await query('ALTER TABLE automation_jobs DROP INDEX idx_automation_job_group, DROP INDEX idx_automation_job_parent, DROP COLUMN group_key, DROP COLUMN parent_job_id');
        await query('ALTER TABLE automation_packages DROP COLUMN published_version');
        await query('ALTER TABLE automation_package_versions DROP COLUMN title,DROP COLUMN description,DROP COLUMN category,DROP COLUMN visibility,DROP COLUMN status,DROP COLUMN review_note');
        const runId = randomUUID();
        await query('INSERT INTO automation_runs (id,dedupe_key,workflow_id,revision,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,1,\'auto\',77,\'{}\',\'[]\',\'queued\',1000)', [runId, hash(runId), rule.id]);
        const packageId = randomUUID(), bundle = { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow('以前の版'), dictionaries: {}, license: 'CC0-1.0' }, bytes = Buffer.from(JSON.stringify(bundle));
        await query('INSERT INTO automation_packages (id,owner_user_id,title,description,category,kind,visibility,status,share_key,latest_version,created_at_ms,updated_at_ms) VALUES (?,?,\'以前の公開\',\'説明\',\'general\',\'workflow\',\'public\',\'active\',?,2,1000,1000)', [packageId, owner.userId, 'a'.repeat(64)]);
        for (const version of [1, 2]) await query('INSERT INTO automation_package_versions (package_id,version,bundle_gzip,checksum,changelog,created_at_ms) VALUES (?,?,?,?,\'\',1000)', [packageId, version, gzipSync(bytes), hash(bytes)]);
        const migration = fs.readFileSync(path.join(__dirname, '../../migrations/20260922_upgrade_automation_runtime_and_marketplace.sql'), 'utf8');
        for (let pass = 0; pass < 2; pass++) for (const statement of splitSqlStatements(migration)) if (!await shouldSkipMigrationStatement(query, statement)) await query(statement);
        const migrated = (await query('SELECT * FROM automation_runs WHERE id=?', [runId]))[0];
        assert.equal(migrated.owner_user_id, owner.userId); assert.equal(migrated.scope, 'private'); assert.equal(Number(migrated.created_at_ms), 1000);
        const rows = await query('SELECT version,visibility,status FROM automation_package_versions WHERE package_id=? ORDER BY version', [packageId]);
        assert.equal(rows[0].status, 'legacy_unreviewed'); assert.equal(rows[0].visibility, 'private'); assert.equal(rows[1].status, 'active');
        const market = createMarketplace(db);
        assert.equal((await market.get(viewer, packageId)).version, 2);
        await assert.rejects(market.get(viewer, packageId, 1), { status: 404 }); await assert.rejects(market.get(admin, packageId, 1), { status: 404 });
        assert.equal((await market.get(owner, packageId, 1)).version, 1);
        assert.equal((await service.getWorkflow(owner, rule.id)).activeRevision, 1);
        assert.equal(Number((await query('SELECT COUNT(*) AS n FROM automation_runs'))[0].n), 1);
    } finally { await db.close(); }
});
