'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Events } = require('discord.js');
const {
    createDiscordEventMetrics,
    _internal,
} = require('../../src/discordEventMetrics');

test('discord event metrics: registers once and counts raw gateway events by type and shard', () => {
    let nowMs = Date.UTC(2026, 6, 11, 12, 0, 0);
    const recordedMetrics = [];
    const metrics = createDiscordEventMetrics({
        now: () => nowMs,
        recordMetric: (metricName, context) => recordedMetrics.push({ metricName, context }),
    });
    const client = new EventEmitter();

    assert.equal(metrics.register(client), true);
    assert.equal(metrics.register(client), false);
    assert.equal(client.listenerCount(Events.Raw), 1);

    client.emit(Events.Raw, { t: 'MESSAGE_CREATE' }, 0);
    nowMs += 1000;
    client.emit(Events.Raw, { t: 'MESSAGE_CREATE' }, 0);
    nowMs += 1000;
    client.emit(Events.Raw, { t: 'INTERACTION_CREATE' }, 1);

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.lastMinute, 3);
    assert.equal(snapshot.lastHour, 3);
    assert.equal(snapshot.lastDay, 3);
    assert.deepEqual(snapshot.byEventType, [
        { eventType: 'MESSAGE_CREATE', count: 2 },
        { eventType: 'INTERACTION_CREATE', count: 1 },
    ]);
    assert.deepEqual(snapshot.byShard, [
        { shardId: '0', count: 2 },
        { shardId: '1', count: 1 },
    ]);

    assert.deepEqual(recordedMetrics.map(item => item.metricName), [
        _internal.TOTAL_METRIC_NAME,
        _internal.TOTAL_METRIC_NAME,
        _internal.TOTAL_METRIC_NAME,
    ]);
    assert.deepEqual(recordedMetrics.map(item => item.context.endpointKey), [
        'MESSAGE_CREATE',
        'MESSAGE_CREATE',
        'INTERACTION_CREATE',
    ]);
    assert.ok(recordedMetrics.every(item => item.context.occurredAtMs <= nowMs));

    assert.equal(metrics.unregister(client), true);
    assert.equal(metrics.unregister(client), false);
    client.emit(Events.Raw, { t: 'MESSAGE_DELETE' }, 0);
    assert.equal(metrics.snapshot().total, 3);
});

test('discord event metrics: calculates rolling one-minute, one-hour, and one-day windows', () => {
    let nowMs = 0;
    const metrics = createDiscordEventMetrics({
        now: () => nowMs,
        recordMetric() {},
    });

    metrics.record({ t: 'READY' }, 0);
    nowMs = 30 * 1000;
    metrics.record({ t: 'GUILD_CREATE' }, 0);

    assert.deepEqual(
        Object.fromEntries(Object.entries(metrics.snapshot()).filter(([key]) => [
            'total', 'lastMinute', 'lastHour', 'lastDay',
        ].includes(key))),
        { total: 2, lastMinute: 2, lastHour: 2, lastDay: 2 },
    );

    nowMs = 60 * 1000;
    assert.equal(metrics.snapshot().lastMinute, 1);
    assert.equal(metrics.snapshot().lastHour, 2);
    assert.equal(metrics.snapshot().lastDay, 2);

    nowMs = 60 * 60 * 1000;
    assert.equal(metrics.snapshot().lastHour, 1);
    assert.equal(metrics.snapshot().lastDay, 2);

    nowMs = 24 * 60 * 60 * 1000;
    assert.equal(metrics.snapshot().lastDay, 1);

    nowMs += 30 * 1000;
    const expiredSnapshot = metrics.snapshot();
    assert.equal(expiredSnapshot.lastDay, 0);
    assert.equal(expiredSnapshot.total, 2);
});

test('discord event metrics: normalizes missing event types without retaining payload data', () => {
    const recordedContexts = [];
    const metrics = createDiscordEventMetrics({
        now: () => 1000,
        recordMetric: (_metricName, context) => recordedContexts.push(context),
    });

    metrics.record({}, undefined);
    metrics.record({ t: ' CUSTOM EVENT! ' }, undefined);

    assert.deepEqual(metrics.snapshot().byEventType, [
        { eventType: 'CUSTOM EVENT!', count: 1 },
        { eventType: 'UNKNOWN', count: 1 },
    ]);
    assert.deepEqual(recordedContexts, [
        { occurredAtMs: 1000, endpointKey: 'UNKNOWN' },
        { occurredAtMs: 1000, endpointKey: 'CUSTOM EVENT!' },
    ]);
});

test('discord event metrics: application registers the raw listener before login', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    const schemaPosition = source.indexOf('await ensureDatabaseSchema()');
    const registrationPosition = source.indexOf('discordEventMetrics.register(client)');
    const loginPosition = source.indexOf('await client.login(config.token)');

    assert.ok(schemaPosition >= 0);
    assert.ok(registrationPosition > schemaPosition);
    assert.ok(loginPosition > registrationPosition);
});
