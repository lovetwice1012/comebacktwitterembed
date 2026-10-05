'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createMarketplace } = require('../../src/automation/marketplace');
const { createSafety, POLICY_VERSION } = require('../../src/automation/safety');
const { newWorkflow } = require('../../src/automation/schema');
const { gzipSync } = require('node:zlib');
const { hash } = require('../../src/automation/service');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
test('real SQL publication is immediate and old pending records terminate without human review', { skip: !port }, async () => {
    const db = await createTestDatabase(port);
    const owner = { userId: '222222222222222222' };
    const input = title => ({ title, visibility: 'public', rightsConfirmed: true, bundle: { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow(title), dictionaries: {}, license: 'CC0-1.0' } });
    async function legacy(id) {
        await db.queryDatabase("UPDATE automation_packages SET status='pending',published_version=NULL WHERE id=?", [id]);
        await db.queryDatabase("UPDATE automation_package_versions SET status='pending' WHERE package_id=?", [id]);
    }
    try {
        const automatic = createMarketplace(db);
        const live = await automatic.save(owner, input('機械チェックの試験'));
        assert.equal(live.status, 'active');
        const reader = { userId: '444444444444444444' };
        assert.equal((await automatic.get(reader, live.id)).status, 'active');
        const receipt = (await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='package.save'", [live.id]))[0];
        assert.equal(JSON.parse(receipt.detail_json).responsibility.acknowledged, true);
        const failed = createMarketplace(db, { safety: createSafety({ verifier: null }) });
        await assert.rejects(failed.save(owner, input('検査が故障した操作')), { code: 'PUBLICATION_CHECK_FAILED' });
        assert.equal((await automatic.list(owner)).items.length, 1, 'failed checks create no pending submission');
        await legacy(live.id);
        assert.equal((await failed.reviewPending()).state, 'rejected');
        assert.equal((await automatic.get(owner, live.id)).status, 'rejected');
        const older = await automatic.save(owner, input('旧版の自動処理'));
        await legacy(older.id);
        await Promise.all([automatic.reviewPending(), automatic.reviewPending()]);
        assert.equal((await automatic.get(owner, older.id)).status, 'active');
        assert.equal(Number((await db.queryDatabase("SELECT COUNT(*) AS n FROM automation_package_versions WHERE status='pending'"))[0].n), 0);
        const changed = await automatic.save(owner, input('更新競合の試験'));
        const racing = createMarketplace(db, { safety: createSafety({ verifier: { inspect: async ({ fingerprint }) => {
            await automatic.save(owner, { ...input('先に保存された版'), expectedVersion: 1 }, changed.id);
            return { fingerprint, policyVersion: POLICY_VERSION, detectorVersion: 'fixture-only', decision: 'allow', expiresAtMs: Date.now() + 10000 };
        } } }) });
        await assert.rejects(racing.save(owner, { ...input('古い版からの変更'), expectedVersion: 1 }, changed.id), { code: 'REVISION_CONFLICT' });
        assert.equal((await automatic.get(owner, changed.id)).title, '先に保存された版');
    } finally { await db.close(); }
});

test('legacy publication corruption and incomplete records terminate while preserving earlier publications', { skip: !port }, async t => {
    const db = await createTestDatabase(port), market = createMarketplace(db);
    const owner = { userId: '222222222222222222' }, reader = { userId: '444444444444444444' };
    const input = title => ({ title, visibility: 'public', rightsConfirmed: true, bundle: { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow(title), dictionaries: {}, license: 'CC0-1.0' } });
    try {
        for (const kind of ['gzip', 'checksum', 'json', 'schema', 'license', 'attribution']) await t.test(kind, async () => {
            const published = await market.save(owner, input(`旧版 ${kind}`));
            const pending = input(`検査対象 ${kind}`);
            await market.save(owner, { ...pending, expectedVersion: 1 }, published.id);
            await db.queryDatabase("UPDATE automation_packages SET status='pending',published_version=1 WHERE id=?", [published.id]);
            await db.queryDatabase("UPDATE automation_package_versions SET status='pending' WHERE package_id=? AND version=2", [published.id]);
            if (kind === 'gzip') await db.queryDatabase('UPDATE automation_package_versions SET bundle_gzip=? WHERE package_id=? AND version=2', [Buffer.from('broken gzip'), published.id]);
            else if (kind === 'checksum') await db.queryDatabase('UPDATE automation_package_versions SET checksum=? WHERE package_id=? AND version=2', ['0'.repeat(64), published.id]);
            else {
                if (kind === 'schema') pending.bundle.schemaVersion = 99;
                if (kind === 'license') delete pending.bundle.license;
                if (kind === 'attribution') pending.bundle.dictionaries.words = { schemaVersion: 1, name: '出典未指定', entries: ['example'] };
                const bytes = Buffer.from(kind === 'json' ? '{broken' : JSON.stringify(pending.bundle));
                await db.queryDatabase('UPDATE automation_package_versions SET bundle_gzip=?,checksum=? WHERE package_id=? AND version=2', [gzipSync(bytes), hash(bytes), published.id]);
            }
            assert.equal((await market.reviewPending()).state, 'rejected');
            assert.equal((await market.get(reader, published.id)).version, 1);
            assert.equal((await db.queryDatabase('SELECT status FROM automation_package_versions WHERE package_id=? AND version=2', [published.id]))[0].status, 'rejected');
        });
        await t.test('obsolete, private, withdrawn and missing latest records need no reviewer', async () => {
            for (const kind of ['obsolete', 'private', 'withdrawn', 'missing']) {
                const pack = await market.save(owner, input(`旧レコード ${kind}`));
                if (kind === 'obsolete') await market.save(owner, { ...input('新しい公開版'), expectedVersion: 1 }, pack.id);
                await db.queryDatabase("UPDATE automation_package_versions SET status='pending' WHERE package_id=? AND version=1", [pack.id]);
                if (kind === 'private') await db.queryDatabase("UPDATE automation_packages SET visibility='private',status='pending' WHERE id=?", [pack.id]);
                if (kind === 'withdrawn') await db.queryDatabase("UPDATE automation_packages SET status='withdrawn' WHERE id=?", [pack.id]);
                if (kind === 'missing') await db.queryDatabase("UPDATE automation_packages SET latest_version=2,status='pending' WHERE id=?", [pack.id]);
            }
            assert.equal((await market.reviewPending()).state, 'idle');
            for (const table of ['automation_packages', 'automation_package_versions']) assert.equal(Number((await db.queryDatabase(`SELECT COUNT(*) AS n FROM ${table} WHERE status='pending'`))[0].n), 0);
        });
        await t.test('an edit during a failing legacy inspection is not rejected by the stale worker', async () => {
            const pack = await market.save(owner, input('競合する旧版'));
            await db.queryDatabase("UPDATE automation_packages SET status='pending',published_version=NULL WHERE id=?", [pack.id]);
            await db.queryDatabase("UPDATE automation_package_versions SET status='pending' WHERE package_id=?", [pack.id]);
            const racing = createMarketplace(db, { safety: { assertPublication: async () => {
                await market.save(owner, { ...input('利用者の新しい版'), expectedVersion: 1 }, pack.id);
                throw new Error('private checker diagnostic');
            } } });
            assert.equal((await racing.reviewPending()).state, 'changed');
            assert.equal((await market.get(reader, pack.id)).version, 2);
            const broken = createMarketplace(db, { safety: { assertPublication: async () => { throw new Error('private checker diagnostic'); } } });
            await assert.rejects(broken.save(owner, { ...input('失敗する変更'), expectedVersion: 2 }, pack.id), { code: 'PUBLICATION_CHECK_FAILED' });
            assert.equal((await market.get(reader, pack.id)).version, 2);
        });
    } finally { await db.close(); }
});
