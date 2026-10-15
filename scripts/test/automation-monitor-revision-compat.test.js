'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { monitorRevisionCompatible } = require('../../src/automation/monitor-revision-compat');
const owner = '222222222222222222';
const args = (kind = 'x') => ({ kind, targetId: '123', ownerUserId: owner, expectedRevision: 1, currentRevision: 3 });
const rename = (revision, kind = 'x', changes = {}) => ({ action: kind === 'x' ? 'x.monitor.rename' : 'monitor.rename', detail_json: JSON.stringify({ manual: true, metadataOnly: true, ownerUserId: owner, beforeRevision: revision, afterRevision: revision + 1, ...changes }) });
const move = revision => ({ action: 'x.quota.move', detail_json: JSON.stringify({ manual: true, ownerUserId: owner, beforeRevision: revision, afterRevision: revision + 1, before: 'free', after: 'supporter' }) });

test('unchanged valid revisions require no audit read and invalid identity/revision shapes fail closed', async () => {
    const forbidden = () => { throw Error('Audit read must not run'); };
    assert.equal(await monitorRevisionCompatible(forbidden, { ...args(), currentRevision: 1 }), true);
    for (const change of [{ kind: 'other' }, { targetId: '../12' }, { ownerUserId: '' }, { ownerUserId: 123 }, { expectedRevision: 0 }, { expectedRevision: '1' }, { currentRevision: 0 }, { currentRevision: 1.5 }])
        assert.equal(await monitorRevisionCompatible(forbidden, { ...args(), ...change }), false);
});

for (const kind of ['auto', 'price', 'x']) test(`${kind} accepts only complete owned harmless metadata chains`, async () => {
    let captured;
    const valid = [rename(1, kind), rename(2, kind)];
    assert.equal(await monitorRevisionCompatible(async (sql, params) => { captured = { sql, params }; return valid; }, args(kind)), true);
    assert.deepEqual(captured.params, [`${kind}:123`, 1, 3]);
    assert.match(captured.sql, /JSON_VALID/);
    assert.equal(await monitorRevisionCompatible(async () => [...valid].reverse(), args(kind)), true, 'contiguous revisions do not depend on audit insertion order');
    for (const rows of [[], [valid[0]], [...valid, valid[0]], [valid[0], valid[0]], [rename(1, kind, { ownerUserId: '333333333333333333' }), valid[1]], [rename(1, kind, { metadataOnly: false }), valid[1]], [rename(1, kind, { manual: false }), valid[1]], [rename(1, kind, { afterRevision: 3 }), valid[1]], [rename(1, kind, { beforeRevision: '1' }), valid[1]], [{ ...valid[0], detail_json: '{broken' }, valid[1]], [{ ...valid[0], detail_json: '[]' }, valid[1]], [{ ...valid[0], action: 'monitor.update' }, valid[1]], [rename(0, kind), valid[1]], [valid[0], rename(3, kind)]])
        assert.equal(await monitorRevisionCompatible(async () => rows, args(kind)), false);
    await assert.rejects(monitorRevisionCompatible(async () => { throw Object.assign(Error('Synthetic read failure'), { code: 'ER_TEST_AUDIT_READ' }); }, args(kind)), { code: 'ER_TEST_AUDIT_READ' });
});

test('X can mix pure pool moves and renames but functional combined edits cannot bridge a missing revision', async () => {
    assert.equal(await monitorRevisionCompatible(async () => [move(1), rename(2)], args()), true);
    assert.equal(await monitorRevisionCompatible(async () => [rename(1), move(2)], args()), true);
    const combined = { action: 'x.quota.move', detail_json: JSON.stringify({ manual: true, ownerUserId: owner, before: 'free', after: 'supporter', preservesDelivery: false }) };
    assert.equal(await monitorRevisionCompatible(async () => [combined, rename(2)], args()), false);
    assert.equal(await monitorRevisionCompatible(async () => [move(1), move(2)], args('auto')), false);
    const invalidPool = move(1); invalidPool.detail_json = JSON.stringify({ ...JSON.parse(invalidPool.detail_json), after: 'unknown' });
    assert.equal(await monitorRevisionCompatible(async () => [invalidPool, rename(2)], args()), false);
    const explicitlyUnsafe = move(1); explicitlyUnsafe.detail_json = JSON.stringify({ ...JSON.parse(explicitlyUnsafe.detail_json), preservesDelivery: false });
    assert.equal(await monitorRevisionCompatible(async () => [explicitlyUnsafe, rename(2)], args()), false);
});
