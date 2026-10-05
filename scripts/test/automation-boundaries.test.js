'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newWorkflow } = require('../../src/automation/schema');
const { assertAccess, scopeFor, createService, publicDestination } = require('../../src/automation/service');
const { validateBundle, encodeBundle, decodeBundle } = require('../../src/automation/bundle');
const { createEvaluator } = require('../../src/automation/evaluation');
const { catalog, template } = require('../../src/automation/catalog');

test('private resources remain private even to a guild/platform admin; guild owners still need current permission', () => {
    const resource = { owner_user_id: '123', guild_id: '111', scope: 'private' };
    assert.throws(() => assertAccess({ userId: '456', guildId: '111', canEdit: true, canView: true, isAdmin: true }, resource), error => error.status === 404);
    assert.doesNotThrow(() => assertAccess({ userId: '123' }, resource, true));
    assert.throws(() => assertAccess({ userId: '123', guildId: '111', canEdit: false }, { ...resource, scope: 'guild' }, true), error => error.status === 403);
    assert.throws(() => scopeFor({ userId: '123' }, 'guild'), error => error.status === 403);
    assert.throws(() => assertAccess({ userId: '123' }, { ...resource, deleted_at_ms: 1000 }), error => error.status === 404);
});
test('destination API representation does not contain the webhook token or DM recipient', () => {
    const result = publicDestination({ id: 'id', name: 'channel', webhook_url: 'https://discord.com/api/webhooks/123/secret', dm_user_id: '456', webhook_endpoint_id: '99', enabled: 1, revision: 1 });
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(Object.hasOwn(result, 'dm_user_id'), false);
});
test('draft edits use optimistic revisions and do not activate or overwrite active versions', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const row = { id, owner_user_id: '123', scope: 'private', revision: 4, active_revision: 3, draft_json: JSON.stringify(newWorkflow('prior')), draft_bindings_json: '{}' };
    const writes = [], revisions = new Map();
    const queryDatabase = async (sql, params) => {
        if (sql.startsWith('SELECT * FROM automation_workflows')) return [row];
        if (sql.startsWith('SELECT checksum,definition_json,bindings_json FROM automation_revisions')) return revisions.has(params[1]) ? [revisions.get(params[1])] : [];
        if (sql.startsWith('INSERT IGNORE INTO automation_revisions')) revisions.set(params[1], { definition_json: params[2], bindings_json: params[3], checksum: params[4] });
        writes.push({ sql, params });
        return { affectedRows: 1 };
    };
    const service = createService({ queryDatabase, withDatabaseTransaction: work => work(queryDatabase) });
    await assert.rejects(service.updateWorkflow({ userId: '123' }, id, { definition: newWorkflow(), expectedRevision: 3 }), error => error.status === 409);
    assert.equal(writes.length, 0);
    const saved = await service.updateWorkflow({ userId: '123' }, id, { definition: newWorkflow('編集'), expectedRevision: 4 });
    assert.equal(saved.revision, 5);
    assert.equal(writes.some(w => w.sql.includes('active_revision=')), false);
    assert.equal(writes.some(w => w.sql.startsWith('INSERT INTO automation_audit')), true);
    assert.deepEqual([...revisions.keys()], [4, 5]);
});
test('portable packages preserve graph and dictionary and reject live endpoints and missing dependencies', () => {
    const bundle = { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow(), dictionaries: { words: { schemaVersion: 1, name: '例外辞書', entries: ['広告', { term: '広告制作', kind: 'allow' }] } } };
    assert.deepEqual(decodeBundle(encodeBundle(bundle)), bundle);
    const unsafe = structuredClone(bundle); unsafe.workflow.description = 'https://discord.com/api/webhooks/123/secret';
    assert.throws(() => validateBundle(unsafe), /CREDENTIALS/);
    assert.throws(() => decodeBundle(new Uint8Array([0, 1, 2])), /INCOMPLETE|invalid|Invalid/);
});
test('all 1024 built-in template combinations validate and serialize', () => {
    const data = catalog();
    let count = 0;
    for (const goal of data.goals) for (const time of data.times) for (const format of data.formats) {
        assert.equal(template(goal.id, time.id, format).nodes.at(-1).type, 'send'); count++;
    }
    assert.equal(count, 1024);
});
test('isolated evaluator supports two dictionaries and returns their exact branch decisions', async () => {
    const evaluator = createEvaluator(async id => ({ schemaVersion: 1, name: id, entries: id === 'ads' ? ['広告'] : ['新作'] }));
    const rule = newWorkflow();
    rule.nodes.push({ id: 'ads', type: 'dictionary', config: { dictionary: 'ads', fields: ['title'] } }, { id: 'new', type: 'dictionary', config: { dictionary: 'new', fields: ['title'] } });
    rule.edges = [{ id: 'a', source: 'start', target: 'ads', port: 'out' }, { id: 'b', source: 'ads', target: 'new', port: 'no' }, { id: 'c', source: 'new', target: 'send', port: 'yes' }];
    try {
        const result = await evaluator.evaluate(rule, { title: '新作発売', observedAtMs: 1000 }, { dictionaries: { ads: { id: 'ads', revision: 1 }, new: { id: 'new', revision: 1 } } }, 1000);
        assert.equal(result.outputs.length, 1);
        assert.equal(result.trace.find(t => t.nodeId === 'ads').outcome, 'no');
        assert.equal(result.trace.find(t => t.nodeId === 'new').outcome, 'yes');
    } finally { evaluator.stop(); }
});
