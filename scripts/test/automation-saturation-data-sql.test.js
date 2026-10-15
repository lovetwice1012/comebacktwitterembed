'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMarketplace } = require('../../src/automation/marketplace');
const { createDictionaryService } = require('../../src/automation/dictionary-service');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createMonitors } = require('../../src/automation/monitors');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { assertPackageSafety } = require('../../src/automation/package-safety');
const { newWorkflow } = require('../../src/automation/schema');
const { dispatch } = require('../../src/automation/api');
const { inspectLegacyDictionaryOrigins } = require('../../src/automation/dictionary-package-provenance');
const databaseSchema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const A = { userId: '222222222222222222' }, B = { userId: '333333333333333333' };
const ADMIN = { userId: '444444444444444444', isAdmin: true };

async function fixture(work) {
    const db = await createTestDatabase(port);
    let evaluator;
    try {
        const service = createService(db, { rateOptions: { policy: { operations: { write: { minute: 10000, hour: 10000 }, monitor: { minute: 10000, hour: 10000 }, publication: { minute: 10000, hour: 10000 } } } } });
        evaluator = createEvaluator(service.dictionaryData);
        const market = createMarketplace(db, { service, evaluator, moderationMatcher: { match: async () => [] } });
        await work({ db, service, market, evaluator });
    } finally { try { await evaluator?.stop(); } finally { await db.close(); } }
}
const dictionary = name => ({ schemaVersion: 1, name, source: 'Synthetic original test data', license: 'CC0-1.0', entries: ['benign-example'] });
const pack = (name, dictionaries, workflow) => ({ title: name, description: 'Synthetic package fixture', visibility: 'public', rightsConfirmed: true,
    bundle: { schemaVersion: 1, kind: workflow ? 'workflow' : 'dictionary', ...(workflow ? { workflow } : {}), dictionaries, license: 'CC0-1.0' } });
const dependencyJob = ref => ({ plan: { dictionaryRefs: { words: ref } } });

test('T5: dictionary origin survives rename, removal, update and local edit/restore while current aliases stay current', { skip: !port }, async () => fixture(async f => {
    const first = await f.market.save(A, pack('source-v1', { original: dictionary('first') }));
    const installed = await f.market.install(B, first.id, { version: 1 });
    const original = installed.dictionaries.original;
    const updated = await f.market.save(A, { ...pack('source-v2', { renamed: dictionary('second') }), expectedVersion: 1 }, first.id);
    const preview = await f.market.previewUpdate(B, first.id, { installId: installed.installId, version: updated.version });
    const next = await f.market.updateInstall(B, first.id, { installId: installed.installId, version: 2, expectedToken: preview.token, replaceLocalChanges: true });
    assert.deepEqual(Object.keys(next.dictionaries), ['renamed']);
    const origins = await f.db.queryDatabase('SELECT source_package_id,source_package_version FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [original.id, original.revision]);
    assert.equal(origins[0].source_package_id, first.id); assert.equal(Number(origins[0].source_package_version), 1);
    await assertPackageSafety(f.db.queryDatabase, dependencyJob(original));
    const edit = await f.service.saveDictionary(B, { expectedRevision: 1, dictionary: dictionary('locally edited') }, original.id);
    const ds = createDictionaryService(f.db, f.service, f.evaluator);
    const restored = await ds.restore(B, original.id, { expectedRevision: edit.revision, revision: 1 });
    assert.equal(Number((await f.db.queryDatabase('SELECT source_package_version FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [restored.id, restored.revision]))[0].source_package_version), 1);
    await f.market.setStatus(ADMIN, first.id, { status: 'revoked', expectedVersion: 2, note: 'Synthetic safety stop' });
    for (const ref of [original, edit, restored, next.dictionaries.renamed]) await assert.rejects(assertPackageSafety(f.db.queryDatabase, dependencyJob(ref)), { code: 'SAFETY_DICTIONARY_REVOKED' });
}));

test('T5: workflow package dictionaries reused by another private rule retain package safety; raw imports cannot forge it', { skip: !port }, async () => fixture(async f => {
    const published = await f.market.save(A, pack('workflow source', { words: dictionary('packaged') }, newWorkflow('source workflow')));
    const installed = await f.market.install(B, published.id, { version: 1 });
    const ref = installed.dictionaries.words;
    const custom = await f.service.createWorkflow(B, { definition: newWorkflow('independent private rule'), bindings: { dictionaries: { words: ref }, destinations: {} } });
    const forged = await f.market.importBundle(B, { schemaVersion: 1, kind: 'dictionary', dictionaries: { words: dictionary('ordinary local') }, license: 'CC0-1.0' }, { origin: { id: published.id, version: 1 } });
    assert.equal((await f.db.queryDatabase('SELECT source_package_id FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=1', [forged.dictionaries.words.id]))[0].source_package_id, null);
    await f.market.setStatus(ADMIN, published.id, { status: 'revoked', expectedVersion: 1, note: 'Synthetic package safety stop' });
    await assert.rejects(assertPackageSafety(f.db.queryDatabase, { workflow_id: custom.id, revision: 1, plan: { dictionaryRefs: {} } }), { code: 'SAFETY_DICTIONARY_REVOKED' });
    await assertPackageSafety(f.db.queryDatabase, dependencyJob(forged.dictionaries.words));
    await assertPackageSafety(f.db.queryDatabase, { plan: { dictionaryRefs: {} } });
}));

test('T5: the real migration backfills only exact recoverable legacy associations and preserves unrelated local dictionaries', { skip: !port }, async () => fixture(async f => {
    const dictPack = await f.market.save(A, pack('legacy dictionary', { words: dictionary('known dictionary') }));
    const dictInstall = await f.market.install(B, dictPack.id, { version: 1 });
    const edited = await f.service.saveDictionary(B, { expectedRevision: 1, dictionary: dictionary('edited before migration') }, dictInstall.dictionaries.words.id);
    const workflowPack = await f.market.save(A, pack('legacy workflow', { words: dictionary('workflow dictionary') }, newWorkflow('legacy source')));
    const workflowInstall = await f.market.install(B, workflowPack.id, { version: 1 });
    const local = await f.service.saveDictionary(B, { dictionary: dictionary('known dictionary') });
    await f.db.queryDatabase('ALTER TABLE automation_dictionary_revisions DROP COLUMN source_package_id,DROP COLUMN source_package_version,DROP COLUMN origin_reviewed');
    const sql = readFileSync(join(__dirname, '../../migrations/20261016_add_dictionary_package_provenance.sql'), 'utf8');
    const statements = databaseSchema._internal.splitSqlStatements(sql);
    assert.deepEqual((await inspectLegacyDictionaryOrigins(f.db.queryDatabase)).dictionaryIds, [local.id]);
    await assert.rejects(databaseSchema._internal.applyMigrationFile(f.db.queryDatabase, '20261016_add_dictionary_package_provenance.sql'), { code: 'DB_MIGRATION_DICTIONARY_ORIGIN_REVIEW_REQUIRED' });
    // Explicit operator classification: this fixture's separate dictionary is
    // independently authored. Neither contents nor timestamps infer that fact.
    for (const statement of statements.slice(0, 3)) await f.db.queryDatabase(statement);
    await f.db.queryDatabase('UPDATE automation_dictionary_revisions SET origin_reviewed=1 WHERE dictionary_id=?', [local.id]);
    await f.db.queryDatabase(databaseSchema.SCHEMA_STATEMENTS.find(statement => statement.includes('CREATE TABLE IF NOT EXISTS schema_migrations')));
    await databaseSchema._internal.applyMigrationFile(f.db.queryDatabase, '20261016_add_dictionary_package_provenance.sql');
    const origin = async ref => (await f.db.queryDatabase('SELECT source_package_id,source_package_version FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [ref.id, ref.revision]))[0];
    assert.equal((await origin(dictInstall.dictionaries.words)).source_package_id, dictPack.id);
    assert.equal(Number((await origin(dictInstall.dictionaries.words)).source_package_version), 1);
    assert.equal((await origin(edited)).source_package_id, dictPack.id);
    assert.equal((await origin(edited)).source_package_version, null, 'derived legacy revisions preserve known identity without inventing an edition');
    assert.equal((await origin(workflowInstall.dictionaries.words)).source_package_id, workflowPack.id);
    assert.equal((await origin(workflowInstall.dictionaries.words)).source_package_version, null, 'an unavailable original package version is never invented');
    assert.equal((await origin(local)).source_package_id, null, 'similar local dictionary contents do not prove a package origin');
    await f.market.setStatus(ADMIN, workflowPack.id, { status: 'revoked', expectedVersion: 1, note: 'Synthetic legacy source stop' });
    await assert.rejects(assertPackageSafety(f.db.queryDatabase, dependencyJob(workflowInstall.dictionaries.words)), { code: 'SAFETY_DICTIONARY_REVOKED' });
    await assertPackageSafety(f.db.queryDatabase, dependencyJob(local));
    const changed = await f.market.save(A, { ...pack('renamed after migration', { renamed: dictionary('new edition') }), expectedVersion: 1 }, dictPack.id);
    const preview = await f.market.previewUpdate(B, changed.id, { installId: dictInstall.installId, version: 2 });
    await f.market.updateInstall(B, changed.id, { installId: dictInstall.installId, version: 2, expectedToken: preview.token, replaceLocalChanges: true });
    await f.market.setStatus(ADMIN, dictPack.id, { status: 'revoked', expectedVersion: 2, note: 'Synthetic derived legacy stop' });
    await assert.rejects(assertPackageSafety(f.db.queryDatabase, dependencyJob(edited)), { code: 'SAFETY_DICTIONARY_REVOKED' });
}));

test('T5: irrecoverable legacy workflow-update origins stop the migration before DDL until explicitly reviewed', { skip: !port }, async () => fixture(async f => {
    const first = await f.market.save(A, pack('old workflow source', { words: dictionary('old dictionary') }, newWorkflow('first source')));
    const installed = await f.market.install(B, first.id, { version: 1 });
    await f.market.save(A, { ...pack('updated workflow source', { words: dictionary('new dictionary') }, newWorkflow('second source')), expectedVersion: 1 }, first.id);
    const preview = await f.market.previewUpdate(B, first.id, { workflowId: installed.workflow.id, version: 2 });
    const updated = await f.market.updateInstall(B, first.id, { workflowId: installed.workflow.id, version: 2, expectedToken: preview.token, replaceLocalChanges: true });
    await f.db.queryDatabase('ALTER TABLE automation_dictionary_revisions DROP COLUMN source_package_id,DROP COLUMN source_package_version,DROP COLUMN origin_reviewed');
    assert.deepEqual((await inspectLegacyDictionaryOrigins(f.db.queryDatabase)).dictionaryIds, [updated.dictionaries.words.id]);
    await assert.rejects(databaseSchema._internal.applyMigrationFile(f.db.queryDatabase, '20261016_add_dictionary_package_provenance.sql'), { code: 'DB_MIGRATION_DICTIONARY_ORIGIN_REVIEW_REQUIRED' });
    assert.equal((await f.db.queryDatabase("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='automation_dictionary_revisions' AND COLUMN_NAME='source_package_id'"))[0].n, '0');
    const sql = readFileSync(join(__dirname, '../../migrations/20261016_add_dictionary_package_provenance.sql'), 'utf8');
    for (const statement of databaseSchema._internal.splitSqlStatements(sql).slice(0, 3)) await f.db.queryDatabase(statement);
    // Recovery uses external, verified source records supplied by the operator.
    await f.db.queryDatabase('UPDATE automation_dictionary_revisions SET source_package_id=?,source_package_version=2,origin_reviewed=1 WHERE dictionary_id=? AND revision=?', [first.id, updated.dictionaries.words.id, updated.dictionaries.words.revision]);
    await f.db.queryDatabase(databaseSchema.SCHEMA_STATEMENTS.find(statement => statement.includes('CREATE TABLE IF NOT EXISTS schema_migrations')));
    await databaseSchema._internal.applyMigrationFile(f.db.queryDatabase, '20261016_add_dictionary_package_provenance.sql');
    assert.equal((await inspectLegacyDictionaryOrigins(f.db.queryDatabase)).ready, true);
    await f.market.setStatus(ADMIN, first.id, { status: 'revoked', expectedVersion: 2, note: 'Synthetic recovered legacy stop' });
    await assert.rejects(assertPackageSafety(f.db.queryDatabase, dependencyJob(updated.dictionaries.words)), { code: 'SAFETY_DICTIONARY_REVOKED' });
}));

async function target(f, kind = 'auto') {
    await f.db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [B.userId]);
    const table = kind === 'auto' ? 'auto_watch' : 'price_watch';
    const key = randomUUID();
    const source = kind === 'auto'
        ? await f.db.queryDatabase("INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES ('github',?,'https://github.com/synthetic/saturation',3600000,0)", [key])
        : await f.db.queryDatabase("INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,created_at_ms) VALUES ('steam',?,'https://store.steampowered.com/app/620/','ja',3600000,0)", [key]);
    const extra = kind === 'price' ? ",watch_mode,rule_key" : '';
    const values = kind === 'price' ? ",'change','synthetic'" : '';
    const inserted = await f.db.queryDatabase(`INSERT INTO ${table}_targets (source_id,user_id,destination_type,destination_key,enabled,created_at_ms${extra}) VALUES (?,?,'dm',?,1,0${values})`, [source.insertId, B.userId, `dm:${B.userId}`]);
    return String(inserted.insertId);
}

test('T11: legacy attach and detach also advance monitor CAS and reject stale destructive edits', { skip: !port }, async () => fixture(async f => {
    const id = await target(f), one = await f.service.createWorkflow(B, { definition: newWorkflow('one') }), two = await f.service.createWorkflow(B, { definition: newWorkflow('two') });
    assert.equal((await f.service.attach(B, one.id, 'auto', id)).revision, 2);
    assert.equal((await f.service.attach(B, two.id, 'auto', id)).revision, 3);
    const monitors = createMonitors(f.db, f.service, {});
    await assert.rejects(monitors.detach(B, 'auto', id, 1), { code: 'REVISION_CONFLICT' });
    assert.equal((await f.db.queryDatabase("SELECT workflow_id FROM automation_assignments WHERE target_kind='auto' AND target_id=?", [id]))[0].workflow_id, two.id);
    assert.equal((await monitors.detach(B, 'auto', id, 3)).revision, 4);
}));

test('S7-3/S20-1: activation preview covers X and native consumers and rejects a changed set atomically', { skip: !port }, async () => fixture(async f => {
    const workflow = await f.service.createWorkflow(B, { definition: newWorkflow('all notification consumers') });
    const autoId = await target(f); await f.service.attach(B, workflow.id, 'auto', autoId);
    const quota = createXMonitorQuota(f.db, { registrationEnabled: true, rolloutMode: 'public' });
    await quota.register(B, { accountHandle: 'consumer', notificationSettings: { workflowId: workflow.id } });
    const preview = await f.service.activationPreview(B, workflow.id);
    assert.deepEqual(preview.affectedTargets.map(row => row.kind), ['auto', 'x']);
    await assert.rejects(dispatch({ method: 'POST', path: ['workflows', workflow.id, 'activate'], body: { expectedRevision: 1 } }, B, f), { code: 'WORKFLOW_TARGETS_CHANGED' });
    const next = await target(f, 'price'); await f.service.attach(B, workflow.id, 'price', next);
    await assert.rejects(f.service.activateWorkflow(B, workflow.id, { expectedRevision: 1, expectedTargetsToken: preview.expectedTargetsToken }, { requireTargetsToken: true }), { code: 'WORKFLOW_TARGETS_CHANGED' });
    assert.equal((await f.service.getWorkflow(B, workflow.id)).activeRevision, null);
    const latest = await f.service.activationPreview(B, workflow.id);
    const visible = await dispatch({ method: 'GET', path: ['workflows', workflow.id, 'activation-preview'] }, B, f);
    assert.deepEqual(visible, latest);
    assert.equal((await dispatch({ method: 'POST', path: ['workflows', workflow.id, 'activate'], body: { expectedRevision: 1, expectedTargetsToken: latest.expectedTargetsToken } }, B, f)).enabled, true);
    await assert.rejects(f.service.activationPreview(A, workflow.id), { status: 404 });
}));

test('S20-2: a repeated X registration is idempotent only for the same explicitly supplied configuration', { skip: !port }, async () => fixture(async f => {
    const quota = createXMonitorQuota(f.db, { registrationEnabled: true, rolloutMode: 'public' });
    const initial = { accountHandle: 'same', name: 'first label', processingMode: 'batch' };
    const first = await quota.register(B, initial);
    assert.equal((await quota.register(B, initial)).id, first.id);
    await assert.rejects(quota.register(B, { ...initial, name: 'changed label' }), { code: 'X_MONITOR_REGISTRATION_CONFLICT' });
    const rule = await f.service.createWorkflow(B, { definition: newWorkflow('different rule') });
    await assert.rejects(quota.register(B, { ...initial, notificationSettings: { workflowId: rule.id } }), { code: 'X_MONITOR_REGISTRATION_CONFLICT' });
    assert.equal((await quota.list(B)).items[0].name, initial.name);
}));
