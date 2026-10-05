'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createEvaluator } = require('../../src/automation/evaluation');
const { createMarketplace } = require('../../src/automation/marketplace');
const { createModeration, starterDictionary, starterInfo } = require('../../src/automation/moderation');
const { newWorkflow } = require('../../src/automation/schema');
const { createDictionaryService } = require('../../src/automation/dictionary-service');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL marketplace: version review, pinned installs, safe updates, dictionaries, forks and moderation', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), service = createService(db), evaluator = createEvaluator(service.dictionaryData);
    const moderation = createModeration(db, service, evaluator), market = createMarketplace(db, { service, evaluator, moderationMatcher: moderation });
    const owner = { userId: '222222222222222222', guildId: '111111111111111111', canView: true, canEdit: true };
    const member = { ...owner, userId: '333333333333333333' }, admin = { ...owner, userId: '444444444444444444', isAdmin: true };
    const dictionary = { schemaVersion: 1, name: '共有用サンプル', source: '自作テストデータ', license: 'CC0-1.0', entries: ['word-one'] };
    const bundle = name => ({ schemaVersion: 1, kind: 'workflow', workflow: newWorkflow(name), dictionaries: { words: dictionary }, license: 'CC0-1.0' });
    const input = (name, visibility = 'public') => ({ title: name, description: 'テスト用共有ルール', visibility, rightsConfirmed: true, bundle: bundle(name) });
    let published, installed, dm;
    try {
        await t.test('private drafts stay private and checked public versions publish without administrator approval', async () => {
            const draft = await market.save(owner, input('非公開', 'private'));
            await assert.rejects(market.get(member, draft.id), { status: 404 }); await assert.rejects(market.get(admin, draft.id), { status: 404 });
            published = await market.save(owner, input('公開版1'));
            assert.equal(published.status, 'active');
            assert.equal((await market.get(member, published.id)).status, 'active');
            await assert.rejects(market.setStatus(owner, published.id, { status: 'active', expectedVersion: 1 }), { status: 403 });
            assert.equal((await market.get(member, published.id)).version, 1);
            await assert.rejects(market.save(member, { ...input('不正な編集'), expectedVersion: 1 }, published.id), { status: 404 });
        });
        await t.test('rejected edits preserve the old publication, valid edits publish atomically and installs stay pinned', async () => {
            installed = await market.install(member, published.id, { version: 1 });
            assert.equal(installed.workflow.enabled, false);
            dm = await service.saveDestination(member, { name: 'private DM', kind: 'dm', scope: 'private' });
            await service.updateWorkflow(member, installed.workflow.id, { expectedRevision: 1, definition: installed.workflow.draft, bindings: { ...installed.workflow.bindings, destinations: { default: dm.id } } });
            await service.activateWorkflow(member, installed.workflow.id, { expectedRevision: 2 });
            const rejecting = createMarketplace(db, { service, evaluator, moderationMatcher: { match: async () => [{ term: 'benign-test-marker' }] } });
            await assert.rejects(rejecting.save(owner, { ...input('拒否する変更'), expectedVersion: 1 }, published.id), { code: 'PUBLICATION_REJECTED' });
            const listed = (await market.list(member)).items.find(p => p.id === published.id);
            assert.equal(listed.title, '公開版1'); assert.equal(listed.latest_version, 1);
            await assert.rejects(market.get(member, published.id, 2), { status: 404 });
            await market.save(owner, { ...input('公開版2'), expectedVersion: 1 }, published.id);
            assert.equal((await market.get(member, published.id)).version, 2);
            assert.deepEqual((await market.versions(member, published.id)).items.map(v => v.version), [2, 1]);
            const v3 = input('公開版3'); v3.bundle.dictionaries = { words: { ...dictionary, entries: ['word-one', 'word-two'] } };
            await market.save(owner, { ...v3, expectedVersion: 2 }, published.id);
            assert.equal((await market.get(member, published.id)).version, 3);
            assert.equal((await service.getWorkflow(member, installed.workflow.id)).draft.name, '公開版1');
        });
        await t.test('updating an installed rule protects local edits and preserves destinations and the active revision', async () => {
            const current = await service.getWorkflow(member, installed.workflow.id);
            await service.updateWorkflow(member, current.id, { expectedRevision: current.revision, definition: { ...current.draft, name: 'ローカル編集' } });
            const args = { workflowId: current.id, version: 3 }, preview = await market.previewUpdate(member, published.id, args);
            assert.equal(preview.localChanges, true); assert.equal(preview.dictionaryDiffs[0].added, 1);
            await assert.rejects(market.updateInstall(member, published.id, { ...args, expectedToken: preview.token }), { code: 'LOCAL_CHANGES' });
            await market.updateInstall(member, published.id, { ...args, expectedToken: preview.token, replaceLocalChanges: true });
            const updated = await service.getWorkflow(member, current.id);
            assert.equal(updated.draft.name, '公開版3'); assert.equal(updated.activeRevision, 2); assert.equal(updated.bindings.destinations.default, dm.id);
            assert.equal((await market.installations(member)).items[0].version, 3);
            await assert.rejects(market.updateInstall(member, published.id, { ...args, expectedToken: preview.token, replaceLocalChanges: true }), { code: 'REVISION_CONFLICT' });
        });
        await t.test('dictionary-package updates reuse dictionary IDs, create immutable revisions, and do not advance bound rules', async () => {
            const dictInput = { ...input('辞書パック'), bundle: { schemaVersion: 1, kind: 'dictionary', dictionaries: { words: dictionary }, license: 'CC0-1.0' } };
            const pack = await market.save(owner, dictInput);
            const install = await market.install(member, pack.id, { version: 1 }); assert(install.installId);
            const ref = install.dictionaries.words;
            const rule = await service.createWorkflow(member, { definition: newWorkflow('固定版'), bindings: { dictionaries: { words: ref } } });
            await market.save(owner, { ...dictInput, expectedVersion: 1, bundle: { ...dictInput.bundle, dictionaries: { words: { ...dictionary, entries: ['word-one', 'word-three'] } } } }, pack.id);
            const args = { installId: install.installId, version: 2 }, preview = await market.previewUpdate(member, pack.id, args);
            const result = await market.updateInstall(member, pack.id, { ...args, expectedToken: preview.token });
            assert.equal(result.dictionaries.words.id, ref.id); assert.equal(result.dictionaries.words.revision, 2);
            assert.equal((await service.getWorkflow(member, rule.id)).bindings.dictionaries.words.revision, 1);
            assert.equal((await service.dictionaryData(ref.id, 1)).entries.length, 1); assert.equal((await service.dictionaryData(ref.id, 2)).entries.length, 2);
            assert.equal((await market.installations(member, { kind: 'dictionary' })).items[0].version, 2);
        });
        await t.test('removed dictionary bindings are local edits even when the workflow definition is unchanged', async () => {
            const local = await market.install(member, published.id, { version: 3 });
            await service.updateWorkflow(member, local.workflow.id, { expectedRevision: 1, definition: local.workflow.draft, bindings: { dictionaries: {}, destinations: {} } });
            const args = { workflowId: local.workflow.id, version: 3 };
            const preview = await market.previewUpdate(member, published.id, args);
            assert.equal(preview.localChanges, true);
            await assert.rejects(market.updateInstall(member, published.id, { ...args, expectedToken: preview.token }), { code: 'LOCAL_CHANGES' });
            assert.deepEqual((await service.getWorkflow(member, local.workflow.id)).bindings.dictionaries, {});
        });
        await t.test('failed workflow imports roll back every dictionary dependency and install record', async () => {
            const counts = async () => (await db.queryDatabase('SELECT (SELECT COUNT(*) FROM automation_dictionaries) AS dictionaries,(SELECT COUNT(*) FROM automation_dictionary_revisions) AS revisions,(SELECT COUNT(*) FROM automation_workflows) AS workflows,(SELECT COUNT(*) FROM automation_package_installs) AS installs'))[0];
            const before = await counts();
            const installer = require('../../src/automation/marketplace-installs').createInstalls(db, { ...service, createWorkflow: async () => { throw new Error('fixture workflow failure'); } }, market.get, evaluator);
            await assert.rejects(installer.install(member, published.id, { version: 3 }), /fixture workflow failure/);
            assert.deepEqual(await counts(), before);
        });
        await t.test('dictionary updates roll back earlier dependency writes and reject another user or a read-only guild member', async () => {
            const two = { schemaVersion: 1, kind: 'dictionary', dictionaries: { first: dictionary, second: { ...dictionary, name: 'second' } }, license: 'CC0-1.0' };
            const pack = await market.save(owner, { ...input('atomic dictionaries'), bundle: two });
            const local = await market.install(member, pack.id, { version: 1, scope: 'guild' });
            const args = { installId: local.installId, version: 1 };
            await assert.rejects(market.previewUpdate({ ...member, canEdit: false }, pack.id, args), { status: 403 });
            const privateLocal = await market.install(member, pack.id, { version: 1 });
            await assert.rejects(market.previewUpdate(owner, pack.id, { installId: privateLocal.installId, version: 1 }), { status: 404 });
            const preview = await market.previewUpdate(member, pack.id, args);
            let saves = 0;
            const installer = require('../../src/automation/marketplace-installs').createInstalls(db, { ...service, saveDictionary: async (...values) => {
                if (++saves === 2) throw new Error('fixture second dependency failure');
                return service.saveDictionary(...values);
            } }, market.get, evaluator);
            await assert.rejects(installer.updateInstall(member, pack.id, { ...args, expectedToken: preview.token }), /fixture second dependency failure/);
            for (const ref of Object.values(local.dictionaries)) {
                assert.equal(Number((await service.getRow('dictionary', member, ref.id)).revision), 1);
                assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_dictionary_revisions WHERE dictionary_id=?', [ref.id]))[0].n), 1);
            }
        });
        await t.test('unlisted access requires a key, private forks retain source and license, and favorites/follows are distinct', async () => {
            const limited = await market.save(owner, input('限定共有', 'unlisted'));
            const owned = await market.get(owner, limited.id), key = owned.shareKey;
            await assert.rejects(market.get(member, limited.id), { status: 404 });
            await assert.rejects(market.get(member, limited.id, 1, 'x'.repeat(64)), { status: 404 });
            const visible = await market.get(member, limited.id, 1, key); assert.equal(visible.shareKey, undefined);
            assert.equal(JSON.stringify(visible).includes(key), false);
            assert.equal(JSON.stringify(await market.list(member)).includes(key), false);
            await assert.rejects(market.install(member, limited.id, { version: 1 }), { status: 404 });
            assert((await market.install(member, limited.id, { version: 1, shareKey: key })).workflow.id);
            assert.equal((await market.list(member)).items.some(p => p.id === limited.id), false);
            const fork = await market.fork(member, limited.id, { version: 1, shareKey: key });
            const copy = await market.get(member, fork.id); assert.equal(copy.bundle.license, owned.bundle.license); assert.equal(copy.fork_of, limited.id); assert(copy.bundle.description.includes(limited.id));
            await market.feedback(member, published.id, { kind: 'favorite', enabled: true });
            assert.equal((await market.list(member, { favorites: true })).items.length, 1);
            await market.feedback(member, published.id, { kind: 'follow', enabled: true });
            assert((await market.list(member, { following: true })).items.length >= 2);
            await market.feedback(member, published.id, { kind: 'rating', rating: 4 }); assert.equal((await market.get(owner, published.id)).rating, 4);
            await market.feedback(member, published.id, { kind: 'favorite', enabled: false }); assert.equal((await market.list(member, { favorites: true })).items.length, 0);
        });
        await t.test('visibility transitions protect old public revisions and do not disclose the limited-share key', async () => {
            const pack = await market.save(owner, input('visibility regression'));
            await market.save(owner, { ...input('limited regression', 'unlisted'), expectedVersion: 1 }, pack.id);
            const key = (await market.get(owner, pack.id)).shareKey;
            assert(!(await market.list(member, { search: 'regression' })).items.some(p => p.id === pack.id));
            await assert.rejects(market.get(member, pack.id, 1), { status: 404 });
            assert.equal((await market.get(member, pack.id, 1, key)).version, 1);
            const visible = await market.get(member, pack.id, 2, key);
            assert.equal(visible.shareKey, undefined); assert(!JSON.stringify(visible).includes(key));
            await market.save(owner, { ...input('private regression', 'private'), expectedVersion: 2 }, pack.id);
            for (const actor of [member, admin]) {
                await assert.rejects(market.get(actor, pack.id, 1, key), { status: 404 });
                await assert.rejects(market.versions(actor, pack.id, { shareKey: key }), { status: 404 });
                await assert.rejects(market.install(actor, pack.id, { version: 1, shareKey: key }), { status: 404 });
            }
            await assert.rejects(market.install(owner, pack.id, { version: 1 }), { code: 'MARKET_NOT_ACTIVE' });
            assert(!(await market.list(member)).items.some(p => p.id === pack.id));
            await market.save(owner, { ...input('public again regression'), expectedVersion: 3 }, pack.id);
            assert.equal((await market.get(member, pack.id)).version, 4);
            await assert.rejects(market.get(member, pack.id, 3), { status: 404 });
        });
        await t.test('reports need reviewer authority, can be resolved, and new reports reopen the record', async () => {
            await market.feedback(member, published.id, { kind: 'report', reason: '確認してください' });
            const report = (await market.reviewQueue(admin)).reports[0];
            await assert.rejects(market.resolveReport(member, report.id, {}), { status: 403 });
            await market.resolveReport(admin, report.id, { note: '確認済み' }); assert.equal((await market.reviewQueue(admin)).reports.length, 0);
            await market.feedback(member, published.id, { kind: 'report', reason: '追加の確認' }); assert.equal((await market.reviewQueue(admin)).reports.length, 1);
        });
        await t.test('starter attribution and administrator-selected dictionary moderate listings without rejecting filter terms', async () => {
            assert.equal(starterInfo().languages.length, 28); assert(starterInfo().uniqueEntries > 2500); assert.equal(starterDictionary().license.startsWith('CC-BY-4.0'), true);
            const custom = await service.saveDictionary(admin, { dictionary: { ...dictionary, entries: ['TEST_BLOCKED_PHRASE'] } });
            await assert.rejects(moderation.save(member, { expectedRevision: 0, useStarter: true }), { status: 403 });
            await moderation.save(admin, { expectedRevision: 0, useStarter: true, dictionaryId: custom.id, dictionaryRevision: 1 });
            await assert.rejects(market.save(owner, input('TEST_BLOCKED_PHRASE')), { code: 'PUBLICATION_REJECTED' });
            const allowed = input('辞書内容は審査しない'); allowed.bundle.dictionaries.words = { ...dictionary, entries: ['TEST_BLOCKED_PHRASE'] };
            assert((await market.save(owner, allowed)).id);
            const starterTerm = starterDictionary('en').entries.find(e => /^ass$/i.test(e.term)); assert(starterTerm);
            await service.saveDictionary(admin, { expectedRevision: 1, dictionary: { ...dictionary, entries: [{ term: starterTerm.term, kind: 'allow', mode: 'word' }] } }, custom.id);
            await moderation.save(admin, { expectedRevision: 1, useStarter: true, dictionaryId: custom.id, dictionaryRevision: 2 });
            assert((await moderation.match(starterTerm.term)).length > 0, 'publication starter denials remain effective with custom allow entries');
            assert.equal((await moderation.matchNotification(starterTerm.term)).length, 0, 'notification matching does not force publication starter denials');
        });
        await t.test('dictionary editing manager persists old versions and uses optimistic revision checks', async () => {
            const manager = createDictionaryService(db, service, evaluator), created = await manager.save(member, { dictionary });
            const page = await manager.page(member, created.id, {}); assert.equal(page.records[0].index, 0);
            await manager.patch(member, created.id, { expectedRevision: 1, patch: { operations: [{ op: 'add', entry: 'word-added' }] } });
            await assert.rejects(manager.patch(member, created.id, { expectedRevision: 1, patch: { operations: [] } }), { code: 'REVISION_CONFLICT' });
            const delta = await manager.diff(member, created.id, 1, 2); assert.equal(delta.added, 1);
            await manager.restore(member, created.id, { expectedRevision: 2, revision: 1 });
            assert.deepEqual((await manager.page(member, created.id)).entries, dictionary.entries);
            assert.equal((await manager.versions(member, created.id)).items.length, 3);
        });
        await t.test('untrusted raw imports cannot forge a marketplace install record or override an existing rule', async () => {
            const before = (await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_package_installs'))[0].n;
            await market.importBundle(member, bundle('手動インポート'), { packageId: published.id, version: 3 });
            assert.equal((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_package_installs'))[0].n, before);
            await assert.rejects(market.importBundle(member, bundle('上書き禁止'), { workflowId: installed.workflow.id }), { code: 'INSTALL_REQUIRES_UPDATE_PREVIEW' });
        });
        await t.test('safety revocation stops installed workflows and cannot be cleared by owner resubmission or ordinary approval', async () => {
            const safetyPackage = await market.save(owner, input('緊急停止の試験'));
            const local = await market.install(member, safetyPackage.id, { version: 1 });
            await db.queryDatabase('UPDATE automation_workflows SET enabled=1 WHERE id=?', [local.workflow.id]);
            await assert.rejects(market.setStatus(owner, safetyPackage.id, { status: 'revoked', expectedVersion: 1, note: 'fixture reason' }), { status: 403 });
            await market.setStatus(admin, safetyPackage.id, { status: 'revoked', expectedVersion: 1, note: '無害な試験用の停止理由' });
            assert.equal((await service.getWorkflow(member, local.workflow.id)).enabled, false);
            await assert.rejects(require('../../src/automation/package-safety').assertPackageSafety(db.queryDatabase, { workflow_id: local.workflow.id, plan: {} }), { code: 'SAFETY_PACKAGE_REVOKED' });
            await assert.rejects(market.install(owner, safetyPackage.id, { version: 1 }), { code: 'MARKET_NOT_ACTIVE' });
            await assert.rejects(market.save(owner, { ...input('再公開の試験'), expectedVersion: 1 }, safetyPackage.id), { code: 'MARKET_REVOKED' });
            await assert.rejects(market.save(owner, { ...input('非公開を経由した再公開の試験', 'private'), expectedVersion: 1 }, safetyPackage.id), { code: 'MARKET_REVOKED' });
            await assert.rejects(market.setStatus(admin, safetyPackage.id, { status: 'active', expectedVersion: 1 }), { code: 'MARKET_REVOKED' });
        });
        await t.test('installation and update serialize with a concurrent takedown', async () => {
            for (const update of [false, true]) {
                const pack = await market.save(owner, input(`導入競合 ${update}`));
                let local, args;
                if (update) {
                    local = await market.install(member, pack.id, { version: 1 });
                    await market.save(owner, { ...input('競合する更新版'), expectedVersion: 1 }, pack.id);
                    args = { workflowId: local.workflow.id, version: 2 };
                    args.expectedToken = (await market.previewUpdate(member, pack.id, args)).token;
                }
                let readPackage, attemptedLock;
                const reading = new Promise(resolve => { readPackage = resolve; });
                const locking = new Promise(resolve => { attemptedLock = resolve; });
                const revokingDb = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(query => work(async (sql, params) => {
                    if (sql.includes('FOR UPDATE')) attemptedLock();
                    return query(sql, params);
                })) };
                const revoker = createMarketplace(revokingDb), order = [];
                // Start outside the installation transaction's async context.
                const revocation = (async () => {
                    await reading;
                    await revoker.setStatus(admin, pack.id, { status: 'revoked', expectedVersion: update ? 2 : 1, note: '競合検証' });
                    order.push('revoked');
                })();
                const installer = require('../../src/automation/marketplace-installs').createInstalls(db, service, async (...request) => {
                    const snapshot = await market.get(...request);
                    readPackage(); await locking;
                    return snapshot;
                }, evaluator);
                const importing = (update ? installer.updateInstall(member, pack.id, args) : installer.install(member, pack.id, { version: 1 })).then(result => {
                    order.push('installed'); return result;
                });
                const [result] = await Promise.all([importing, revocation]);
                assert.deepEqual(order, ['installed', 'revoked']);
                const workflowId = update ? local.workflow.id : result.workflow.id;
                await assert.rejects(require('../../src/automation/package-safety').assertPackageSafety(db.queryDatabase, { workflow_id: workflowId, plan: {} }), { code: 'SAFETY_PACKAGE_REVOKED' });
                await assert.rejects(market.install(owner, pack.id, { version: update ? 2 : 1 }), { code: 'MARKET_NOT_ACTIVE' });
            }
        });
    } finally { evaluator.stop(); await db.close(); }
});
