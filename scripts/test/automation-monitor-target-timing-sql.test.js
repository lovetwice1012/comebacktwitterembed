'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors, publicMonitor } = require('../../src/automation/monitors');
const { monitorState } = require('../../src/automation/monitor-input');
const { watchLine } = require('../../src/commands/handlers/autoextract/list')._internal;
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), MINUTE = 60000;

function standardStore(db) {
    const filename = require.resolve('../../src/providers/autoWatch/store'), actual = createRequire(filename), module = { exports: {} };
    const mocks = { '../../db': db, '../../db_schema': { ...require('../../src/db_schema'), ensureDatabaseSchema: async () => {} } };
    compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(id => mocks[id] || actual(id), module, module.exports);
    return module.exports;
}
const timingKeys = ['lastCheckedAtMs', 'nextCheckAtMs', 'targetNextCheckAtMs', 'sourceLastCheckedAtMs', 'sourceNextCheckAtMs'];
const times = value => Object.fromEntries(timingKeys.map(key => [key, value[key]]));

test('Discord and Dashboard distinguish a target plan from shared acquisition without changing schedules', { skip: !port, timeout: 60000 }, async t => {
    const db = await createTestDatabase(port), query = db.queryDatabase; t.after(() => db.close());
    const service = createService(db, { rateLimiter: { consumeOperation: async () => {} } });
    const monitors = createMonitors(db, service, {}), store = standardStore(db), now = Date.now();
    const owners = [{ userId: '222222222222229981' }, { userId: '222222222222229982' }], ids = [];
    async function register(owner, interval) {
        await query('INSERT INTO users(user_id,registered_at_ms,auto_watch_interval_minutes) VALUES (?,0,?)', [owner.userId, interval]);
        const destination = await service.saveDestination(owner, { kind: 'dm', name: 'Timing fixture DM' });
        return monitors.save(owner, 'auto', { name: 'Shared timing fixture', providerId: 'github', source: 'shared-timing-fixture', destinationId: destination.id });
    }
    const first = await register(owners[0], 10); ids.push(first.id);
    const sourceId = (await query('SELECT source_id FROM auto_watch_targets WHERE id=?', [first.id]))[0].source_id;
    await query('UPDATE auto_watch_sources SET initialized_at_ms=?,last_checked_at_ms=?,next_check_at_ms=?,failure_count=0,last_error_code=NULL WHERE id=?', [now - MINUTE, now, now + 30 * MINUTE, sourceId]);
    await query('UPDATE auto_watch_targets SET baseline_at_ms=?,last_polled_at_ms=?,next_poll_at_ms=? WHERE id=?', [now - 20 * MINUTE, now - MINUTE, now + 10 * MINUTE, first.id]);
    const second = await register(owners[1], 30); ids.push(second.id);
    const targetRows = () => query('SELECT * FROM auto_watch_targets WHERE id IN (?) ORDER BY id', [ids]);
    async function both(index) {
        const discord = (await store.listTargets(owners[index].userId)).find(row => row.id === ids[index]);
        const dashboard = (await monitors.list(owners[index], 'auto')).items.find(row => row.id === ids[index]);
        assert.deepEqual(times(discord), times(dashboard));
        return { discord, dashboard };
    }
    await t.test('actual registration against an initialized shared source remains pending its own first check', async () => {
        const before = await targetRows(), raw = before.find(row => String(row.id) === second.id);
        assert.equal(raw.source_id, sourceId); assert.equal(raw.baseline_at_ms, null); assert.equal(raw.last_polled_at_ms, null); assert.equal(raw.next_poll_at_ms, null);
        const { discord, dashboard } = await both(1);
        assert.equal(discord.lastCheckedAtMs, 0); assert.equal(discord.nextCheckAtMs, 0); assert.equal(discord.targetNextCheckAtMs, 0);
        assert.equal(discord.sourceLastCheckedAtMs, now); assert.ok(discord.sourceNextCheckAtMs > now);
        assert.equal(monitorState(dashboard).id, 'initial'); assert.match(watchLine(discord, true), /初回確認待ち/); assert.match(watchLine(discord, true), /最終確認: 未確認/);
        assert.deepEqual(await targetRows(), before);
    });
    await t.test('two owners retain distinct target intervals while sharing the same acquisition evidence', async () => {
        await query('UPDATE auto_watch_targets SET baseline_at_ms=?,last_polled_at_ms=?,next_poll_at_ms=? WHERE id=?', [now - 40 * MINUTE, now - 5 * MINUTE, now + 25 * MINUTE, second.id]);
        await query('UPDATE auto_watch_sources SET next_check_at_ms=? WHERE id=?', [now + 2 * MINUTE, sourceId]);
        const before = await targetRows();
        for (const [index, next, interval] of [[0, now + 10 * MINUTE, 10], [1, now + 25 * MINUTE, 30]]) {
            const { discord, dashboard } = await both(index);
            assert.equal(discord.targetNextCheckAtMs, next); assert.equal(discord.nextCheckAtMs, next); assert.equal(discord.sourceNextCheckAtMs, now + 2 * MINUTE);
            assert.equal(dashboard.intervalMinutes, interval); assert.ok(watchLine(discord, true).includes(`<t:${Math.floor(next / 1000)}:R>`));
        }
        assert.deepEqual(await targetRows(), before);
    });
    await t.test('a shared upstream 429 delays both displayed next checks but preserves both raw target plans', async () => {
        const sourceNext = now + 60 * MINUTE;
        await query("UPDATE auto_watch_sources SET next_check_at_ms=?,failure_count=1,last_error_code='AUTO_WATCH_RATE_LIMITED' WHERE id=?", [sourceNext, sourceId]);
        const before = await targetRows();
        for (const [index, rawNext] of [[0, now + 10 * MINUTE], [1, now + 25 * MINUTE]]) {
            const { discord, dashboard } = await both(index);
            assert.equal(discord.nextCheckAtMs, sourceNext); assert.equal(discord.targetNextCheckAtMs, rawNext); assert.equal(discord.sourceNextCheckAtMs, sourceNext);
            assert.ok(watchLine(discord, true).includes(`<t:${Math.floor(sourceNext / 1000)}:R>`)); assert.match(watchLine(discord, true), /取得制限で待機中/); assert.equal(monitorState(dashboard).id, 'waiting');
        }
        assert.deepEqual(await targetRows(), before);
    });
    await t.test('an absent target plan never inherits the shared next-check timestamp', async () => {
        await query('UPDATE auto_watch_targets SET next_poll_at_ms=NULL WHERE id=?', [second.id]);
        const before = await targetRows(), { discord } = await both(1);
        assert.equal(discord.nextCheckAtMs, 0); assert.equal(discord.targetNextCheckAtMs, 0); assert.equal(discord.sourceNextCheckAtMs, now + 60 * MINUTE);
        assert.match(watchLine(discord, true), /次回確認: 調整中/); assert.deepEqual(await targetRows(), before);
    });
});

test('price timing keeps its previous source-based meaning and receives no auto-target plan fields', () => {
    const value = publicMonitor('price', { id: 1, enabled: 1, last_polled_at_ms: 999, next_poll_at_ms: 999, last_checked_at_ms: '123', next_check_at_ms: '456' });
    assert.equal(value.lastCheckedAtMs, 123); assert.equal(value.nextCheckAtMs, 456);
    for (const key of ['targetNextCheckAtMs', 'sourceLastCheckedAtMs', 'sourceNextCheckAtMs']) assert.equal(Object.hasOwn(value, key), false);
});
