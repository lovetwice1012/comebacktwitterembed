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
