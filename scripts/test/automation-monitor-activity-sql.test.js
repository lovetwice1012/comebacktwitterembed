'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createHistory } = require('../../src/automation/history');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const U = '222222222222222222', V = '333333333333333333', G = '444444444444444444';

test('monitor activity attributes final delivery plans and preserves history access controls', { skip: !port, timeout: 90000 }, async t => {
    const db = await createTestDatabase(port), history = createHistory(db, {}), actor = { userId: U };
    let clock = 1000;
    async function job({ kind = 'x', target = '1', owner = U, scope = 'private', guild = null, state = 'sent', steps = 1, message = '555555555555555555', execution = 1, plan = {}, updated, due = 9000 } = {}) {
        const run = randomUUID(), id = randomUUID(), created = ++clock;
        await db.queryDatabase("INSERT INTO automation_runs (id,dedupe_key,owner_user_id,guild_id,scope,target_kind,target_id,event_json,trace_json,state,created_at_ms) VALUES (?,?,?,?,?,?,?,'{}','[]','queued',?)", [run, run, owner, guild, scope, kind, target, created]);
        await db.queryDatabase('INSERT INTO automation_jobs (id,run_id,execution_version,plan_json,due_at_ms,state,sent_steps,discord_message_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, run, execution, typeof plan === 'string' ? plan : JSON.stringify(plan), due, state, steps, message, created, updated ?? created]);
        return id;
    }
    const list = (targetId = '1', extra = {}, who = actor) => history.list(who, { targetKind: 'x', targetId, ...extra });
    try {
        await t.test('standalone delivery proof excludes partial, unknown, unconfirmed and foreign-owner jobs', async () => {
            const sent = await job({ updated: 8000 });
            await job({ state: 'unknown', updated: 8001 }); await job({ state: 'partial', updated: 8002 });
            await job({ steps: 0, updated: 8003 }); await job({ message: null, updated: 8004 }); await job({ owner: V, updated: 99999 });
            await job({ state: 'pending', steps: 0, message: null, due: 15000 });
            const page = await list(); assert.equal(page.items.some(row => row.id === sent), true);
            assert.deepEqual(page.activity, { lastSentAtMs: 8000, nextDueAtMs: 15000 });
            const foreign = await list('1', {}, { userId: '666666666666666666' });
            assert.deepEqual(foreign.items, []); assert.deepEqual(foreign.activity, { lastSentAtMs: null, nextDueAtMs: null });
        });
        await t.test('a graph member can receive a grouped send even when it is not the primary run', async () => {
            const id = await job({ target: '2', execution: 2, updated: 16000, plan: { members: [{ targetKind: 'x', targetId: '2', event: {} }, { targetKind: 'x', targetId: '3', event: {} }] } });
            assert.equal((await list('3')).items[0].id, id); assert.equal((await list('3')).activity.lastSentAtMs, 16000);
            // Removed primary members and original membership cannot count as sent.
            await job({ target: '4', execution: 2, updated: 19000, plan: { flowV2: { members: [{ targetKind: 'x', targetId: '4' }] }, members: [{ targetKind: 'x', targetId: '3', event: {} }] } });
            assert.equal((await list('4')).items.length, 0);
            await job({ target: '5', execution: 2, plan: '{corrupt-json' });
            assert.equal((await list('5')).items.length, 0);
            await job({ target: '6', execution: 2, plan: { members: [{ targetKind: 'auto', targetId: '3', event: {} }, { targetKind: 'x', targetId: '7', event: {} }] } });
            assert.equal((await list('6')).items.length, 0);
        });
        await t.test('latest mixed-monitor snapshots use the same representative for title, target and trace', async () => {
            const lastJob = await job({ target: '12' }), lastRun = (await db.queryDatabase('SELECT run_id FROM automation_jobs WHERE id=?', [lastJob]))[0].run_id;
            await db.queryDatabase('UPDATE automation_runs SET trace_json=? WHERE id=?', [JSON.stringify([{ nodeId: 'latest-source', outcome: 'yes' }]), lastRun]);
            const plan = { flowV2: {}, aggregate: { mode: 'latest' }, members: [
                { runId: 'replaced-below', targetKind: 'x', targetId: '11', event: { title: 'first post' }, text: 'first' },
                { runId: lastRun, targetKind: 'x', targetId: '12', event: { title: 'latest post' }, text: 'latest' },
            ] };
            const id = await job({ target: '11', execution: 2, plan }), initialRun = (await db.queryDatabase('SELECT run_id FROM automation_jobs WHERE id=?', [id]))[0].run_id;
            plan.members[0].runId = initialRun;
            await db.queryDatabase('UPDATE automation_jobs SET plan_json=? WHERE id=?', [JSON.stringify(plan), id]);
            await db.queryDatabase('UPDATE automation_runs SET trace_json=? WHERE id=?', [JSON.stringify([{ nodeId: 'first-source', outcome: 'no' }]), initialRun]);
            const listed = (await list('12')).items.find(row => row.id === id), detail = await history.detail(actor, id);
            assert.equal(listed.title, 'latest post'); assert.equal(listed.targetKind, 'x'); assert.equal(listed.targetId, '12');
            assert.equal(detail.title, listed.title); assert.equal(detail.event.title, 'latest post'); assert.equal(detail.targetId, '12');
            assert.deepEqual(detail.trace, [{ nodeId: 'latest-source', outcome: 'yes' }]);
        });
        await t.test('summary remains accurate beyond pagination and state filters; tuple cursors stay target-scoped', async () => {
            await job({ target: '8', updated: 22000 });
            for (let index = 0; index < 52; index++) await job({ target: '8', state: 'pending', steps: 0, message: null, due: 30000 + index });
            const page = await list('8', { state: 'pending' }); assert.equal(page.items.length, 50); assert.ok(page.nextCursor);
            assert.deepEqual(page.activity, { lastSentAtMs: 22000, nextDueAtMs: 30000 });
            const next = await list('8', { state: 'pending', cursor: page.nextCursor }); assert.equal(next.items.length, 2);
            assert.equal(next.items.some(row => page.items.some(old => old.id === row.id)), false);
            assert.equal((await list('9', { cursor: page.nextCursor })).items.length, 0);
        });
        await t.test('shared history needs the original guild view permission and never exposes another private owner', async () => {
            await job({ target: '10', scope: 'guild', guild: G, owner: V, updated: 25000 });
            assert.equal((await list('10')).items.length, 0);
            assert.equal((await list('10', {}, { ...actor, guildId: G, canView: true })).items.length, 1);
            assert.equal((await list('10', {}, { ...actor, guildId: G, canView: false })).items.length, 0);
            assert.equal((await list('10', {}, { ...actor, guildId: '777777777777777777', canView: true })).items.length, 0);
        });
        await t.test('invalid or partial target selectors fail instead of broadening the query', async () => {
            for (const input of [{ targetKind: 'x' }, { targetId: '1' }, { targetKind: 'x', targetId: "1 OR 1=1" }, { targetKind: 'other', targetId: '1' }, { targetKind: 'auto', targetId: '-1' }]) await assert.rejects(history.list(actor, input), { code: 'INVALID_TARGET' });
            assert.equal('activity' in await history.list(actor), false);
        });
    } finally { await db.close(); }
});
