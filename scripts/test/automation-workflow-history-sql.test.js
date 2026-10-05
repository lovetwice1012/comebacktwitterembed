'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { newWorkflow } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const actor = { userId: '222222222222222222' };
async function fixture(work) {
    const db = await createTestDatabase(port);
    try { await work(createService(db), db.queryDatabase); }
    finally { await db.close(); }
}
test('saved but unapplied drafts can be restored without changing the running revision', { skip: !port }, async () => fixture(async service => {
    const workflow = await service.createWorkflow(actor, { definition: newWorkflow('first') });
    await service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 });
    await service.updateWorkflow(actor, workflow.id, { definition: newWorkflow('second'), expectedRevision: 1 });
    await service.updateWorkflow(actor, workflow.id, { definition: newWorkflow('third'), expectedRevision: 2 });
    assert.deepEqual((await service.history(actor, workflow.id)).map(row => row.revision), [3, 2, 1]);
    await service.restoreRevision(actor, workflow.id, 2, 3);
    const restored = await service.getWorkflow(actor, workflow.id);
    assert.equal(restored.draft.name, 'second'); assert.equal(restored.revision, 4);
    assert.equal(restored.activeRevision, 1); assert.equal(restored.enabled, true);
    await assert.rejects(service.restoreRevision({ userId: '333333333333333333' }, workflow.id, 2, 4), { status: 404 });
    await assert.rejects(service.updateWorkflow(actor, workflow.id, { definition: newWorkflow('stale'), expectedRevision: 3 }), { code: 'REVISION_CONFLICT' });
    assert.deepEqual((await service.history(actor, workflow.id)).map(row => row.revision), [4, 3, 2, 1]);
}));
test('an early-schema current draft is captured before replacement, not silently lost', { skip: !port }, async () => fixture(async (service, query) => {
    const workflow = await service.createWorkflow(actor, { definition: newWorkflow('legacy draft') });
    await query('DELETE FROM automation_revisions WHERE workflow_id=?', [workflow.id]);
    await service.updateWorkflow(actor, workflow.id, { definition: newWorkflow('new draft'), expectedRevision: 1 });
    await service.restoreRevision(actor, workflow.id, 1, 2);
    assert.equal((await service.getWorkflow(actor, workflow.id)).draft.name, 'legacy draft');
    assert.equal((await service.getWorkflow(actor, workflow.id)).activeRevision, null);
}));
test('snapshot mismatch fails activation atomically rather than executing a different edition', { skip: !port }, async () => fixture(async (service, query) => {
    const workflow = await service.createWorkflow(actor, { definition: newWorkflow('saved') });
    await query("UPDATE automation_revisions SET checksum=? WHERE workflow_id=?", ['0'.repeat(64), workflow.id]);
    await assert.rejects(service.activateWorkflow(actor, workflow.id, { expectedRevision: 1 }), { code: 'REVISION_SNAPSHOT_CONFLICT' });
    const current = await service.getWorkflow(actor, workflow.id);
    assert.equal(current.activeRevision, null); assert.equal(current.enabled, false);
    const clean = await service.createWorkflow(actor, { definition: newWorkflow('checksum intact') });
    await query('UPDATE automation_revisions SET definition_json=? WHERE workflow_id=?', [JSON.stringify(newWorkflow('corrupt bytes')), clean.id]);
    await assert.rejects(service.activateWorkflow(actor, clean.id, { expectedRevision: 1 }), { code: 'REVISION_SNAPSHOT_CONFLICT' });
}));
