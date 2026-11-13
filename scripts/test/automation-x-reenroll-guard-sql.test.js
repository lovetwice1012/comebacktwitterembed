'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { fixture, insertSubscription } = require('./helpers/x-push-fixture.cjs');
const { createXMonitorQuota } = require('../../src/automation/x-monitor-quota');
const { createXPushStore } = require('../../src/automation/x-push-store');
const { lockOwner } = require('../../src/automation/entitlements');
const { dispatch } = require('../../src/automation/api');
const mysql = require('mysql');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const owner = { userId: '222222222222222222' }, other = { userId: '333333333333333333' };
const request = (method, path, body = {}) => ({ method, path: path.split('/'), body });
const bad = error => error.code === 'X_MONITOR_RECEIVER_REENROLL_REQUIRED';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function withDb(work) {
  assert(port >= 1024 && port !== 3306, 'Explicit isolated DB port required');
  const db = await createTestDatabase(port);
  try { await work(db); } finally { await db.close(); }
}
function service(db) { return createXMonitorQuota(db, { registrationEnabled: true, rolloutMode: 'public' }); }
const body = (name, subscriptionId) => ({ accountHandle: name, name, notificationSettings: { subscriptionId } });
async function setState(db, user, id, state) {
  await db.withDatabaseTransaction(async q => {
    await lockOwner(q, user.userId);
    const sub = (await q('SELECT id,revision FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [id, user.userId]))[0]; assert(sub);
    await q('INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,updated_at_ms) VALUES (?,?,?,0) ON DUPLICATE KEY UPDATE state=VALUES(state)', [id, state, Number(sub.revision)]);
  });
}
async function snapshot(db) {
  const tables = ['automation_x_monitors','automation_notification_slots','automation_audit'];
  const result = {};
  for (const table of tables) result[table] = Number((await db.queryDatabase(`SELECT COUNT(*) n FROM ${table}`))[0].n);
  return result;
}
test('new registrations reject reenrollment state through the dispatcher and leave allocation unchanged', { timeout: 90000 }, () => withDb(async db => {
  const sub = await insertSubscription(db, fixture(), owner.userId); await setState(db, owner, sub.subscriptionId, 'requires_reenrollment');
  const quota = service(db), services = { db, xQuota: quota, service: { withOperation: async (_actor, _kind, work) => work() } };
  const before = await snapshot(db);
  await assert.rejects(dispatch(request('POST', 'x-monitors', body('test_user', sub.subscriptionId)), owner, services), bad);
  assert.deepEqual(await snapshot(db), before);
  await assert.rejects(dispatch(request('POST', 'x-monitors', body('other_user', sub.subscriptionId)), other, services), error => error.code === 'NOT_FOUND');
  assert.deepEqual(await snapshot(db), before);
}));
test('missing and awaiting receivers remain eligible while existing same-ID metadata and retries remain usable', { timeout: 90000 }, () => withDb(async db => {
  const subA = await insertSubscription(db, fixture(), owner.userId), subB = await insertSubscription(db, fixture(), other.userId);
  await setState(db, other, subB.subscriptionId, 'awaiting');
  const quota = service(db), a = await quota.register(owner, body('first_user', subA.subscriptionId));
  const b = await quota.register(other, body('second_user', subB.subscriptionId)); assert(a.id && b.id);
  await setState(db, owner, subA.subscriptionId, 'requires_reenrollment');
  const renamed = await quota.update(owner, a.id, { expectedRevision: a.revision, name: '名前のみ変更' });
  assert.equal(renamed.name, '名前のみ変更'); assert.equal(renamed.notificationSettings.subscriptionId, subA.subscriptionId);
  const duplicate = await quota.register(owner, { accountHandle: 'first_user', name: '名前のみ変更', notificationSettings: { subscriptionId: subA.subscriptionId } });
  assert.equal(duplicate.id, a.id);
  const changed = await quota.update(owner, a.id, { expectedRevision: renamed.revision, notificationSettings: { subscriptionId: subA.subscriptionId } });
  assert.equal(changed.notificationSettings.subscriptionId, subA.subscriptionId);
}));
test('switching a monitor to an ineligible owned receiver rejects without changing the row or audit', { timeout: 90000 }, () => withDb(async db => {
  const first = await insertSubscription(db, fixture(), owner.userId), second = await insertSubscription(db, fixture(), owner.userId);
  const quota = service(db), created = await quota.register(owner, body('first_user', first.subscriptionId));
  await setState(db, owner, second.subscriptionId, 'requires_reenrollment');
  const before = await snapshot(db);
  await assert.rejects(quota.update(owner, created.id, { expectedRevision: created.revision, notificationSettings: { subscriptionId: second.subscriptionId } }), bad);
  assert.deepEqual(await snapshot(db), before);
  const row = (await db.queryDatabase('SELECT notification_settings_json,revision FROM automation_x_monitors WHERE id=?', [created.id]))[0];
  assert.equal(JSON.parse(row.notification_settings_json).subscriptionId, first.subscriptionId); assert.equal(Number(row.revision), created.revision);
}));
test('a committed receiver state change before admission is observed under the owner lock', { timeout: 90000 }, () => withDb(async db => {
  const sub = await insertSubscription(db, fixture(), owner.userId); await setState(db, owner, sub.subscriptionId, 'awaiting');
  const locked = deferred(), release = deferred();
  const writer = db.withDatabaseTransaction(async q => {
    await lockOwner(q, owner.userId);
    await q('SELECT id FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [sub.subscriptionId, owner.userId]);
    await q('SELECT state FROM automation_x_push_receivers WHERE subscription_id=? FOR UPDATE', [sub.subscriptionId]);
    await q("UPDATE automation_x_push_receivers SET state='requires_reenrollment' WHERE subscription_id=?", [sub.subscriptionId]);
    locked.resolve(); await release.promise;
  });
  await locked.promise; const attempt = service(db).register(owner, body('racing_user', sub.subscriptionId)).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 100)); release.resolve(); await writer;
  const result = await attempt; assert(result.error && bad(result.error));
  assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_x_monitors'))[0].n), 0);
}));
test('a nested registration uses the current receiver state even after an older repeatable-read snapshot', { timeout: 90000 }, () => withDb(async db => {
  const sub = await insertSubscription(db, fixture(), owner.userId); await setState(db, owner, sub.subscriptionId, 'awaiting');
  const before = await snapshot(db);
  const otherConnection = mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '', database: db.schema });
  const query = (sql, values = []) => new Promise((resolve, reject) => otherConnection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
  try {
    await assert.rejects(db.withDatabaseTransaction(async q => {
      assert.equal((await q('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [sub.subscriptionId]))[0].state, 'awaiting');
      await query('START TRANSACTION');
      await lockOwner(query, owner.userId);
      await query('SELECT id FROM automation_x_subscriptions WHERE id=? AND owner_user_id=? FOR UPDATE', [sub.subscriptionId, owner.userId]);
      await query('SELECT state FROM automation_x_push_receivers WHERE subscription_id=? FOR UPDATE', [sub.subscriptionId]);
      await query("UPDATE automation_x_push_receivers SET state='requires_reenrollment' WHERE subscription_id=?", [sub.subscriptionId]);
      await query('COMMIT');
      await service(db).register(owner, body('nested_user', sub.subscriptionId));
    }), bad);
    assert.deepEqual(await snapshot(db), before);
  } finally { await new Promise(resolve => otherConnection.end(() => resolve())); }
}));
test('admission before a later receiver loss is serialized and later state remains visible', { timeout: 90000 }, () => withDb(async db => {
  const sub = await insertSubscription(db, fixture(), owner.userId); await setState(db, owner, sub.subscriptionId, 'awaiting');
  const locked = deferred(), release = deferred();
  const proxy = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(q => work(async (sql, params) => {
    const rows = await q(sql, params);
    if (/^SELECT state FROM automation_x_push_receivers WHERE subscription_id=\? FOR UPDATE$/.test(sql)) { locked.resolve(); await release.promise; }
    return rows;
  })) };
  const admission = service(proxy).register(owner, body('racing_user', sub.subscriptionId));
  await locked.promise; let changed = false;
  const later = setState(db, owner, sub.subscriptionId, 'requires_reenrollment').then(() => { changed = true; });
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(changed, false); }
  finally { release.resolve(); }
  const saved = await admission; await later;
  assert.equal(saved.notificationSettings.subscriptionId, sub.subscriptionId);
  assert.equal((await db.queryDatabase('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [sub.subscriptionId]))[0].state, 'requires_reenrollment');
}));
test('missing receiver read and another owner first claim complete without deadlock', { timeout: 90000 }, t => withDb(async db => {
  const first = await insertSubscription(db, fixture(), owner.userId), second = await insertSubscription(db, fixture(), other.userId);
  const locked = deferred(), release = deferred();
  const proxy = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(q => work(async (sql, params) => {
    const rows = await q(sql, params);
    if (/^SELECT state FROM automation_x_push_receivers WHERE subscription_id=\? FOR UPDATE$/.test(sql)) { locked.resolve(); await release.promise; }
    return rows;
  })) };
  const admission = service(proxy).register(owner, body('first_user', first.subscriptionId));
  await locked.promise;
  let claimSettled = false;
  const claim = createXPushStore(db, { leaseMs: 30000 }).claim({ subscriptionId: second.subscriptionId, ownerUserId: other.userId, workerId: 'fixture' })
    .then(value => { claimSettled = true; return { value }; }, error => { claimSettled = true; return { error }; });
  try { await new Promise(resolve => setTimeout(resolve, 100)); t.diagnostic(`other-owner first claim completed before release: ${claimSettled}`); }
  finally { release.resolve(); }
  const [saved, outcome] = await Promise.all([admission, claim]); if (outcome.error) throw outcome.error;
  assert(saved.id); assert(outcome.value && outcome.value.subscriptionId === second.subscriptionId);
}));
test('transaction failure after validation rolls back monitor, slots, and audit', { timeout: 90000 }, () => withDb(async db => {
  const sub = await insertSubscription(db, fixture(), owner.userId), before = await snapshot(db);
  const proxy = { ...db, withDatabaseTransaction: work => db.withDatabaseTransaction(q => work(async (sql, params) => {
    if (/^INSERT INTO automation_x_monitors /.test(sql)) throw new Error('synthetic transaction failure');
    return q(sql, params);
  })) };
  await assert.rejects(service(proxy).register(owner, body('failed_user', sub.subscriptionId)), /synthetic transaction failure/);
  assert.deepEqual(await snapshot(db), before);
}));
