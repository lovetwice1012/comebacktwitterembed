'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMarketplace } = require('../../src/automation/marketplace');
const { newWorkflow } = require('../../src/automation/schema');
const databaseSchema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const author = { userId: '222222222222222222' }, member = { userId: '333333333333333333' }, other = { userId: '444444444444444444' };
const LICENSE = 'CC-BY-SA-4.0';
const input = (name, license = LICENSE) => ({ title: name, description: `Package description: ${name}`, category: 'general', visibility: 'public', rightsConfirmed: true,
    bundle: { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow(name), dictionaries: {}, description: `Attribution: Original Author — ${name}`, license } });

function preparePublicationBundle(bundle, requested) {
    // Exercise the actual ordinary UI preparation rather than copying it into
    // the fixture. No React render or browser/network is needed for this helper.
    const filename = path.resolve(__dirname, '../../dashboard/components/automation/marketplace-manager.tsx'), native = createRequire(filename), mod = { exports: {} };
    const compiled = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
    compileFunction(compiled, ['require', 'module', 'exports'], { filename })(native, mod, mod.exports);
    return mod.exports.preparePublicationBundle(bundle, requested);
}

function fixture(db) {
    const service = createService(db, { rateOptions: { policy: { operations: { write: { minute: 1000, hour: 1000 }, publication: { minute: 1000, hour: 1000 } } } } });
    // Real publication inspection performs the normal metadata/link checks;
    // this local matcher supplies no prohibited terms and sends no requests.
    return { service, market: createMarketplace(db, { service, moderationMatcher: { match: async () => [] } }) };
}

test('S4-4 persisted fork license/provenance survives ordinary revisions without forkOf and upstream withdrawal/private changes', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { market } = fixture(db), originalInput = input('Original'), original = await market.save(author, originalInput);
        const fork = await market.fork(member, original.id, { version: 1 });
        const first = await market.get(member, fork.id);
        const revise = (bundle = first.bundle, extra = {}) => ({ title: 'Edited fork', category: 'general', description: 'My edits', visibility: 'public', rightsConfirmed: true,
            bundle: structuredClone(bundle), expectedVersion: 1, ...extra });
        // This is the ordinary UI's request shape: expectedVersion, form fields
        // and bundle, without forkOf/forkVersion metadata.
        await assert.rejects(market.save(member, revise({ ...first.bundle, license: 'CC0-1.0' }), fork.id), { code: 'FORK_LICENSE' });
        await assert.rejects(market.save(member, revise({ ...first.bundle, license: '' }), fork.id), { code: 'FORK_LICENSE' });
        await assert.rejects(market.save(member, revise(first.bundle, { forkOf: null }), fork.id), { code: 'FORK_SOURCE_IMMUTABLE' });
        const unrelated = await market.save(author, input('Unrelated', 'CC0-1.0'));
        await assert.rejects(market.save(member, revise(first.bundle, { forkOf: unrelated.id }), fork.id), { code: 'FORK_SOURCE_IMMUTABLE' });
        await market.save(author, { ...input('New author edition', 'MIT'), expectedVersion: 1, visibility: 'private' }, original.id);
        await market.setStatus(author, original.id, { status: 'withdrawn', expectedVersion: 2 });
        await assert.rejects(market.get(member, original.id), { status: 404 });
        const revision = await market.save(member, revise({ ...first.bundle, description: '' }), fork.id);
        assert.equal(revision.version, 2);
        const published = await market.get(other, fork.id);
        assert.equal(published.bundle.license, LICENSE); assert.equal(published.fork_of, original.id);
        assert.match(published.bundle.description, /Attribution: Original Author/);
        assert.match(published.bundle.description, /Package description: Original/);
        assert.match(published.bundle.description, new RegExp(original.id));
        assert.match(published.description, /Attribution: Original Author/);
        // A fresh marketplace instance relies entirely on the persisted first
        // edition; neither a cache nor continued access to the parent is needed.
        const reopened = fixture(db).market;
        await assert.rejects(reopened.save(member, { ...revise({ ...published.bundle, license: 'MIT' }), expectedVersion: 2 }, fork.id), { code: 'FORK_LICENSE' });
        await reopened.save(member, { ...revise(published.bundle), expectedVersion: 2, forkOf: original.id, forkVersion: 2 }, fork.id);
        assert.equal((await reopened.get(other, fork.id)).bundle.license, LICENSE, 'Client forkVersion cannot replace the immutable first-fork license');
        const privateSource = await market.save(author, { ...input('Private metadata'), visibility: 'private',
            description: 'https://discord.com/api/webhooks/123456789012345678/synthetic-private-token' });
        await assert.rejects(market.save(author, { ...input('Private copy'), visibility: 'private', forkOf: privateSource.id }), /BUNDLE_CONTAINS_CREDENTIALS/);
    } finally { await db.close(); }
});

test('S4-4 installed workflow export and ordinary UI republication preserve exact source edition metadata and bind the server-known origin', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { service, market } = fixture(db), original = await market.save(author, input('Installed original'));
        const installed = await market.install(member, original.id, { version: 1 });
        const edited = await service.getWorkflow(member, installed.workflow.id);
        await service.updateWorkflow(member, edited.id, { expectedRevision: edited.revision, definition: { ...edited.draft, name: 'Local customization' } });
        await market.save(author, { ...input('Later private edition', 'MIT'), expectedVersion: 1, visibility: 'private' }, original.id);
        await market.setStatus(author, original.id, { status: 'withdrawn', expectedVersion: 2 });
        const exported = await market.exportWorkflow(member, edited.id);
        assert.equal(exported.license, LICENSE); assert.equal(exported.workflow.name, 'Local customization');
        assert.match(exported.description, /Attribution: Original Author — Installed original/);
        assert.match(exported.description, /Package description: Installed original/);
        assert.match(exported.description, new RegExp(`\\(${original.id}\\) v1`));
        assert.doesNotMatch(exported.description, /Later private edition/);
        assert.throws(() => preparePublicationBundle(exported, 'CC0-1.0'), /コピー元のライセンス/);
        const prepared = preparePublicationBundle(exported, '');
        assert.equal(prepared.license, LICENSE); assert.equal(prepared.description, exported.description);
        const republish = { title: 'My adapted copy', description: 'My changes', category: 'general', visibility: 'public', rightsConfirmed: true,
            sourceWorkflowId: edited.id, bundle: prepared };
        await assert.rejects(market.save(member, { ...republish, bundle: { ...prepared, license: 'CC0-1.0' } }), { code: 'FORK_LICENSE' });
        // Even if the client clears export metadata, the real installation row
        // restores its exact licensed source, rather than trusting that client.
        const saved = await market.save(member, { ...republish, bundle: { ...prepared, description: '' } });
        const read = await market.get(other, saved.id);
        assert.equal(read.fork_of, original.id); assert.equal(read.bundle.license, LICENSE);
        assert.match(read.bundle.description, /Installed original/); assert.match(read.bundle.description, /Source:/);
        await assert.rejects(market.exportWorkflow(other, edited.id), { status: 404 });
        await assert.rejects(market.save(other, republish), { status: 404 });
        // Explicit raw imports have no trusted installation identity. Preserve
        // the existing user-owned rights-confirmation publication path.
        const raw = await market.importBundle(member, { ...exported, license: 'MIT' });
        const rawExport = await market.exportWorkflow(member, raw.workflow.id);
        assert.equal(rawExport.license, undefined);
        const rawPublished = await market.save(member, { ...input('User-owned raw import', 'MIT'), sourceWorkflowId: raw.workflow.id });
        assert.equal((await market.get(other, rawPublished.id)).fork_of, null);
    } finally { await db.close(); }
});

test('S4-4 ordinary workflow copies and copies of copies retain trusted installation license and attribution', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { service, market } = fixture(db), original = await market.save(author, input('Copied source'));
        const installed = await market.install(member, original.id, { version: 1 });
        let source = installed.workflow;
        for (const name of ['Ordinary copy', 'Notification-specific copy']) {
            const copy = await service.createWorkflow(member, { sourceWorkflowId: source.id, expectedSourceRevision: source.revision, scope: 'private', definition: { ...source.draft, name }, bindings: source.bindings });
            const exported = await fixture(db).market.exportWorkflow(member, copy.id);
            assert.equal(exported.license, LICENSE); assert.match(exported.description, /Attribution: Original Author/);
            const publication = { ...input(name), sourceWorkflowId: copy.id, bundle: exported };
            await assert.rejects(market.save(member, { ...publication, bundle: { ...exported, license: 'MIT' } }), { code: 'FORK_LICENSE' });
            const saved = await market.save(member, publication);
            assert.equal((await market.get(other, saved.id)).fork_of, original.id);
            source = copy;
        }
        await assert.rejects(service.createWorkflow(other, { sourceWorkflowId: source.id, expectedSourceRevision: source.revision, definition: newWorkflow('foreign copy') }), { status: 404 });
        const local = await service.createWorkflow(member, { definition: newWorkflow('independent') });
        const localCopy = await service.createWorkflow(member, { sourceWorkflowId: local.id, expectedSourceRevision: local.revision, definition: newWorkflow('independent copy') });
        assert.equal((await market.exportWorkflow(member, localCopy.id)).license, undefined);
    } finally { await db.close(); }
});

test('S4-4 source-install changes during publication fail before commit and corrupt source editions never shed their license', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { service, market } = fixture(db), original = await market.save(author, input('Race original'));
        const installed = await market.install(member, original.id, { version: 1 }), exported = await market.exportWorkflow(member, installed.workflow.id);
        await market.save(author, { ...input('Race next edition'), expectedVersion: 1 }, original.id);
        const args = { workflowId: installed.workflow.id, version: 2 }, preview = await market.previewUpdate(member, original.id, args);
        let updated = false;
        const racing = createMarketplace(db, { service, safety: { assertPublication: async () => {
            if (!updated) { updated = true; await market.updateInstall(member, original.id, { ...args, expectedToken: preview.token }); }
            return { decision: 'allow' };
        } } });
        await assert.rejects(racing.save(member, { ...input('Stale publication'), bundle: exported, sourceWorkflowId: installed.workflow.id }), { code: 'REVISION_CONFLICT' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_packages WHERE owner_user_id=?', [member.userId]))[0].n), 0);
        assert.equal(Number((await db.queryDatabase('SELECT version FROM automation_package_installs WHERE workflow_id=?', [installed.workflow.id]))[0].version), 2);
        await db.queryDatabase('UPDATE automation_package_versions SET bundle_gzip=? WHERE package_id=? AND version=2', [Buffer.from('invalid-gzip'), original.id]);
        await assert.rejects(market.exportWorkflow(member, installed.workflow.id), { code: 'BUNDLE_CHECK_FAILED' });
        await assert.rejects(market.save(member, { ...input('Corrupt provenance'), sourceWorkflowId: installed.workflow.id }), { code: 'BUNDLE_CHECK_FAILED' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_packages WHERE owner_user_id=?', [member.userId]))[0].n), 0);
    } finally { await db.close(); }
});

test('S4-4 a stale copy cannot stamp a replacement installation edition onto the older displayed content', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { service, market } = fixture(db), original = await market.save(author, input('Copy baseline'));
        const installed = await market.install(member, original.id, { version: 1 }), old = installed.workflow;
        await market.save(author, { ...input('Replacement edition', 'MIT'), expectedVersion: 1 }, original.id);
        const preview = await market.previewUpdate(member, original.id, { workflowId: old.id, version: 2 });
        await market.updateInstall(member, original.id, { workflowId: old.id, version: 2, expectedToken: preview.token, replaceLocalChanges: true });
        const request = { sourceWorkflowId: old.id, expectedSourceRevision: old.revision, definition: { ...old.draft, name: 'Stale copy' }, bindings: old.bindings };
        const historical = await service.createWorkflow(member, request);
        assert.equal((await market.exportWorkflow(member, historical.id)).license, LICENSE);
        await assert.rejects(service.createWorkflow(member, { ...request, expectedSourceRevision: undefined }), { code: 'REVISION_CONFLICT' });
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_workflows WHERE owner_user_id=?', [member.userId]))[0].n), 2);
        const latest = await service.getWorkflow(member, old.id);
        const current = await service.createWorkflow(member, { ...request, expectedSourceRevision: latest.revision, definition: { ...latest.draft, name: 'Current copy' }, bindings: latest.bindings });
        assert.equal((await market.exportWorkflow(member, current.id)).license, 'MIT');
        const restored = await service.restoreRevision(member, old.id, old.revision, latest.revision);
        assert.equal(restored.revision, 3);
        const restoredExport = await fixture(db).market.exportWorkflow(member, old.id);
        assert.equal(restoredExport.license, LICENSE); assert.match(restoredExport.description, /Copy baseline/); assert.doesNotMatch(restoredExport.description, /Replacement edition/);
        const edited = await service.updateWorkflow(member, old.id, { expectedRevision: 3, definition: { ...old.draft, name: 'Restored and edited' }, bindings: old.bindings });
        assert.equal(edited.revision, 4); assert.equal((await market.exportWorkflow(member, old.id)).license, LICENSE);
        await service.activateWorkflow(member, old.id, { expectedRevision: 4 });
        for (const [revision, enabled] of [[4, false], [5, true]]) {
            const state = await service.setWorkflowState(member, old.id, { expectedRevision: revision, enabled });
            assert.equal(state.revision, revision + 1); assert.equal((await fixture(db).market.exportWorkflow(member, old.id)).license, LICENSE);
            const stateCopy = await service.createWorkflow(member, { sourceWorkflowId: old.id, expectedSourceRevision: state.revision, definition: old.draft, bindings: old.bindings });
            assert.equal((await market.exportWorkflow(member, stateCopy.id)).license, LICENSE);
        }
    } finally { await db.close(); }
});

test('S4-4 built-in editing imports of owned private forks retain server-verified origin and reject foreign packages', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { market } = fixture(db), original = await market.save(author, input('Editable original'));
        const fork = await market.fork(member, original.id, { version: 1 });
        const installed = await market.importForEditing(member, fork.id, { version: fork.version, scope: 'private', origin: { id: 'untrusted' } });
        const exported = await market.exportWorkflow(member, installed.workflow.id);
        assert.equal(exported.license, LICENSE); assert.match(exported.description, /Attribution: Original Author/);
        await assert.rejects(market.save(member, { ...input('Illegal relabel', 'MIT'), sourceWorkflowId: installed.workflow.id }), { code: 'FORK_LICENSE' });
        await assert.rejects(market.importForEditing(other, fork.id, { version: fork.version, scope: 'private' }), { status: 404 });
        await assert.rejects(market.importForEditing(member, fork.id, { scope: 'private' }), { code: 'MARKET_VERSION' });
        const copied = await market.save(member, { ...input('Licensed publication'), bundle: exported, sourceWorkflowId: installed.workflow.id });
        assert.equal((await market.get(other, copied.id)).fork_of, fork.id);
    } finally { await db.close(); }
});

test('S4-4 legacy migration retains unknown editions without guessing and verified operator repair restores export', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    try {
        const { service, market } = fixture(db), original = await market.save(author, input('Legacy v1'));
        const installed = await market.install(member, original.id, { version: 1 }), old = installed.workflow;
        await market.save(author, { ...input('Legacy v2', 'MIT'), expectedVersion: 1 }, original.id);
        const preview = await market.previewUpdate(member, original.id, { workflowId: old.id, version: 2 });
        await market.updateInstall(member, original.id, { workflowId: old.id, version: 2, expectedToken: preview.token, replaceLocalChanges: true });
        await service.restoreRevision(member, old.id, 1, 2);
        const before = await service.getWorkflow(member, old.id);
        await db.queryDatabase('ALTER TABLE automation_revisions DROP COLUMN source_package_id,DROP COLUMN source_package_version');
        await db.queryDatabase(databaseSchema.SCHEMA_STATEMENTS.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')));
        await databaseSchema._internal.applyMigrationFile(db.queryDatabase, '20261016_add_workflow_package_provenance.sql');
        await assert.rejects(market.exportWorkflow(member, old.id), { code: 'WORKFLOW_ORIGIN_REVIEW_REQUIRED' });
        await assert.rejects(service.createWorkflow(member, { sourceWorkflowId: old.id, expectedSourceRevision: before.revision, definition: before.draft, bindings: before.bindings }), { code: 'WORKFLOW_ORIGIN_REVIEW_REQUIRED' });
        assert.deepEqual(await service.getWorkflow(member, old.id), before);
        // Only verified operator records establish the historical edition. The
        // migration never infers it from a current install, name or text.
        await db.queryDatabase('UPDATE automation_revisions SET source_package_version=1 WHERE workflow_id=? AND revision=?', [old.id, before.revision]);
        await databaseSchema._internal.applyMigrationFile(db.queryDatabase, '20261016_add_workflow_package_provenance.sql');
        assert.equal((await fixture(db).market.exportWorkflow(member, old.id)).license, LICENSE);
    } finally { await db.close(); }
});
