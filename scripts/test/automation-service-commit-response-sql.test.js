'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMarketplace } = require('../../src/automation/marketplace');
const { newWorkflow } = require('../../src/automation/schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw Error('Commit response SQL requires disposable AUTOMATION_TEST_DB_PORT=33621');
const actor = { userId: '228111111111111111' }, dictionary = { schemaVersion: 1, name: 'Synthetic response dictionary', mode: 'contains', entries: ['example'], source: 'Synthetic owner', license: 'CC0-1.0' };
test('canonical creation responses belong to their write transaction, including nested imports and failures', { timeout: 60000 }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase; t.after(() => db.close());
    let depth = 0, failCanonical = false, failAudit = false, createdWorkflow = false; const reads = [];
    const wrapped = { ...db, queryDatabase: async (sql, params) => {
        if (sql.startsWith('SELECT * FROM automation_workflows WHERE id=')) { reads.push(depth); if (failCanonical && createdWorkflow) throw Error('Synthetic canonical response failure'); }
        return query(sql, params);
    }, withDatabaseTransaction: work => db.withDatabaseTransaction(async q => {
        depth++;
        try { return await work(async (sql, params) => {
            if (sql.startsWith('SELECT * FROM automation_workflows WHERE id=')) { reads.push(depth); if (failCanonical && createdWorkflow) throw Error('Synthetic canonical response failure'); }
            if (failAudit && sql.startsWith('INSERT INTO automation_audit')) throw Error('Synthetic audit failure');
            const result = await q(sql, params); if (sql.startsWith('INSERT INTO automation_workflows ')) createdWorkflow = true; return result;
        }); } finally { depth--; }
    }) };
    const service = createService(wrapped, { rateLimiter: { consumeOperation: async () => {} } });
    const counts = async () => Object.fromEntries(await Promise.all(['automation_workflows', 'automation_revisions', 'automation_dictionaries', 'automation_dictionary_revisions', 'automation_destinations', 'automation_audit'].map(async table => [table, Number((await query(`SELECT COUNT(*) n FROM ${table}`))[0].n)])));
    await t.test('a canonical DTO read failure rolls back the workflow, edition and audit; retry creates one resource', async () => {
        const before = await counts(); failCanonical = true; createdWorkflow = false;
        await assert.rejects(service.createWorkflow(actor, { definition: newWorkflow('Retryable synthetic create') }), /Synthetic canonical response failure/);
        assert.deepEqual(await counts(), before); assert(reads.every(value => value > 0));
        failCanonical = false; const saved = await service.createWorkflow(actor, { definition: newWorkflow('Retryable synthetic create') });
        assert.equal(saved.name, 'Retryable synthetic create'); assert.equal(saved.revision, 1); assert.deepEqual(saved.bindings, { destinations: {}, dictionaries: {} }); assert.equal((await counts()).automation_workflows, before.automation_workflows + 1);
    });
    await t.test('nested workflow+dictionary import aborts every resource when its workflow response cannot be read', async () => {
        const before = await counts(); failCanonical = true; createdWorkflow = false;
        const market = createMarketplace(wrapped, { service, moderationMatcher: { match: async () => [] } });
        await assert.rejects(market.importBundle(actor, { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow('Nested synthetic'), dictionaries: { words: dictionary } }, { scope: 'private' }), /Synthetic canonical response failure/);
        assert.deepEqual(await counts(), before); failCanonical = false;
    });
    await t.test('dictionary and destination summaries already return within the transaction and audit failures leave no orphan resources', async () => {
        for (const create of [() => service.saveDictionary(actor, { dictionary }), () => service.saveDestination(actor, { kind: 'dm', name: 'Synthetic destination' })]) {
            const before = await counts(); failAudit = true; await assert.rejects(create(), /Synthetic audit failure/); assert.deepEqual(await counts(), before); failAudit = false;
            const saved = await db.withDatabaseTransaction(async () => create()); assert.match(saved.id, /^[0-9a-f-]{36}$/); assert(depth === 0);
        }
    });
});
