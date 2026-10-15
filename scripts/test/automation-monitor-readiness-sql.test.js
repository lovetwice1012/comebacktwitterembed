'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { newWorkflow } = require('../../src/automation/schema');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const U = '222222222222222222', V = '333333333333333333', actor = { userId: U };
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('monitor readiness reads current rules and destinations independently of resource pagination', { skip: !port }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase; t.after(() => db.close());
    const service = createService(db, { rateLimiter: { consumeOperation: async () => {} } }), monitors = createMonitors(db, service, {});
    const foreignRule = await service.createWorkflow({ userId: V }, { definition: newWorkflow('Private foreign name must not appear') });
    const workflow = await service.createWorkflow(actor, { definition: newWorkflow('Ready rule') });
    for (const kind of ['auto', 'price']) {
        const table = kind === 'auto' ? 'auto_watch' : 'price_watch', destinationId = randomUUID();
        await query('INSERT IGNORE INTO users(user_id,registered_at_ms) VALUES (?,0)', [U]);
        const source = kind === 'auto'
            ? await query("INSERT INTO auto_watch_sources(provider_id,source_key,source_url,poll_interval_ms,created_at_ms) VALUES('github',?,'https://github.com/readiness',1800000,0)", [randomUUID()])
            : await query("INSERT INTO price_watch_sources(provider_id,product_key,product_url,source_locale,poll_interval_ms,created_at_ms) VALUES('steam',?,'https://store.steampowered.com/app/730','ja',1800000,0)", [randomUUID()]);
        const target = await query(`INSERT INTO ${table}_targets(source_id,user_id,destination_type,destination_key,enabled,created_at_ms${kind === 'price' ? ',watch_mode,rule_key' : ''}) VALUES(?,?,'dm',?,1,0${kind === 'price' ? ",'change','ready-rule'" : ''})`, [source.insertId, U, 'dm:' + U]);
        const id = String(target.insertId);
        await query("INSERT INTO automation_destinations(id,owner_user_id,scope,name,kind,dm_user_id,enabled,created_at_ms,updated_at_ms) VALUES(?,?,'private','Ready DM','dm',?,1,0,0)", [destinationId, U, U]);
        await query("INSERT INTO automation_monitors(target_kind,target_id,name,scope,destination_id,revision) VALUES(?,?,'Ready monitor','private',?,1)", [kind, id, destinationId]);
        const current = async (state = 'all') => (await monitors.list(actor, kind, '0', { state })).items.find(row => row.id === id);
        await t.test(`${kind}: the default notification has no artificial rule requirement`, async () => {
            const row = await current(); assert.equal(row.workflowStatus, null); assert.equal(row.destinationStatus, 'active'); assert.ok(await current('active')); assert.equal(await current('attention'), undefined);
        });
        await t.test(`${kind}: unapplied paused and missing rules have distinct verified status`, async () => {
            await query('INSERT INTO automation_assignments(target_kind,target_id,workflow_id,created_at_ms) VALUES(?,?,?,0)', [kind, id, workflow.id]);
            await query('UPDATE automation_workflows SET active_revision=NULL,enabled=0,deleted_at_ms=NULL WHERE id=?', [workflow.id]);
            assert.equal((await current()).workflowStatus, 'unapplied'); assert.ok(await current('attention')); assert.equal(await current('active'), undefined);
            await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 }); assert.equal((await current()).workflowStatus, 'active'); assert.ok(await current('active'));
            await query('UPDATE automation_workflows SET enabled=0 WHERE id=?', [workflow.id]); assert.equal((await current()).workflowStatus, 'paused');
            await query('UPDATE automation_workflows SET deleted_at_ms=1 WHERE id=?', [workflow.id]); assert.equal((await current()).workflowStatus, 'missing');
            await query('UPDATE automation_assignments SET workflow_id=? WHERE target_kind=? AND target_id=?', [foreignRule.id, kind, id]);
            const row = await current(); assert.equal(row.workflowStatus, 'missing'); assert(!JSON.stringify(row).includes('Private foreign name'));
            assert.equal((await monitors.list({ userId: V }, kind)).items.some(item => item.id === id), false);
            await query('DELETE FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, id]);
        });
        await t.test(`${kind}: disabled deleted missing and foreign destinations are never healthy`, async () => {
            await query('UPDATE automation_destinations SET enabled=0 WHERE id=?', [destinationId]); assert.equal((await current()).destinationStatus, 'paused'); assert.ok(await current('attention'));
            await query('UPDATE automation_destinations SET enabled=1,deleted_at_ms=1 WHERE id=?', [destinationId]); assert.equal((await current()).destinationStatus, 'missing');
            await query('UPDATE automation_destinations SET deleted_at_ms=NULL,owner_user_id=? WHERE id=?', [V, destinationId]); assert.equal((await current()).destinationStatus, 'missing');
            await query('UPDATE automation_monitors SET destination_id=? WHERE target_kind=? AND target_id=?', [randomUUID(), kind, id]); assert.equal((await current()).destinationStatus, 'missing');
            await query('UPDATE automation_monitors SET destination_id=NULL WHERE target_kind=? AND target_id=?', [kind, id]); assert.equal((await current()).destinationStatus, null); assert.ok(await current('active'));
        });
    }
    await t.test('X readiness verifies private resources without changing monitor identity, reservations or revision', async () => {
        const x = createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' });
        const rule = await service.createWorkflow(actor, { definition: newWorkflow('X selected rule') });
        const destination = await service.saveDestination(actor, { kind: 'dm', name: 'X own DM' });
        const saved = await x.register(actor, { accountHandle: 'readiness_case', notificationSettings: { workflowId: rule.id, destinationId: destination.id } });
        assert.equal(saved.workflowStatus, 'unapplied'); assert.equal(saved.destinationStatus, 'active');
        const current = async () => (await x.list(actor)).items.find(item => item.id === saved.id);
        await service.activateWorkflow(actor, rule.id, { expectedRevision: 1 }); assert.equal((await current()).workflowStatus, 'active');
        await query('UPDATE automation_workflows SET enabled=0 WHERE id=?', [rule.id]); assert.equal((await current()).workflowStatus, 'paused');
        await query('UPDATE automation_destinations SET enabled=0 WHERE id=?', [destination.id]); assert.equal((await current()).destinationStatus, 'paused');
        await query('UPDATE automation_workflows SET deleted_at_ms=1 WHERE id=?', [rule.id]); assert.equal((await current()).workflowStatus, 'missing');
        await query('UPDATE automation_destinations SET owner_user_id=? WHERE id=?', [V, destination.id]);
        const before = (await query('SELECT * FROM automation_x_monitors WHERE id=?', [saved.id]))[0];
        const status = await current(); assert.equal(status.destinationStatus, 'missing'); assert.equal(status.poolKind, saved.poolKind); assert.equal(status.revision, saved.revision);
        assert.deepEqual((await query('SELECT * FROM automation_x_monitors WHERE id=?', [saved.id]))[0], before);
        assert.equal((await x.list({ userId: V })).items.some(item => item.id === saved.id), false);
    });
});
