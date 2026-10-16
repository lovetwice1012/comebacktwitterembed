'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module'), { compileFunction } = require('node:vm');
const { createTestDatabase, grantTestDonor } = require('../lib/automation-test-db');
const { createService, hash } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const { createDestinations, VIEW, SEND } = require('../../src/automation/destinations');
const { newWorkflow } = require('../../src/automation/schema');
const { dispatch } = require('../../src/automation/api');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const A = '222111111111111111', B = '222222222222222222', D = '222333333333333333';
const G = '111111111111111111', C = '333111111111111111', CUSTOM = '333222222222222222', BOT = '444111111111111111';
const actor = userId => ({ userId, guildId: G, canView: true, canEdit: true });
const definition = custom => { const rule = newWorkflow('Actual delivery principal'); if (custom) rule.nodes.find(node => node.type === 'send').config.destination = 'alerts'; return rule; };

async function fixture(work) {
    const db = await createTestDatabase(port), query = db.queryDatabase, denied = new Map(), calls = []; let unavailable = false;
    const service = createService(db, { verifyChannel: (principal, guild, channel) => destinations.verifyChannel(principal, guild, channel),
        rateOptions: { policy: { operations: { write: { minute: 1000, hour: 1000 }, monitor: { minute: 1000, hour: 1000 } } } } });
    const rest = async route => {
        calls.push(route); if (unavailable) throw Object.assign(new Error('Synthetic private upstream error'), { status: 503 });
        if (route === `/guilds/${G}`) return { data: { id: G, owner_id: BOT } };
        if (route === `/guilds/${G}/roles`) return { data: [{ id: G, permissions: String(VIEW | SEND) }] };
        if (route === '/users/@me') return { data: { id: BOT } };
        if (route.startsWith(`/guilds/${G}/members/`)) return { data: { user: { id: route.split('/').at(-1) }, roles: [] } };
        if ([`/channels/${C}`, `/channels/${CUSTOM}`].includes(route)) return { data: { id: route.split('/').at(-1), guild_id: G, type: 0,
            permission_overwrites: route.endsWith(CUSTOM) ? [...denied].map(([id, flag]) => ({ id, type: 1, deny: String(flag), allow: '0' })) : [] } };
        assert.fail(`Unexpected external fixture request: ${route}`);
    };
    const destinations = createDestinations(db, service, { rest }), monitors = createMonitors(db, service, destinations);
    async function destination(who = B, scope = 'guild', channelId = CUSTOM) {
        const url = `https://discord.com/api/webhooks/555111111111111111/${randomUUID().replaceAll('-', '')}`;
        const endpoint = await query('INSERT INTO webhook_endpoints (webhook_url_hash,webhook_url) VALUES (?,?)', [hash(url), url]);
        return (await service.saveDestination(actor(who), { name: 'Synthetic destination', kind: 'webhook', scope }, { webhookEndpointId: String(endpoint.insertId), guildId: G, channelId })).id;
    }
    async function monitor(kind, owner = A) {
        const destinationId = await destination(owner, 'guild', C), key = randomUUID().replaceAll('-', '');
        return monitors.save(actor(owner), kind, { scope: 'guild', name: 'Consumer', destinationId, providerId: kind === 'auto' ? 'github' : 'steam',
            source: kind === 'auto' ? `u${key.slice(0, 12)}` : `https://store.steampowered.com/app/${100000 + Math.floor(Math.random() * 10000000)}`, ...(kind === 'price' ? { mode: 'change' } : {}) });
    }
    async function workflow(custom = false, who = B, scope = 'guild') {
        const dest = custom ? await destination(who, scope) : null;
        const rule = await service.createWorkflow(actor(who), { scope, definition: definition(custom), bindings: custom ? { destinations: { alerts: dest } } : {} });
        await service.activateWorkflow(actor(who), rule.id, { expectedRevision: 1 }); return { ...rule, dest };
    }
    async function state(id, kind, targetId) {
        return { workflow: await query('SELECT * FROM automation_workflows WHERE id=?', [id]), target: await query(`SELECT * FROM ${kind === 'auto' ? 'auto_watch' : 'price_watch'}_targets WHERE id=?`, [targetId]), assignments: await query('SELECT * FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, targetId]),
            monitor: await query('SELECT * FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, targetId]), slots: await query('SELECT * FROM automation_notification_slots ORDER BY owner_user_id,slot_index'), audit: await query('SELECT * FROM automation_audit ORDER BY id') };
    }
    try {
        for (const owner of [A, B, D]) await grantTestDonor(db, owner);
        await work({ db, query, service, monitors, destinations, destination, monitor, workflow, state, denied, calls, setUnavailable: value => { unavailable = value; } });
    } finally { await db.close(); }
}

for (const kind of ['auto', 'price']) test(`S24-1 ${kind} shared attach verifies editor and actual target owner before any assignment mutation`, { skip: !port }, async () => fixture(async f => {
    const target = await f.monitor(kind), rule = await f.workflow(true); const before = await f.state(rule.id, kind, target.id);
    for (const flag of [VIEW, SEND]) {
        f.denied.set(A, flag); f.calls.length = 0;
        await assert.rejects(f.service.attach(actor(B), rule.id, kind, target.id), { code: 'CHANNEL_PERMISSION', status: 403 });
        assert.deepEqual(await f.state(rule.id, kind, target.id), before); assert(f.calls.includes(`/guilds/${G}/members/${A}`));
    }
    f.denied.clear(); f.denied.set(B, SEND);
    await assert.rejects(f.service.attach(actor(B), rule.id, kind, target.id), { code: 'CHANNEL_PERMISSION' }); assert.deepEqual(await f.state(rule.id, kind, target.id), before);
    f.denied.clear(); f.setUnavailable(true);
    await assert.rejects(f.service.attach(actor(B), rule.id, kind, target.id), error => error.code === 'DISCORD_UNAVAILABLE' && !error.message.includes('private upstream')); f.setUnavailable(false);
    assert.deepEqual(await f.state(rule.id, kind, target.id), before);
    await f.service.attach(actor(B), rule.id, kind, target.id);
    assert.equal((await f.query(`SELECT user_id FROM ${kind === 'auto' ? 'auto_watch' : 'price_watch'}_targets WHERE id=?`, [target.id]))[0].user_id, A);
    // An unchanged attach must still recheck fresh permissions.
    f.denied.set(A, SEND); await assert.rejects(f.service.attach(actor(B), rule.id, kind, target.id), { code: 'CHANNEL_PERMISSION' });
}));

test('S24-1 activation checks every attached owner under the reviewed roster for API and direct callers', { skip: !port }, async () => fixture(async f => {
    const first = await f.monitor('auto', A), second = await f.monitor('price', D), rule = await f.workflow();
    await f.service.attach(actor(B), rule.id, 'auto', first.id); await f.service.attach(actor(B), rule.id, 'price', second.id);
    const custom = await f.destination(); await f.service.updateWorkflow(actor(B), rule.id, { expectedRevision: 1, definition: definition(true), bindings: { destinations: { alerts: custom } } });
    const preview = await f.service.activationPreview(actor(B), rule.id), before = await f.state(rule.id, 'auto', first.id);
    f.denied.set(D, VIEW);
    await assert.rejects(dispatch({ method: 'POST', path: ['workflows', rule.id, 'activate'], body: preview }, actor(B), { service: f.service }), { code: 'CHANNEL_PERMISSION' });
    assert.deepEqual(await f.state(rule.id, 'auto', first.id), before); assert(f.calls.includes(`/guilds/${G}/members/${D}`));
    await assert.rejects(f.service.activateWorkflow(actor(B), rule.id, { expectedRevision: 2 }), { code: 'CHANNEL_PERMISSION' });
    f.denied.clear(); assert.equal((await f.service.activateWorkflow(actor(B), rule.id, preview)).activeRevision, 2);
}));

test('S24-1 workflow resume validates the immutable active bindings while a different draft remains unapplied', { skip: !port }, async () => fixture(async f => {
    const target = await f.monitor('auto'), rule = await f.workflow(true); await f.service.attach(actor(B), rule.id, 'auto', target.id);
    await f.service.setWorkflowState(actor(B), rule.id, { expectedRevision: 1, enabled: false });
    await f.service.updateWorkflow(actor(B), rule.id, { expectedRevision: 2, definition: definition(false), bindings: {} });
    const before = await f.state(rule.id, 'auto', target.id); f.denied.set(A, SEND);
    await assert.rejects(f.service.setWorkflowState(actor(B), rule.id, { expectedRevision: 3, enabled: true }), { code: 'CHANNEL_PERMISSION' });
    assert.deepEqual(await f.state(rule.id, 'auto', target.id), before); f.denied.clear();
    const resumed = await f.service.setWorkflowState(actor(B), rule.id, { expectedRevision: 3, enabled: true }); assert.equal(resumed.enabled, true);
    assert.equal(Number((await f.query('SELECT active_revision FROM automation_workflows WHERE id=?', [rule.id]))[0].active_revision), 1);
}));

for (const kind of ['auto', 'price']) test(`S24-1 ${kind} monitor resume verifies custom workflow channels as well as its default destination`, { skip: !port }, async () => fixture(async f => {
    const target = await f.monitor(kind), rule = await f.workflow(true); await f.service.attach(actor(B), rule.id, kind, target.id);
    const paused = await f.monitors.save(actor(B), kind, { expectedRevision: 2, enabled: false }, target.id), before = await f.state(rule.id, kind, target.id);
    f.denied.set(A, SEND); await assert.rejects(f.monitors.save(actor(B), kind, { expectedRevision: paused.revision, enabled: true }, target.id), { code: 'CHANNEL_PERMISSION' });
    assert.deepEqual(await f.state(rule.id, kind, target.id), before); f.denied.clear();
    assert.equal((await f.monitors.save(actor(B), kind, { expectedRevision: paused.revision, enabled: true }, target.id)).revision, paused.revision + 1);
}));

for (const kind of ['auto', 'price']) test(`S24-1 native ${kind} repeated registration cannot re-enable an unusable custom workflow destination`, { skip: !port }, async () => fixture(async f => {
    const target = await f.monitor(kind), rule = await f.workflow(true); await f.service.attach(actor(B), rule.id, kind, target.id);
    await f.monitors.save(actor(B), kind, { expectedRevision: 2, enabled: false }, target.id);
    const table = kind === 'auto' ? 'auto_watch' : 'price_watch', before = await f.state(rule.id, kind, target.id);
    const record = (await f.query(`SELECT t.*,${kind === 'auto' ? 's.source_url' : 's.product_url'},w.webhook_url FROM ${table}_targets t JOIN ${table}_sources s ON s.id=t.source_id JOIN webhook_endpoints w ON w.id=t.webhook_endpoint_id WHERE t.id=?`, [target.id]))[0];
    const binding = { ...f.db, ensureUserExistsInDatabase: id => f.query('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)', [id]) };
    const filename = path.resolve(__dirname, `../../src/providers/${kind === 'auto' ? 'autoWatch' : 'priceWatch'}/store.js`), native = createRequire(filename), mod = { exports: {} };
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => id === '../../db' ? binding : id === '../../db_schema' ? { ...native(id), ensureDatabaseSchema: async () => {} } : native(id), mod, mod.exports);
    const input = { userId: A, guildId: G, providerId: kind === 'auto' ? 'github' : 'steam', source: kind === 'auto' ? record.source_url : record.product_url,
        destinationType: 'webhook', webhookUrl: record.webhook_url, channelId: C, ...(kind === 'price' ? { mode: 'change', productUrl: record.product_url, locale: record.source_locale || 'ja' } : {}) };
    f.denied.set(A, SEND);
    await assert.rejects(mod.exports.registerTarget(input, { service: f.service, initialJitterMs: 0 }), { code: 'CHANNEL_PERMISSION' });
    assert.deepEqual(await f.state(rule.id, kind, target.id), before); f.denied.clear();
    const saved = await mod.exports.registerTarget(input, { service: f.service, initialJitterMs: 0 }); assert.equal(saved.id, String(target.id));
    assert.equal((await f.query(`SELECT enabled FROM ${table}_targets WHERE id=?`, [target.id]))[0].enabled, 1);
    assert.equal((await f.query('SELECT workflow_id FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, target.id]))[0].workflow_id, rule.id);
}));

test('S24-1 X enrollment, settings and resume share the actual-owner custom destination guard', { skip: !port }, async () => fixture(async f => {
    const rule = await f.workflow(true, A, 'private'), quota = require('../../src/automation/x-monitor-quota').createXMonitorQuota(f.db, { service: f.service, registrationEnabled: true, rolloutMode: 'public' });
    f.denied.set(A, SEND);
    await assert.rejects(quota.register({ userId: A }, { accountHandle: 'example', notificationSettings: { workflowId: rule.id } }), { code: 'CHANNEL_PERMISSION' });
    assert.equal((await f.query('SELECT * FROM automation_x_monitors')).length, 0); f.denied.clear();
    const registered = await quota.register({ userId: A }, { accountHandle: 'example', notificationSettings: { workflowId: rule.id } });
    const paused = await quota.update({ userId: A }, registered.id, { expectedRevision: registered.revision, enabled: false });
    f.denied.set(A, VIEW);
    await assert.rejects(quota.update({ userId: A }, registered.id, { expectedRevision: paused.revision, enabled: true }), { code: 'CHANNEL_PERMISSION' });
    const edited = await quota.update({ userId: A }, registered.id, { expectedRevision: paused.revision, notificationSettings: { workflowId: rule.id } }); assert.equal(edited.enabled, false);
    f.denied.clear(); assert.equal((await quota.update({ userId: A }, registered.id, { expectedRevision: edited.revision, enabled: true })).enabled, true);
}));

test('S18/S24 X default channels validate actual owner, enabled state and transient failures atomically', { skip: !port }, async () => fixture(async f => {
    const who = { userId: A }, destinationId = await f.destination(A, 'private');
    const quota = require('../../src/automation/x-monitor-quota').createXMonitorQuota(f.db, { service: f.service, registrationEnabled: true, rolloutMode: 'public' });
    const snapshot = async () => ({ rows: await f.query('SELECT * FROM automation_x_monitors ORDER BY id'), slots: await f.query('SELECT * FROM automation_notification_slots ORDER BY owner_user_id,slot_index'), audit: await f.query('SELECT * FROM automation_audit ORDER BY id') });
    const before = await snapshot();
    for (const flag of [VIEW, SEND]) {
        f.denied.set(A, flag); f.calls.length = 0;
        await assert.rejects(quota.register(who, { accountHandle: 'defaulttest', notificationSettings: { destinationId } }), { code: 'CHANNEL_PERMISSION' });
        assert(f.calls.includes(`/guilds/${G}/members/${A}`)); assert.deepEqual(await snapshot(), before);
    }
    f.denied.clear(); f.setUnavailable(true);
    await assert.rejects(quota.register(who, { accountHandle: 'defaulttest', notificationSettings: { destinationId } }), { code: 'DISCORD_UNAVAILABLE', status: 503 }); assert.deepEqual(await snapshot(), before); f.setUnavailable(false);
    const foreign = await f.destination(B, 'private'); f.calls.length = 0;
    await assert.rejects(quota.register({ ...who, isAdmin: true }, { accountHandle: 'foreign', notificationSettings: { destinationId: foreign } }), { code: 'NOT_FOUND' }); assert.equal(f.calls.length, 0);
    const registered = await quota.register(who, { accountHandle: 'defaulttest', notificationSettings: { destinationId } });
    f.denied.set(A, SEND); f.calls.length = 0;
    await assert.rejects(quota.register(who, { accountHandle: 'defaulttest' }), { code: 'CHANNEL_PERMISSION' });
    f.calls.length = 0;
    const paused = await quota.update(who, registered.id, { expectedRevision: registered.revision, enabled: false, notificationSettings: { destinationId } }); assert.equal(f.calls.length, 0);
    const pausedState = await snapshot();
    await assert.rejects(quota.update(who, registered.id, { expectedRevision: paused.revision, enabled: true }), { code: 'CHANNEL_PERMISSION' }); assert.deepEqual(await snapshot(), pausedState);
    f.denied.clear(); f.setUnavailable(true);
    await assert.rejects(quota.update(who, registered.id, { expectedRevision: paused.revision, enabled: true }), { code: 'DISCORD_UNAVAILABLE', status: 503 }); assert.deepEqual(await snapshot(), pausedState); f.setUnavailable(false);
    await f.query('UPDATE automation_destinations SET enabled=0 WHERE id=?', [destinationId]); f.calls.length = 0;
    await assert.rejects(quota.update(who, registered.id, { expectedRevision: paused.revision, enabled: true }), { code: 'DESTINATION_DISABLED' }); assert.equal(f.calls.length, 0);
    await assert.rejects(quota.register(who, { accountHandle: 'disabled', notificationSettings: { destinationId } }), { code: 'DESTINATION_DISABLED' });
    const edited = await quota.update(who, registered.id, { expectedRevision: paused.revision, name: 'Paused editing', notificationSettings: { destinationId } }); assert.equal(edited.enabled, false); assert.equal(f.calls.length, 0);
    await f.query('UPDATE automation_destinations SET enabled=1 WHERE id=?', [destinationId]);
    const resumed = await quota.update(who, registered.id, { expectedRevision: edited.revision, enabled: true }); assert.equal(resumed.enabled, true);
    const secondDestination = await f.destination(A, 'private'); f.denied.set(A, VIEW); const active = await snapshot();
    await assert.rejects(quota.update(who, registered.id, { expectedRevision: resumed.revision, notificationSettings: { destinationId: secondDestination } }), { code: 'CHANNEL_PERMISSION' }); assert.deepEqual(await snapshot(), active);
    f.calls.length = 0; const stopped = await quota.update(who, registered.id, { expectedRevision: resumed.revision, enabled: false }); assert.equal(f.calls.length, 0);
    await f.query('UPDATE automation_destinations SET deleted_at_ms=? WHERE id=?', [Date.now(), destinationId]);
    const brokenEdited = await quota.update(who, registered.id, { expectedRevision: stopped.revision, name: 'Removed destination retained for repair', notificationSettings: { destinationId } }); assert.equal(brokenEdited.enabled, false); assert.equal(f.calls.length, 0);
    await assert.rejects(quota.update(who, registered.id, { expectedRevision: brokenEdited.revision, notificationSettings: { destinationId: foreign } }), { code: 'NOT_FOUND' });
    await quota.release(who, registered.id, { expectedRevision: brokenEdited.revision }); assert.equal(f.calls.length, 0);
    // An unfinished setup and an owned DM remain valid without Discord I/O.
    await quota.register(who, { accountHandle: 'pending_setup' });
    const dm = await f.service.saveDestination(who, { name: 'Default DM', kind: 'dm' }); f.calls.length = 0;
    const direct = await quota.register(who, { accountHandle: 'dm_default', notificationSettings: { destinationId: dm.id } });
    const dmPaused = await quota.update(who, direct.id, { expectedRevision: direct.revision, enabled: false });
    await quota.update(who, direct.id, { expectedRevision: dmPaused.revision, enabled: true }); assert.equal(f.calls.length, 0);
}));

test('S24-1 default sends and private custom DM keep zero Discord reads through attach, activate and resume', { skip: !port }, async () => fixture(async f => {
    const who = { userId: A }, dm = await f.service.saveDestination(who, { name: 'DM', kind: 'dm' });
    const target = await f.monitors.save(who, 'auto', { name: 'DM consumer', providerId: 'github', source: 'octocat', destinationId: dm.id });
    const rule = await f.service.createWorkflow(who, { definition: definition(true), bindings: { destinations: { alerts: dm.id } } });
    f.calls.length = 0; await f.service.activateWorkflow(who, rule.id, { expectedRevision: 1 }); await f.service.attach(who, rule.id, 'auto', target.id);
    await f.service.setWorkflowState(who, rule.id, { expectedRevision: 1, enabled: false }); await f.service.setWorkflowState(who, rule.id, { expectedRevision: 2, enabled: true });
    assert.equal(f.calls.length, 0);
}));

test('T10 ignored legacy default binding can be deleted without altering its immutable workflow edition', { skip: !port }, async () => fixture(async f => {
    const who = { userId: A }, obsolete = await f.service.saveDestination(who, { name: 'Old ignored default', kind: 'dm' });
    const rule = await f.service.createWorkflow(who, { definition: definition(false) });
    const row = (await f.query('SELECT definition_json FROM automation_revisions WHERE workflow_id=? AND revision=1', [rule.id]))[0];
    const legacy = JSON.stringify({ destinations: { default: obsolete.id }, dictionaries: {} }), checksum = hash(row.definition_json + legacy);
    await f.query('UPDATE automation_workflows SET draft_bindings_json=? WHERE id=?', [legacy, rule.id]);
    await f.query('UPDATE automation_revisions SET bindings_json=?,checksum=? WHERE workflow_id=? AND revision=1', [legacy, checksum, rule.id]);
    await f.service.remove('destination', who, obsolete.id, 1); f.calls.length = 0;
    assert.equal((await f.service.activateWorkflow(who, rule.id, { expectedRevision: 1 })).enabled, true);
    const persisted = (await f.query('SELECT bindings_json,checksum FROM automation_revisions WHERE workflow_id=? AND revision=1', [rule.id]))[0];
    assert.equal(persisted.bindings_json, legacy); assert.equal(persisted.checksum, checksum);
    assert.equal(f.calls.length, 0);
}));
