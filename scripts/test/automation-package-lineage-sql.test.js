'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMarketplace } = require('../../src/automation/marketplace');
const { newWorkflow } = require('../../src/automation/schema');
const { assertPackageSafety } = require('../../src/automation/package-safety');
const { validateBundle, encodeBundle, decodeBundle } = require('../../src/automation/bundle');
const schema = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const A = { userId: '239111111111111111' }, B = { userId: '239222222222222222' }, C = { userId: '239333333333333333' };
const dictionary = () => ({ schemaVersion: 1, name: 'Identical inner dictionary', mode: 'contains', source: 'Same inner author', license: 'CC0-1.0', entries: ['alpha'] });
const packageInput = (name, license = 'CC-BY-SA-4.0') => ({ title: name, description: `${name} outer attribution`, category: 'general', visibility: 'public', rightsConfirmed: true, bundle: { schemaVersion: 1, kind: 'dictionary', dictionaries: { words: dictionary() }, license, description: `${name} original author notice` } });
const job = (...refs) => ({ plan: { dictionaryRefs: Object.fromEntries(refs.map((ref, index) => [`ref${index}`, ref])) } });
function lookupRule(aliases) {
    const rule = newWorkflow('Local rule with independently licensed dictionaries'), start = rule.nodes.find(row => row.type === 'start'), send = rule.nodes.find(row => row.type === 'send');
    rule.nodes = [start, ...aliases.map((alias, index) => ({ id: `lookup${index}`, type: 'dictionary', config: { dictionary: alias, fields: ['title'] } })), send];
    rule.edges = aliases.length ? [{ id: 'initial', source: start.id, port: 'out', target: 'lookup0' }, ...aliases.map((_, index) => ({ id: `edge${index}`, source: `lookup${index}`, port: 'no', target: index + 1 < aliases.length ? `lookup${index + 1}` : send.id }))] : rule.edges;
    return rule;
}
const entries = info => Object.values(info.dependencies?.dictionaries || {}).flat();

test('exact per-dictionary package lineage survives normal workflows, independent licenses, copies and official updates', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), q = db.queryDatabase; t.after(() => db.close());
    const service = createService(db, { rateLimiter: { consumeOperation: async () => {} } }), market = createMarketplace(db, { service, moderationMatcher: { match: async () => [] } });
    async function install(name, license = 'CC-BY-SA-4.0') { const pack = await market.save(A, packageInput(name, license)), imported = await market.install(B, pack.id, { version: 1 }); return { pack, ref: imported.dictionaries.words }; }
    async function workflow(refs, used = Object.keys(refs)) { return service.createWorkflow(B, { definition: lookupRule(used), bindings: { dictionaries: refs } }); }
    const publish = (workflowId, bundle, extra = {}) => market.save(B, { title: 'Authored workflow wrapper', description: '', visibility: 'public', rightsConfirmed: true, sourceWorkflowId: workflowId, bundle: { ...bundle, license: 'MIT' }, ...extra });
    const content = ref => q('SELECT data_gzip,checksum FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [ref.id, ref.revision]);
    await t.test('normal workflow publication preserves each independently sourced outer license and optional live dictionaries while pruning removed unused bindings', async () => {
        const one = await install('A package'), two = await install('B package', 'GPL-3.0-only'), removed = await service.saveDictionary(B, { dictionary: dictionary() });
        const local = await workflow({ first: one.ref, second: two.ref, optional: one.ref, removed }, ['first', 'second']);
        await service.remove('dictionary', B, removed.id, 1); const before = await content(one.ref);
        const info = await market.exportWorkflowPublication(B, local.id), exported = info.bundle; assert.equal(exported.license, undefined); assert.deepEqual(Object.keys(exported.dictionaries), ['first', 'second', 'optional']);
        assert.equal(info.dependencies.dictionaries.first[0].packageId, one.pack.id); assert.equal(info.dependencies.dictionaries.first[0].license, 'CC-BY-SA-4.0'); assert.equal(info.dependencies.dictionaries.second[0].license, 'GPL-3.0-only'); assert.match(info.dependencies.dictionaries.second[0].description, /B package original author notice/);
        const saved = await publish(local.id, exported), read = await market.get(C, saved.id);
        assert.equal(read.fork_of, null); assert.equal(read.bundle.license, 'MIT'); assert.equal(entries(read).length, 3); assert.deepEqual(await content(one.ref), before);
        assert.deepEqual(decodeBundle(encodeBundle(read.bundle)), read.bundle); assert.equal(read.bundle.dependencies, undefined);
        for (const value of ['CC-BY-SA-4.0', 'GPL-3.0-only', 'A package original author notice', 'B package original author notice']) assert(read.bundle.description.includes(value));
    });
    await t.test('two identical inner dictionaries with different origins cannot be guessed on a current-bundle alias rename, while canonical bindings carry both origins exactly', async () => {
        const one = await install('Identical source A'), two = await install('Identical source B', 'Apache-2.0');
        const local = await workflow({ first: one.ref, second: two.ref }), exported = await market.exportWorkflow(B, local.id), saved = await publish(local.id, exported), current = await market.get(B, saved.id);
        const renamed = structuredClone(current.bundle); renamed.dictionaries = { renamed1: renamed.dictionaries.first, renamed2: renamed.dictionaries.second }; renamed.workflow = lookupRule(['renamed1', 'renamed2']); delete renamed.dependencies;
        const before = Number((await q('SELECT latest_version FROM automation_packages WHERE id=?', [saved.id]))[0].latest_version);
        await assert.rejects(market.save(B, { title: 'Ambiguous rename', visibility: 'private', expectedVersion: before, bundle: renamed }, saved.id), { code: 'PACKAGE_DEPENDENCIES_INVALID' });
        assert.equal(Number((await q('SELECT latest_version FROM automation_packages WHERE id=?', [saved.id]))[0].latest_version), before);
        const canonical = await workflow({ renamed1: one.ref, renamed2: two.ref }), proof = await market.exportWorkflowPublication(B, canonical.id);
        assert.equal(proof.dependencies.dictionaries.renamed1[0].packageId, one.pack.id); assert.equal(proof.dependencies.dictionaries.renamed2[0].packageId, two.pack.id);
    });
    await t.test('official transitive install retains A and B safety through local edit, restore, ordinary workflow copy and alias-renaming package update', async () => {
        const a = await install('Transitive source A'), local = await workflow({ words: a.ref }), exported = await market.exportWorkflow(B, local.id), published = await publish(local.id, exported);
        const installed = await market.install(B, published.id, { version: 1 }), pinned = installed.dictionaries.words;
        let receipt = JSON.parse((await q('SELECT package_dependencies_json FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [pinned.id, pinned.revision]))[0].package_dependencies_json);
        assert.deepEqual(new Set(receipt.references.map(row => row.packageId)), new Set([a.pack.id, published.id])); assert.equal(receipt.sourceAlias, 'words');
        const edited = await service.saveDictionary(B, { expectedRevision: 1, dictionary: { ...await service.dictionaryData(pinned.id, 1), entries: ['edited locally'] } }, pinned.id);
        const restored = await service.saveDictionary(B, { expectedRevision: 2, dictionary: await service.dictionaryData(pinned.id, 1) }, pinned.id, 1);
        for (const ref of [edited, restored]) assert.equal((await q('SELECT package_dependencies_json FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [ref.id, ref.revision]))[0].package_dependencies_json, JSON.stringify(receipt));
        const attached = await workflow({ words: { id: restored.id, revision: restored.revision } }), copy = await service.createWorkflow(B, { sourceWorkflowId: attached.id, expectedSourceRevision: attached.revision, definition: attached.draft, bindings: attached.bindings });
        assert(entries(await market.exportWorkflowPublication(B, copy.id)).some(row => row.packageId === a.pack.id));
        const renamedRule = await workflow({ renamed: a.ref }), renamedBundle = await market.exportWorkflow(B, renamedRule.id);
        await publish(renamedRule.id, renamedBundle, { expectedVersion: 1 }).then(async value => { assert(value.id); });
        // Revise the existing authored wrapper using its unchanged original local source.
        await service.updateWorkflow(B, local.id, { expectedRevision: 1, definition: lookupRule(['renamed']), bindings: { dictionaries: { renamed: a.ref } } });
        const revision = await market.exportWorkflow(B, local.id); await market.save(B, { title: 'Renamed wrapper', visibility: 'public', rightsConfirmed: true, expectedVersion: 1, sourceWorkflowId: local.id, bundle: { ...revision, license: 'MIT' } }, published.id);
        const plan = await market.previewUpdate(B, published.id, { workflowId: installed.workflow.id, version: 2 });
        const update = await market.updateInstall(B, published.id, { workflowId: installed.workflow.id, version: 2, expectedToken: plan.token, replaceLocalChanges: true });
        await assertPackageSafety(q, job(pinned, edited, restored, update.dictionaries.renamed));
        await q("UPDATE automation_package_versions SET status='revoked' WHERE package_id=? AND version=1", [a.pack.id]);
        for (const ref of [pinned, edited, restored, update.dictionaries.renamed]) await assert.rejects(assertPackageSafety(q, job(ref)), { code: 'SAFETY_DICTIONARY_REVOKED' });
    });
    await t.test('different versions of the same package keep different licenses and revocation applies only to pinned applicable editions', async () => {
        const p = await market.save(A, packageInput('Versioned package')), first = await market.install(B, p.id, { version: 1 });
        await market.save(A, { ...packageInput('Versioned package', 'Apache-2.0'), expectedVersion: 1 }, p.id); const second = await market.install(B, p.id, { version: 2 });
        const local = await workflow({ old: first.dictionaries.words, newer: second.dictionaries.words }), exported = await market.exportWorkflowPublication(B, local.id);
        assert.equal(exported.dependencies.dictionaries.old[0].version, 1); assert.equal(exported.dependencies.dictionaries.newer[0].version, 2); assert.equal(exported.dependencies.dictionaries.old[0].license, 'CC-BY-SA-4.0'); assert.equal(exported.dependencies.dictionaries.newer[0].license, 'Apache-2.0');
        await q("UPDATE automation_package_versions SET status='revoked' WHERE package_id=? AND version=1", [p.id]);
        await assert.rejects(assertPackageSafety(q, job(first.dictionaries.words)), { code: 'SAFETY_DICTIONARY_REVOKED' }); await assertPackageSafety(q, job(second.dictionaries.words));
        const unrelated = await service.saveDictionary(B, { dictionary: dictionary() }); await assertPackageSafety(q, job(unrelated)); await assert.rejects(assertPackageSafety(q, job(second.dictionaries.words, first.dictionaries.words)), { code: 'SAFETY_DICTIONARY_REVOKED' });
    });
    await t.test('workflow-package-derived dictionaries, same-ID edits and fork editions retain their applicable metadata without selecting a substitute license', async () => {
        const a = await install('Workflow asset source A'), local = await workflow({ words: a.ref }), published = await publish(local.id, await market.exportWorkflow(B, local.id));
        const fork = await market.fork(C, published.id, { version: 1 }), editable = await market.importForEditing(C, fork.id, { version: 1, scope: 'private' });
        const info = await market.exportWorkflowPublication(C, editable.workflow.id), exported = info.bundle; assert(entries(info).some(row => row.packageId === a.pack.id));
        await market.save(C, { title: 'Fork current-bundle edit', visibility: 'private', expectedVersion: 1, bundle: exported }, fork.id);
        const read = await market.get(C, fork.id); assert.equal(read.fork_of, published.id); assert(entries(read).some(row => row.packageId === a.pack.id));
        const edited = await market.importForEditing(B, published.id, { version: 1, scope: 'private' }), own = await market.exportWorkflow(B, edited.workflow.id);
        await market.save(B, { title: 'Same original package', visibility: 'private', expectedVersion: 1, sourceWorkflowId: edited.workflow.id, bundle: own }, published.id);
        assert.equal((await market.get(B, published.id)).fork_of, null); assert(entries(await market.get(B, published.id)).some(row => row.packageId === a.pack.id));
    });
    await t.test('publication rechecks actor access, exact dependency receipts and source corruption before commit; failure preserves immutable assets', async () => {
        for (const change of ['owner', 'receipt']) {
            const a = await install('Race dependency'), local = await workflow({ words: a.ref }), exported = await market.exportWorkflow(B, local.id), before = await content(a.ref);
            const count = Number((await q('SELECT COUNT(*) n FROM automation_packages'))[0].n);
            const racing = createMarketplace(db, { service, safety: { assertPublication: async () => { if (change === 'owner') await q('UPDATE automation_dictionaries SET owner_user_id=? WHERE id=?', [C.userId, a.ref.id]); else await q("UPDATE automation_dictionary_revisions SET package_dependencies_json='{}' WHERE dictionary_id=? AND revision=?", [a.ref.id, a.ref.revision]); return { decision: 'allow' }; } } });
            await assert.rejects(racing.save(B, { title: 'Stale dependency', visibility: 'public', rightsConfirmed: true, sourceWorkflowId: local.id, bundle: { ...exported, license: 'MIT' } }));
            assert.equal(Number((await q('SELECT COUNT(*) n FROM automation_packages'))[0].n), count); assert.deepEqual(await content(a.ref), before);
        }
        const a = await install('Damaged source'), local = await workflow({ words: a.ref }); await q("UPDATE automation_dictionary_revisions SET package_dependencies_json='[]' WHERE dictionary_id=? AND revision=?", [a.ref.id, 1]);
        await assert.rejects(market.exportWorkflow(B, local.id), { code: 'PACKAGE_DEPENDENCIES_INVALID' }); await assert.rejects(assertPackageSafety(q, job(a.ref)), { code: 'SAFETY_DEPENDENCIES_UNAVAILABLE' });
        const missing = await install('Missing source edition'); await q('DELETE FROM automation_package_versions WHERE package_id=? AND version=1', [missing.pack.id]); await assert.rejects(assertPackageSafety(q, job(missing.ref)), { code: 'SAFETY_DEPENDENCIES_UNAVAILABLE' }); await assert.rejects(market.exportDictionaryPackage(B, missing.ref.id, 1));
    });
    await t.test('dependency notices are part of publication inspection, and stale or corrupt metadata never exposes new private source text', async () => {
        const a = await install('Publication inspection source'), local = await workflow({ words: a.ref }), exported = await market.exportWorkflow(B, local.id);
        const before = Number((await q('SELECT COUNT(*) n FROM automation_packages'))[0].n); let inspected = false;
        const checking = createMarketplace(db, { service, safety: { assertPublication: async pack => {
            inspected = true; assert.match(pack.bundle.description, /Publication inspection source outer attribution/); assert.match(pack.bundle.description, /CC-BY-SA-4.0/);
            throw Error('Synthetic publication refusal');
        } } });
        await assert.rejects(checking.save(B, { title: 'Inspected source notices', visibility: 'public', rightsConfirmed: true, sourceWorkflowId: local.id, bundle: { ...exported, license: 'MIT' } }), { code: 'PUBLICATION_CHECK_FAILED' });
        assert(inspected); assert.equal(Number((await q('SELECT COUNT(*) n FROM automation_packages'))[0].n), before);
        const saved = await publish(local.id, exported), baseline = await market.get(C, saved.id), row = (await q('SELECT package_dependencies_json FROM automation_package_versions WHERE package_id=? AND version=1', [saved.id]))[0];
        assert(!Object.hasOwn(baseline.bundle, 'dependencies')); assert.equal(entries(baseline).length, 1);
        await q("UPDATE automation_package_versions SET package_dependencies_json='[]' WHERE package_id=? AND version=1", [saved.id]);
        await assert.rejects(market.get(C, saved.id), { code: 'PACKAGE_DEPENDENCIES_INVALID' });
        await q('UPDATE automation_package_versions SET package_dependencies_json=? WHERE package_id=? AND version=1', [row.package_dependencies_json, saved.id]);
        await q('UPDATE automation_package_versions SET description=? WHERE package_id=? AND version=1', ['https://discord.com/api/webhooks/123456789/new-private-secret', a.pack.id]);
        await assert.rejects(market.get(C, saved.id), { code: 'PACKAGE_DEPENDENCIES_INVALID' });
        await assert.rejects(market.exportWorkflow(B, local.id), /BUNDLE_CONTAINS_CREDENTIALS/);
        assert.deepEqual((await service.dictionaryData(a.ref.id, a.ref.revision)).entries, ['alpha']);
    });
    await t.test('official dependency stamping failure rolls back every new dictionary, workflow and installation', async () => {
        const a = await install('Install rollback source'), local = await workflow({ words: a.ref }), published = await publish(local.id, await market.exportWorkflow(B, local.id));
        const counts = async () => (await q('SELECT (SELECT COUNT(*) FROM automation_dictionaries) d,(SELECT COUNT(*) FROM automation_workflows) w,(SELECT COUNT(*) FROM automation_package_installs) i'))[0];
        const before = await counts(); let injected = false;
        const faultDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
            const rows = await query(sql, params); if (/UPDATE automation_dictionary_revisions SET package_dependencies_json=/.test(sql)) { injected = true; throw Error('Synthetic receipt write failure'); } return rows;
        })) };
        const faulting = createMarketplace(faultDb, { service: createService(faultDb, { rateLimiter: { consumeOperation: async () => {} } }), moderationMatcher: { match: async () => [] } });
        await assert.rejects(faulting.install(C, published.id, { version: 1 }), /Synthetic receipt write failure/); assert(injected); assert.deepEqual(await counts(), before);
        const installed = await market.install(C, published.id, { version: 1 }); assert(installed.workflow.id); assert.equal((await service.dictionaryData(installed.dictionaries.words.id, 1)).license, 'CC0-1.0');
    });
    await t.test('dictionary publication validates the exact stored contents again inside its transaction', async () => {
        const original = await install('Pinned content corruption'), exported = await market.exportDictionaryPackage(B, original.ref.id, 1), before = await content(original.ref);
        const count = Number((await q('SELECT COUNT(*) n FROM automation_packages'))[0].n);
        const racing = createMarketplace(db, { service, safety: { assertPublication: async () => {
            await q('UPDATE automation_dictionary_revisions SET data_gzip=? WHERE dictionary_id=? AND revision=1', [Buffer.from('corrupt gzip'), original.ref.id]); return { decision: 'allow' };
        } } });
        await assert.rejects(racing.save(B, { title: 'Pinned source', visibility: 'public', rightsConfirmed: true, sourceDictionaryId: original.ref.id, sourceDictionaryRevision: 1, bundle: exported.bundle }));
        assert.equal(Number((await q('SELECT COUNT(*) n FROM automation_packages'))[0].n), count);
        await q('UPDATE automation_dictionary_revisions SET data_gzip=? WHERE dictionary_id=? AND revision=1', [before[0].data_gzip, original.ref.id]);
        assert.deepEqual(await content(original.ref), before); assert((await market.save(B, { title: 'Repaired pinned source', visibility: 'public', rightsConfirmed: true, sourceDictionaryId: original.ref.id, sourceDictionaryRevision: 1, bundle: exported.bundle })).id);
    });
    await t.test('raw external bundles cannot forge trusted lineage, and migration preserves every existing content checksum without guessing dependencies', async () => {
        const a = await install('Raw file control'), local = await workflow({ words: a.ref }), exported = await market.exportWorkflow(B, local.id);
        const raw = await market.importBundle(B, exported, { scope: 'private' }), ref = raw.dictionaries.words;
        assert.equal((await q('SELECT source_package_id,package_dependencies_json FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [ref.id, ref.revision]))[0].package_dependencies_json, null);
        const independent = await market.exportWorkflow(B, raw.workflow.id); assert.equal(independent.dependencies, undefined); await q("UPDATE automation_package_versions SET status='revoked' WHERE package_id=? AND version=1", [a.pack.id]); await assertPackageSafety(q, job(ref));
        const legacy = await createTestDatabase(port); try {
            const s = createService(legacy, { rateLimiter: { consumeOperation: async () => {} } }); await s.saveDictionary(B, { dictionary: dictionary() });
            const before = await legacy.queryDatabase('SELECT dictionary_id,revision,checksum,data_gzip FROM automation_dictionary_revisions');
            await legacy.queryDatabase('ALTER TABLE automation_dictionary_revisions DROP COLUMN package_dependencies_json');
            await legacy.queryDatabase('ALTER TABLE automation_package_versions DROP COLUMN package_dependencies_json');
            await legacy.queryDatabase(schema.SCHEMA_STATEMENTS.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')));
            for (let pass = 0; pass < 2; pass++) await schema._internal.applyMigrationFile(legacy.queryDatabase, '20261016_preserve_dictionary_package_dependencies.sql');
            assert.deepEqual(await legacy.queryDatabase('SELECT dictionary_id,revision,checksum,data_gzip FROM automation_dictionary_revisions'), before); assert.equal((await legacy.queryDatabase('SELECT package_dependencies_json FROM automation_dictionary_revisions'))[0].package_dependencies_json, null);
        } finally { await legacy.close(); }
        const old = { schemaVersion: 1, kind: 'dictionary', dictionaries: { words: dictionary() }, license: 'MIT' }; assert.deepEqual(decodeBundle(encodeBundle(old)), old);
        assert.throws(() => validateBundle({ ...exported, dependencies: { dictionaries: {} } }), /BUNDLE_UNKNOWN_FIELD/);
        assert.match(exported.description, /CC-BY-SA-4.0/); assert.match(decodeBundle(encodeBundle(exported)).description, /Raw file control original author notice/);
    });
});
