'use strict';

// This suite executes the actual service/API/monitor paths against a fresh
// random loopback schema. Provider adapters only normalize fixture URLs; no
// Discord calls, production DB configuration, or payment grants are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { dispatch } = require('../../src/automation/api');
const schema = require('../../src/automation/schema');
const format = require('../../src/automation/format');
const entitlements = require('../../src/automation/entitlements');
const { createRateLimiter } = require('../../src/automation/rate-limits');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const actor = value => ({ userId: String(value).padEnd(18, '0'), guildId: '111111111111111111', canView: true, canEdit: true });
const operationOptions = (minute = 30) => ({ rateOptions: { policy: { operations: { write: { minute } } } } });
const request = (method, path, body = {}, search = new URLSearchParams()) => ({ method, path: path.split('/'), body, search });
function amplified() {
    const rule = schema.newWorkflow('legacy amplified'); rule.edges = []; let previous = 'start';
    for (let i = 0; i < 6; i++) {
        for (const suffix of ['left', 'right', 'join']) rule.nodes.push({ id: `${suffix}${i}`, type: 'transform', config: structuredClone(schema.NODE_TYPES.transform.defaults) });
        for (const [source, target] of [[previous, `left${i}`], [previous, `right${i}`], [`left${i}`, `join${i}`], [`right${i}`, `join${i}`]]) rule.edges.push({ id: `e${rule.edges.length}`, source, target, port: 'out' });
        previous = `join${i}`;
    }
    rule.edges.push({ id: `e${rule.edges.length}`, source: previous, target: 'send', port: 'out' }); return rule;
}

test('real SQL: server service policies survive instances and guard actual API/monitor writes', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const counterValues = async () => (await db.queryDatabase('SELECT used_count FROM automation_counters ORDER BY counter_key')).map(row => Number(row.used_count));
    const clearCounters = () => db.queryDatabase('DELETE FROM automation_counters');
    await t.test('direct service plus API share durable operation counters across newly constructed instances', async () => {
        await clearCounters(); const owner = actor(2), service = createService(db, operationOptions(2));
        await service.createWorkflow(owner, { definition: schema.newWorkflow('direct') });
        await dispatch(request('POST', 'workflows', { definition: schema.newWorkflow('api') }), owner, { db, service: createService(db, operationOptions(2)) });
        assert.deepEqual(await counterValues(), [2, 2]);
        await assert.rejects(createService(db, operationOptions(2)).createWorkflow(owner, { definition: schema.newWorkflow('denied') }), error => error.code === 'AUTOMATION_RATE_LIMITED' && error.status === 429 && error.retryAfterMs > 0 && typeof error.issues[0].path === 'string');
        assert.equal((await createService(db).list('workflow', owner)).items.length, 2);
    });
    await t.test('nested same-group service/API operations charge only once', async () => {
        await clearCounters(); const owner = actor(3), service = createService(db);
        await service.withOperation(owner, 'write', () => dispatch(request('POST', 'workflows', { definition: schema.newWorkflow('nested') }), owner, { db, service }));
        assert.deepEqual(await counterValues(), [1, 1]);
    });
    await t.test('exhausted write quota still permits pause, history and delete, while resume is denied', async () => {
        await clearCounters(); const owner = actor(4), service = createService(db, operationOptions(2));
        const rule = await service.createWorkflow(owner, { definition: schema.newWorkflow('can stop') });
        await service.activateWorkflow(owner, rule.id, { expectedRevision: 1 });
        await assert.rejects(dispatch(request('POST', `workflows/${rule.id}/state`, { enabled: true, expectedRevision: 1 }), owner, { db, service }), { status: 429 });
        const paused = await dispatch(request('POST', `workflows/${rule.id}/state`, { enabled: false, expectedRevision: 1 }), owner, { db, service });
        assert.equal(paused.enabled, false); assert.equal(paused.revision, 2);
        assert.equal((await dispatch(request('GET', `workflows/${rule.id}/history`), owner, { db, service })).length, 1);
        assert.deepEqual(await counterValues(), [2, 2]);
        assert.deepEqual(await dispatch(request('DELETE', `workflows/${rule.id}`, { expectedRevision: 2 }), owner, { db, service }), { deleted: true });
    });
    await t.test('legacy amplified applied snapshots cannot resume or restore, but can always pause', async () => {
        await clearCounters(); const owner = actor(5), service = createService(db), rule = await service.createWorkflow(owner, { definition: schema.newWorkflow('old') });
        const old = amplified(), body = JSON.stringify(old), bindings = JSON.stringify({ destinations: {}, dictionaries: {} });
        await db.queryDatabase('UPDATE automation_revisions SET definition_json=?,bindings_json=?,checksum=? WHERE workflow_id=? AND revision=1', [body, bindings, hash(body + bindings), rule.id]);
        await db.queryDatabase('UPDATE automation_workflows SET active_revision=1,enabled=1 WHERE id=?', [rule.id]);
        const rejected = error => error.code === 'AUTOMATION_RULE_INVALID' && error.issues.some(issue => issue.code === 'AUTOMATION_FANOUT_LIMIT' && issue.nodeId === 'send');
        await assert.rejects(service.setWorkflowState(owner, rule.id, { expectedRevision: 1, enabled: true }), rejected);
        await assert.rejects(service.restoreRevision(owner, rule.id, 1, 1), rejected);
        const unchanged = await service.getWorkflow(owner, rule.id); assert.equal(unchanged.revision, 1); assert.equal(unchanged.draft.name, 'old');
        assert.equal((await service.setWorkflowState(owner, rule.id, { expectedRevision: 1, enabled: false })).enabled, false);
    });
    await t.test('definition, JSON and YAML validation retain safe node feedback without persisting rejected rules', async () => {
        await clearCounters(); const owner = actor(6), service = createService(db), services = { db, service, schema, format };
        const rule = amplified();
        const result = await dispatch(request('POST', 'validate', { definition: rule }), owner, services);
        assert.equal(result.valid, false); assert.equal(result.definition, undefined); assert.equal(typeof result.text, 'string');
        assert(result.issues.some(issue => issue.code === 'AUTOMATION_FANOUT_LIMIT' && issue.nodeId === 'send' && issue.path === '$.nodes[1]'));
        for (const encoding of ['json', 'yaml']) await assert.rejects(dispatch(request('POST', 'validate', { text: format.stringifyDraft(rule, encoding), format: encoding }), owner, services), error => error.code === 'AUTOMATION_RULE_INVALID' && error.issues.some(issue => issue.code === 'AUTOMATION_FANOUT_LIMIT' && issue.nodeId === 'send' && issue.path === '$.nodes[1]'));
        await assert.rejects(dispatch(request('POST', 'workflows', { definition: rule }), owner, services), { code: 'AUTOMATION_RULE_INVALID' });
        assert.equal((await service.list('workflow', owner)).items.length, 0);
    });
    await t.test('admin plans require trusted admin identity; client paid fields cannot grant entitlement', async () => {
        await clearCounters(); const owner = actor(7), admin = { ...actor(8), isAdmin: true }, service = createService(db), services = { db, service };
        const policy = { planId: 'fixture-only', label: 'テスト専用', slotLimit: 8, minuteLimit: 9, dayLimit: 50, priority: 2 };
        await assert.rejects(dispatch(request('POST', 'plans', { ...policy, isAdmin: true }), owner, services), { status: 403 });
        await assert.rejects(dispatch(request('POST', `entitlements/${owner.userId}`, { planId: policy.planId, isAdmin: true }), owner, services), { status: 403 });
        assert.deepEqual((await entitlements.listPlanPolicies(db.queryDatabase, admin)).map(plan => plan.planId), ['free', 'supporter']);
        await dispatch(request('POST', 'workflows', { definition: schema.newWorkflow('client fields'), planId: policy.planId, tier: 'paid', isDonor: true, slotLimit: 999 }), owner, services);
        let info = await dispatch(request('GET', 'entitlements', {}, new URLSearchParams({ userId: admin.userId })), owner, services);
        assert.equal(info.plan.tier, 'free'); assert.equal(info.plan.slotLimit, 5); assert.equal(info.plan.dayLimit, 24); assert.equal(info.plan.minuteLimit, 5);
        await dispatch(request('POST', 'plans', policy), admin, services);
        await dispatch(request('POST', `entitlements/${owner.userId}`, { planId: policy.planId }), admin, services);
        info = await dispatch(request('GET', 'entitlements'), owner, services); assert.equal(info.plan.tier, 'paid'); assert.equal(info.plan.slotLimit, 8);
    });
    await t.test('optimistic conflict and immutable snapshot conflict preserve the current draft', async () => {
        await clearCounters(); const owner = actor(9), service = createService(db), rule = await service.createWorkflow(owner, { definition: schema.newWorkflow('before') });
        await service.updateWorkflow(owner, rule.id, { expectedRevision: 1, definition: schema.newWorkflow('after') });
        await assert.rejects(service.updateWorkflow(owner, rule.id, { expectedRevision: 1, definition: schema.newWorkflow('stale') }), { code: 'REVISION_CONFLICT' });
        await db.queryDatabase('UPDATE automation_revisions SET checksum=? WHERE workflow_id=? AND revision=2', ['0'.repeat(64), rule.id]);
        await assert.rejects(service.activateWorkflow(owner, rule.id, { expectedRevision: 2 }), { code: 'REVISION_SNAPSHOT_CONFLICT' });
        const current = await service.getWorkflow(owner, rule.id); assert.equal(current.revision, 2); assert.equal(current.draft.name, 'after'); assert.equal(current.enabled, false);
    });
    await t.test('actual monitors.save combines auto and price slots, keeps paused slots and prevents reset by recreation', async () => {
        await clearCounters(); const owner = actor(10), stranger = actor(11), service = createService(db), monitors = createMonitors(db, service, {});
        const dm = await service.saveDestination(owner, { scope: 'private', name: 'DM', kind: 'dm' });
        const priceInput = id => ({ providerId: 'steam', source: `https://store.steampowered.com/app/${id}/`, destinationId: dm.id, scope: 'private', name: `price${id}`, mode: 'change', planId: 'forged-premium', tier: 'paid', slotLimit: 999 });
        const watches = [];
        watches.push({ kind: 'auto', ...await monitors.save(owner, 'auto', { providerId: 'github', source: 'octocat', destinationId: dm.id, scope: 'private', name: 'auto' }) });
        for (let i = 0; i < 4; i++) watches.push({ kind: 'price', ...await monitors.save(owner, 'price', priceInput(440 + i)) });
        const original = await entitlements.getEntitlementSummary(db, owner.userId); assert.equal(original.usedSlots, 5); assert.equal(original.tier, 'free');
        await assert.rejects(monitors.save(owner, 'price', priceInput(900)), { code: 'AUTOMATION_SLOT_LIMIT', status: 422 });
        const first = watches[1], slot = await entitlements.resolveNotificationEntitlement(db, { ownerUserId: owner.userId, targetKind: 'price', targetId: first.id });
        const reservation = await createRateLimiter(db).reserveNotifications({ ...slot, ownerUserId: owner.userId }, 5);
        for (let i = 0; i < 5; i++) await createRateLimiter(db).commitNotification(reservation, i);
        let paused = await monitors.save(owner, 'price', { expectedRevision: 1, enabled: false }, first.id);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 5);
        await assert.rejects(monitors.save(owner, 'price', priceInput(900)), { code: 'AUTOMATION_SLOT_LIMIT' });
        paused = await monitors.save(owner, 'price', { expectedRevision: paused.revision, enabled: true }, first.id);
        assert.equal((await monitors.list(owner, 'price')).items.find(item => item.id === first.id).enabled, true);
        const other = await dispatch(request('GET', 'entitlements', {}, new URLSearchParams({ userId: owner.userId })), stranger, { db, service });
        assert.equal(other.slots.used, 0); assert.deepEqual(other.usage.entries, []); assert.equal((await monitors.list(stranger, 'price')).items.length, 0);
        await monitors.remove(owner, 'price', first.id, paused.revision);
        assert.equal((await db.queryDatabase('SELECT target_id FROM automation_notification_slots WHERE owner_user_id=? AND slot_index=?', [owner.userId, slot.slotIndex]))[0].target_id, null);
        const replacement = await monitors.save(owner, 'price', priceInput(900));
        const reused = await entitlements.resolveNotificationEntitlement(db, { ownerUserId: owner.userId, targetKind: 'price', targetId: replacement.id });
        assert.equal(reused.slotId, slot.slotId);
        await assert.rejects(createRateLimiter(db).reserveNotifications({ ...reused, ownerUserId: owner.userId }, 1), { code: 'AUTOMATION_RATE_LIMITED' });
        assert.equal((await createRateLimiter(db).getSlotUsage(reused.slotId)).todayUsed, 5);
    });
    await t.test('six price-only monitor registrations cannot evade the common user cap', async () => {
        await clearCounters(); const owner = actor(12), service = createService(db), monitors = createMonitors(db, service, {});
        const dm = await service.saveDestination(owner, { scope: 'private', name: 'DM', kind: 'dm' });
        for (let i = 0; i < 5; i++) await monitors.save(owner, 'price', { providerId: 'steam', source: `https://store.steampowered.com/app/${1000 + i}/`, destinationId: dm.id, name: `watch${i}`, mode: 'change' });
        await assert.rejects(monitors.save(owner, 'price', { providerId: 'steam', source: 'https://store.steampowered.com/app/2000/', destinationId: dm.id, name: 'overflow', mode: 'change' }), { code: 'AUTOMATION_SLOT_LIMIT', status: 422 });
        assert.equal((await monitors.list(owner, 'price')).items.length, 5);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 5);
    });
    await t.test('exhausted monitor operation quota still allows actual pause and deletion', async () => {
        await clearCounters(); const owner = actor(13), service = createService(db, { rateOptions: { policy: { operations: { monitor: { minute: 1 } } } } }), monitors = createMonitors(db, service, {});
        const dm = await service.saveDestination(owner, { scope: 'private', name: 'DM', kind: 'dm' }), services = { db, service, monitors };
        const watch = await dispatch(request('POST', 'monitors/price', { providerId: 'steam', source: 'https://store.steampowered.com/app/3000/', destinationId: dm.id, name: 'quota', mode: 'change' }), owner, services);
        await assert.rejects(dispatch(request('PATCH', `monitors/price/${watch.id}`, { expectedRevision: 1, enabled: true }), owner, services), { status: 429 });
        const paused = await dispatch(request('PATCH', `monitors/price/${watch.id}`, { expectedRevision: 1, enabled: false }), owner, services);
        assert.equal((await monitors.list(owner, 'price')).items[0].enabled, false);
        await dispatch(request('DELETE', `monitors/price/${watch.id}`, { expectedRevision: paused.revision }), owner, services);
        assert.equal((await entitlements.getEntitlementSummary(db, owner.userId)).usedSlots, 0);
    });
});
