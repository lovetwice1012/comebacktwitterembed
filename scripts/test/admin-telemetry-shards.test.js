'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal, contextFromMessage } = require('../../src/adminSupport/telemetry');

test('admin telemetry reports shard availability and bounded ping evidence', () => {
    const client = {
        ws: {
            status: 0,
            shards: new Map([
                [0, { id: 0, status: 0, ping: 42, lastPingTimestamp: 1700000000000 }],
                [1, { id: 1, status: 2, ping: -1, lastPingTimestamp: -1 }],
                [2, { id: 2, status: 99, ping: 18, lastPingTimestamp: 1700000000001 }],
            ]),
        },
    };
    assert.deepEqual(_internal.shardSnapshot(client), {
        managerStatus: 'ready',
        total: 3,
        online: 1,
        offline: 1,
        unknown: 1,
        items: [
            { shard_id: '0', shardId: '0', status: 'ready', online: true, ping_ms: 42, last_ping_at_ms: 1700000000000 },
            { shard_id: '1', shardId: '1', status: 'reconnecting', online: false, ping_ms: null, last_ping_at_ms: null },
            { shard_id: '2', shardId: '2', status: 'unknown', online: null, ping_ms: 18, last_ping_at_ms: 1700000000001 },
        ],
    });
});

test('admin telemetry carries the Discord guild shard into request evidence', () => {
    assert.equal(contextFromMessage({ guild: { id: 'guild-1', shardId: 7 }, id: 'message-1' }).shard_id, 7);
    assert.equal(contextFromMessage({ guild: { id: 'guild-1', shardId: '8' }, id: 'message-2' }).shard_id, 8);
    assert.equal(contextFromMessage({ guild: { id: 'guild-1', shardId: -1 }, id: 'message-3' }).shard_id, null);
});
