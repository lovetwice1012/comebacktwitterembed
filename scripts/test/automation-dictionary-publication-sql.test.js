'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMarketplace } = require('../../src/automation/marketplace');
const { createDictionaryService } = require('../../src/automation/dictionary-service');
const { createEvaluator } = require('../../src/automation/evaluation');
const { newWorkflow } = require('../../src/automation/schema');
const { dispatch } = require('../../src/automation/api');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const author = { userId: '229111111111111111' }, member = { userId: '229222222222222222' }, other = { userId: '229333333333333333' }, LICENSE = 'CC-BY-SA-4.0';
const dict = () => ({ schemaVersion: 1, name: 'Source words', mode: 'contains', source: 'Original dictionary author', license: 'CC0-1.0', entries: ['alpha'] });
const source = (name = 'Dictionary source', kind = 'dictionary') => ({ title: name, description: 'Original package attribution', category: 'general', visibility: 'public', rightsConfirmed: true,
    bundle: { schemaVersion: 1, kind, ...(kind === 'workflow' ? { workflow: newWorkflow(name) } : {}), dictionaries: { words: dict() }, license: LICENSE, description: 'Original package author notice' } });
test('dictionary publication uses exact immutable origin and never replaces a package license with its inner dictionary license', { skip: !port, timeout: 120000 }, async t => {
    const db = await createTestDatabase(port), q = db.queryDatabase; t.after(() => db.close());
    const service = createService(db, { rateLimiter: { consumeOperation: async () => {} } }), market = createMarketplace(db, { service, moderationMatcher: { match: async () => [] } });
    const request = exported => ({ title: 'Adapted dictionary', description: '', category: 'general', visibility: 'public', rightsConfirmed: true, sourceDictionaryId: exported.sourceDictionaryId, sourceDictionaryRevision: exported.sourceDictionaryRevision, bundle: exported.bundle });
    async function installedFork(kind = 'dictionary') {
        const original = await market.save(author, source('Licensed source', kind)), fork = await market.fork(member, original.id, { version: 1 });
        const imported = await market.importForEditing(member, fork.id, { version: 1, scope: 'private' }); return { original, fork, ref: imported.dictionaries.words };
    }
    await t.test('owned fork editing-import and dictionary-source public save preserve outer license, attribution and fork identity', async () => {
        const { fork, ref } = await installedFork(), exported = await market.exportDictionaryPackage(member, ref.id, ref.revision);
        assert.equal(exported.bundle.license, LICENSE); assert.equal(exported.bundle.dictionaries.words.license, 'CC0-1.0'); assert.equal(exported.sourcePackageId, fork.id); assert.match(exported.bundle.description, /Original package author notice/);
        await assert.rejects(market.save(member, { ...request(exported), bundle: { ...exported.bundle, license: 'MIT' } }), { code: 'FORK_LICENSE' });
        const saved = await market.save(member, request(exported)), published = await market.get(other, saved.id); assert.equal(published.fork_of, fork.id); assert.equal(published.bundle.license, LICENSE); assert.match(published.description, /Original package author notice/);
        await assert.rejects(market.exportDictionaryPackage(other, ref.id, ref.revision), { status: 404 }); await assert.rejects(market.save(other, request(exported)), { status: 404 });
    });
    await t.test('dictionaries derived from an official workflow package retain its outer license through the ordinary dictionary-source route', async () => {
        const { fork, ref } = await installedFork('workflow'), exported = await market.exportDictionaryPackage(member, ref.id, ref.revision);
        assert.equal(exported.bundle.kind, 'dictionary'); const saved = await market.save(member, request(exported)); assert.equal((await market.get(other, saved.id)).fork_of, fork.id); assert.equal((await market.get(other, saved.id)).bundle.license, LICENSE);
    });
    await t.test('original and fork authors revise their same package without self-forking or dropping the fork first-edition license', async () => {
        const original = await market.save(author, source('Own editable source')), fork = await market.fork(member, original.id, { version: 1 });
        for (const [owner, id, parent, license] of [[author, original.id, null, 'MIT'], [member, fork.id, original.id, LICENSE]]) {
            const imported = await market.importForEditing(owner, id, { version: 1, scope: 'private' }), ref = imported.dictionaries.words, exported = await market.exportDictionaryPackage(owner, ref.id, ref.revision);
            const input = { ...request(exported), expectedVersion: 1, bundle: { ...exported.bundle, license } };
            if (parent) await assert.rejects(market.save(owner, { ...input, bundle: { ...exported.bundle, license: 'MIT' } }, id), { code: 'FORK_LICENSE' });
            const saved = await market.save(owner, input, id), read = await market.get(owner, id); assert.equal(saved.id, id); assert.equal(read.fork_of, parent); assert.equal(read.bundle.license, license);
        }
    });
    await t.test('displayed historical revision remains frozen when the current dictionary advances, and arbitrary contents cannot claim its proof', async () => {
        const { ref } = await installedFork(), exported = await market.exportDictionaryPackage(member, ref.id, ref.revision), first = await service.dictionaryData(ref.id, ref.revision);
        await service.saveDictionary(member, { expectedRevision: ref.revision, dictionary: { ...first, entries: ['new current contents'] } }, ref.id);
        const frozen = await market.exportDictionaryPackage(member, ref.id, ref.revision); assert.deepEqual(frozen.bundle.dictionaries.words.entries, ['alpha']);
        const saved = await market.save(member, request(exported)); assert.deepEqual((await market.get(other, saved.id)).bundle.dictionaries.words.entries, ['alpha']);
        const forged = structuredClone(exported); forged.bundle.dictionaries.words.entries = ['unrelated content']; await assert.rejects(market.save(member, request(forged)), { code: 'REVISION_CONFLICT' });
        await assert.rejects(market.exportDictionaryPackage(member, ref.id, 999), { code: 'REVISION_CONFLICT' });
    });
    await t.test('source access and immutable origin are rechecked after publication inspection and before the transaction commits', async () => {
        for (const mutation of ['owner', 'origin']) {
            const { original, ref } = await installedFork(), exported = await market.exportDictionaryPackage(member, ref.id, ref.revision);
            const next = await market.save(author, source('Different known source'));
            const before = Number((await q('SELECT COUNT(*) n FROM automation_packages WHERE owner_user_id=?', [member.userId]))[0].n);
            const racing = createMarketplace(db, { service, safety: { assertPublication: async () => {
                if (mutation === 'owner') await q('UPDATE automation_dictionaries SET owner_user_id=? WHERE id=?', [other.userId, ref.id]);
                else await q('UPDATE automation_dictionary_revisions SET source_package_id=?,source_package_version=1 WHERE dictionary_id=? AND revision=?', [next.id, ref.id, ref.revision]);
                return { decision: 'allow' };
            } } });
            await assert.rejects(racing.save(member, request(exported)), error => mutation === 'owner' ? error.status === 404 : error.code === 'REVISION_CONFLICT');
            assert.equal(Number((await q('SELECT COUNT(*) n FROM automation_packages WHERE owner_user_id=?', [member.userId]))[0].n), before); assert(original.id);
        }
    });
    await t.test('unknown legacy provenance fails closed without changing dictionary data; verified metadata repair restores publication and plain file export stays available', async () => {
        const { fork, ref } = await installedFork(), before = await service.dictionaryData(ref.id, ref.revision);
        await q('UPDATE automation_dictionary_revisions SET source_package_version=NULL,origin_reviewed=NULL WHERE dictionary_id=? AND revision=?', [ref.id, ref.revision]);
        await assert.rejects(market.exportDictionaryPackage(member, ref.id, ref.revision), { code: 'DICTIONARY_ORIGIN_REVIEW_REQUIRED' });
        const dictionaryService = createDictionaryService(db, service, createEvaluator(db)); const plain = await dictionaryService.exportData(member, ref.id, ref.revision, 'json'); assert.deepEqual(JSON.parse(plain.text), before);
        await q('UPDATE automation_dictionary_revisions SET source_package_id=?,source_package_version=1,origin_reviewed=1 WHERE dictionary_id=? AND revision=?', [fork.id, ref.id, ref.revision]);
        assert.equal((await market.exportDictionaryPackage(member, ref.id, ref.revision)).bundle.license, LICENSE); assert.deepEqual(await service.dictionaryData(ref.id, ref.revision), before);
    });
    await t.test('mixed source proofs and replacement source packages are rejected; independent original dictionaries keep explicit rights confirmation', async () => {
        const { original, fork, ref } = await installedFork(), exported = await market.exportDictionaryPackage(member, ref.id, ref.revision);
        await assert.rejects(market.save(member, { ...request(exported), sourceWorkflowId: '11111111-1111-4111-8111-111111111111' }), { code: 'FORK_SOURCE_IMMUTABLE' });
        const unrelated = await market.save(author, source('Unrelated dictionary package')), installed = await market.install(member, unrelated.id, { version: 1 }), otherExport = await market.exportDictionaryPackage(member, installed.dictionaries.words.id, 1);
        await assert.rejects(market.save(member, { ...request(otherExport), expectedVersion: 1 }, fork.id), { code: 'FORK_SOURCE_IMMUTABLE' });
        const own = await service.saveDictionary(member, { dictionary: dict() }), independent = await market.exportDictionaryPackage(member, own.id, 1); assert.equal(independent.sourcePackageId, null);
        const saved = await market.save(member, { ...request(independent), bundle: { ...independent.bundle, license: 'MIT' } }); assert.equal((await market.get(other, saved.id)).fork_of, null); assert(original.id);
        const route = await dispatch({ method: 'GET', path: ['dictionaries', own.id, 'package-export'], search: new URLSearchParams({ revision: '1' }) }, member, { service, market }); assert.equal(route.sourceDictionaryRevision, 1);
    });
});
