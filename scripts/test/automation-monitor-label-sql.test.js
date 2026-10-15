'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = '222222222222222222', V = '333333333333333333';
const owner = { userId: U, guildId: '444444444444444444', canView: true, canEdit: true };

test('native display-label edits keep notification identity and optimistic concurrency', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), transaction = db.withDatabaseTransaction;
    const service = createService(db, { rateLimiter: createRateLimiter(db, { policy: { operations: { monitor: { minute: 1000, hour: 10000 } } } }) });
    let externalCalls = 0, next = 0;
    const forbidden = () => { externalCalls++; throw Error('A label must not normalize sources or create destinations'); };
    const monitors = createMonitors(db, service, { verifyChannel: forbidden }, { auto: { normalizeSource: forbidden }, price: { normalizeSource: forbidden }, normalizeRule: forbidden });
    async function fixture(kind, enabled = true) {
        const suffix = ++next;
        await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [U]);
        const source = kind === 'auto'
            ? await db.queryDatabase('INSERT INTO auto_watch_sources (provider_id,source_key,source_url,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES (?,?,?,1800000,123,1)', ['github', 'label' + suffix, 'https://github.com/label' + suffix])
            : await db.queryDatabase('INSERT INTO price_watch_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES (?,?,?,\'ja\',1800000,123,1)', ['steam', 'label' + suffix, 'https://store.steampowered.com/app/' + suffix]);
        const fields = kind === 'auto' ? ',premium_slot,source_locale' : ',watch_mode,rule_key';
        const values = kind === 'auto' ? ',0,\'ja\'' : ',\'change\',\'label-rule\'';
        const target = await db.queryDatabase(`INSERT INTO ${kind === 'auto' ? 'auto_watch' : 'price_watch'}_targets (source_id,user_id,destination_type,destination_key,enabled,baseline_at_ms,created_at_ms${fields}) VALUES (?,?,'dm',?,?,21,1${values})`, [source.insertId, U, 'dm:' + U, enabled ? 1 : 0]);
        await db.queryDatabase('INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,\'private\',1)', [kind, target.insertId, '元の表示名']);
        return String(target.insertId);
    }
    const state = async (kind, id) => (await db.queryDatabase(`SELECT * FROM ${kind === 'auto' ? 'auto_watch' : 'price_watch'}_targets WHERE id=?`, [id]))[0];
    try {
        for (const kind of ['auto', 'price']) {
            await t.test(`${kind}: one-save label change preserves every target field and records the harmless revision step`, async () => {
                const id = await fixture(kind), before = await state(kind, id);
                const result = await monitors.save(owner, kind, { name: '見分けやすい表示名', expectedRevision: 1 }, id);
                assert.deepEqual(result, { id, revision: 2 });
                assert.deepEqual(await state(kind, id), before);
                const row = (await db.queryDatabase('SELECT * FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, id]))[0];
                assert.equal(row.name, '見分けやすい表示名'); assert.equal(Number(row.revision), 2);
                const audit = (await db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='monitor.rename'", [`${kind}:${id}`]))[0];
                assert.deepEqual(JSON.parse(audit.detail_json), { manual: true, metadataOnly: true, ownerUserId: U, beforeRevision: 1, afterRevision: 2 });
                assert.equal(await require('../../src/automation/monitor-revision-compat').monitorRevisionCompatible(db.queryDatabase, { kind, targetId: id, ownerUserId: U, expectedRevision: 1, currentRevision: 2 }), true);
                assert.equal(externalCalls, 0);
            });
            await t.test(`${kind}: stale concurrent label saves do not overwrite each other`, async () => {
                const id = await fixture(kind);
                const results = await Promise.allSettled(['表示名A', '表示名B'].map(name => monitors.save(owner, kind, { name, expectedRevision: 1 }, id)));
                assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
                assert.equal(results.find(row => row.status === 'rejected').reason.code, 'REVISION_CONFLICT');
                const result = (await db.queryDatabase('SELECT revision FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, id]))[0];
                assert.equal(Number(result.revision), 2);
            });
            await t.test(`${kind}: an audit failure rolls the label and revision back`, async () => {
                const id = await fixture(kind), original = db.withDatabaseTransaction;
                db.withDatabaseTransaction = work => transaction(query => work((sql, params) => {
                    if (sql.startsWith('INSERT INTO automation_audit')) throw Error('Synthetic audit failure');
                    return query(sql, params);
                }));
                try { await assert.rejects(monitors.save(owner, kind, { name: '失敗時は残さない', expectedRevision: 1 }, id), /Synthetic audit failure/); }
                finally { db.withDatabaseTransaction = original; }
                const row = (await db.queryDatabase('SELECT name,revision FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, id]))[0];
                assert.equal(row.name, '元の表示名'); assert.equal(Number(row.revision), 1);
            });
            await t.test(`${kind}: another owner cannot rename a private monitor`, async () => {
                const id = await fixture(kind);
                await assert.rejects(monitors.save({ ...owner, userId: V }, kind, { name: '不正な変更', expectedRevision: 1 }, id), { status: 404 });
            });
            await t.test(`${kind}: stopped notifications remain stopped and a retried unchanged label does not advance revision`, async () => {
                const id = await fixture(kind, false), before = await state(kind, id);
                assert.deepEqual(await monitors.save(owner, kind, { name: '元の表示名', expectedRevision: 1 }, id), { id, revision: 1 });
                await monitors.save(owner, kind, { name: '停止中の表示名', expectedRevision: 1 }, id);
                assert.deepEqual(await state(kind, id), before);
            });
        }
        await t.test('a price completion holding its source and a concurrent label save both commit without losing the notification', async () => {
            const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/priceWatch/store')];
            const originals = paths.map(path => require.cache[path]), originalTransaction = db.withDatabaseTransaction;
            let releaseCompletion;
            const completionGate = new Promise(resolve => { releaseCompletion = resolve; });
            let completionLocked, renameLockAttempted;
            const sourceHeld = new Promise(resolve => { completionLocked = resolve; }), renameWaiting = new Promise(resolve => { renameLockAttempted = resolve; });
            const bounded = async promise => {
                let timer;
                try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Concurrent price label fixture did not reach its lock barrier')), 5000); })]); }
                finally { clearTimeout(timer); }
            };
            let settled;
            try {
                require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: db };
                require.cache[paths[1]] = { ...originals[1], exports: { ...originals[1].exports, ensureDatabaseSchema: async () => {} } };
                delete require.cache[paths[2]];
                const store = require(paths[2]), id = await fixture('price'), target = await state('price', id), now = Date.now();
                await db.queryDatabase('UPDATE price_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', ['concurrent-label-fetch', now + 60000, target.source_id]);
                const source = (await db.queryDatabase('SELECT * FROM price_watch_sources WHERE id=?', [target.source_id]))[0];
                db.withDatabaseTransaction = work => transaction(query => work(async (sql, params) => {
                    if (sql.includes('UPDATE price_watch_sources') && sql.includes('SET product_name=')) {
                        const result = await query(sql, params); completionLocked(); await completionGate; return result;
                    }
                    // Execute the lock request before releasing the source
                    // completion, so this exercises the actual InnoDB conflict.
                    if (sql.startsWith('SELECT id FROM price_watch_sources') || sql.includes('FROM price_watch_targets t JOIN price_watch_sources')) {
                        const result = query(sql, params); renameLockAttempted(); return result;
                    }
                    return query(sql, params);
                }));
                const completing = store.completeSource(source, { productName: 'Concurrent retained product' }, [{ targetId: id, eventKey: 'concurrent-label-fetch', messageText: '保持する価格通知' }],
                    [{ targetId: id, conditionActive: true, ruleKey: target.rule_key, destinationKey: target.destination_key, configurationRevision: 1 }], now, now + 300000);
                await bounded(sourceHeld);
                const renaming = monitors.save(owner, 'price', { name: '同時取得中の表示名', expectedRevision: 1 }, id);
                settled = Promise.allSettled([completing, renaming]);
                await bounded(renameWaiting); releaseCompletion();
                const results = await bounded(settled);
                assert.deepEqual(results.map(result => ({ status: result.status, code: result.reason?.code })), [{ status: 'fulfilled', code: undefined }, { status: 'fulfilled', code: undefined }]);
                assert.equal(results[1].value.revision, 2);
                const deliveries = await db.queryDatabase('SELECT event_key,message_text,status FROM price_watch_deliveries WHERE target_id=?', [id]);
                assert.deepEqual(deliveries.map(row => ({ ...row })), [{ event_key: 'concurrent-label-fetch', message_text: '保持する価格通知', status: 'pending' }]);
                assert.equal(Number((await state('price', id)).condition_active), 1);
            } finally {
                releaseCompletion(); if (settled) await settled;
                db.withDatabaseTransaction = originalTransaction;
                paths.forEach((path, index) => { if (originals[index]) require.cache[path] = originals[index]; else delete require.cache[path]; });
            }
        });
        await t.test('a price fetch finishing after a label edit retains the notification; a functional revision still invalidates it', async () => {
            const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/priceWatch/store')];
            const originals = paths.map(path => require.cache[path]);
            try {
                require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: db };
                require.cache[paths[1]] = { ...originals[1], exports: { ...originals[1].exports, ensureDatabaseSchema: async () => {} } };
                delete require.cache[paths[2]];
                const store = require(paths[2]), id = await fixture('price'), target = await state('price', id), now = Date.now();
                async function complete(revision, eventKey) {
                    await db.queryDatabase('UPDATE price_watch_sources SET lease_token=?,lease_expires_at_ms=? WHERE id=?', [eventKey, now + 60000, target.source_id]);
                    const source = (await db.queryDatabase('SELECT * FROM price_watch_sources WHERE id=?', [target.source_id]))[0];
                    await store.completeSource(source, { productName: '商品名' }, [{ targetId: id, eventKey, messageText: '保持する価格通知' }],
                        [{ targetId: id, conditionActive: true, ruleKey: target.rule_key, destinationKey: target.destination_key, configurationRevision: revision }], now, now + 300000);
                }
                await monitors.save(owner, 'price', { name: '表示名を修正', expectedRevision: 1 }, id);
                await complete(1, 'after-label');
                const deliveries = await db.queryDatabase('SELECT event_key,message_text,status FROM price_watch_deliveries WHERE target_id=?', [id]);
                assert.deepEqual(deliveries.map(row => ({ ...row })), [{ event_key: 'after-label', message_text: '保持する価格通知', status: 'pending' }]);
                assert.equal(Number((await state('price', id)).condition_active), 1);
                await db.queryDatabase("UPDATE automation_monitors SET revision=revision+1 WHERE target_kind='price' AND target_id=?", [id]);
                await complete(2, 'after-functional-edit');
                assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM price_watch_deliveries WHERE target_id=?', [id]))[0].n), 1);
            } finally {
                paths.forEach((path, index) => { if (originals[index]) require.cache[path] = originals[index]; else delete require.cache[path]; });
            }
        });
    } finally { db.withDatabaseTransaction = transaction; await db.close(); }
});
