'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const storePath = require.resolve('../../src/expansionTraceStore');
const dbPath = require.resolve('../../src/db');

async function withStore(queryDatabase, callback) {
    const originalStore = require.cache[storePath];
    const originalDb = require.cache[dbPath];
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { queryDatabase },
    };
    delete require.cache[storePath];
    try {
        return await callback(require(storePath));
    } finally {
        delete require.cache[storePath];
        if (originalStore) require.cache[storePath] = originalStore;
        if (originalDb) require.cache[dbPath] = originalDb;
        else delete require.cache[dbPath];
    }
}

test('expansion trace start stores a redacted URL before queue processing', async () => {
    const calls = [];
    await withStore(async (sql, params, options) => {
        calls.push({ sql, params, options });
        return [];
    }, async store => {
        const result = await store.beginExpansionTrace({
            traceId: 'trace-1',
            bootId: 'boot-1',
            providerId: 'instagram',
            url: 'https://www.instagram.com/p/POST/?stkn=private-value&img_index=2',
            message: { id: 'message-1', guildId: 'guild-1', channelId: 'channel-1', author: { id: 'user-1' } },
        });
        assert.deepEqual(result, { traceId: 'trace-1', persisted: true });
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO bot_provider_expansion_traces/);
    assert.doesNotMatch(calls[0].params[5], /stkn=/);
    assert.doesNotMatch(calls[0].params[5], /private-value/);
    assert.equal(calls[0].params[8], 'guild-1');
    assert.equal(calls[0].options.timeoutMs, 5000);
});

test('expansion trace keeps output and delivery evidence in terminal updates', async () => {
    const calls = [];
    await withStore(async (sql, params) => {
        calls.push({ sql, params });
        return [];
    }, async store => {
        await store.beginExpansionTrace({ traceId: 'trace-2', bootId: 'boot-2', providerId: 'instagram', url: 'https://instagram.com/p/A/', message: {} });
        await store.updateExpansionTrace('trace-2', {
            state: 'sending',
            output: { embeds: [{ url: 'https://example.test/?token=hidden' }], files: [{ attachment: 'https://cdn.example/video.mp4?stkn=hidden' }] },
        });
        await store.updateExpansionTrace('trace-2', {
            state: 'completed',
            outcome: 'F',
            delivery: { sent: [{ message_id: 'sent-1' }] },
        });
    });

    assert.equal(calls.length, 3);
    const sending = calls[1].params;
    assert.equal(sending[0], 'sending');
    assert.doesNotMatch(sending[5], /hidden/);
    assert.doesNotMatch(sending[5], /token=/);
    const completed = calls[2].params;
    assert.equal(completed[0], 'completed');
    assert.equal(completed[1], 'F');
    assert.match(completed[6], /sent-1/);
});

test('startup and shutdown reconciliation mark in-flight traces interrupted', async () => {
    const calls = [];
    await withStore(async (sql, params) => {
        calls.push({ sql, params });
        return [];
    }, async store => {
        await store.beginExpansionTrace({ traceId: 'trace-3', bootId: 'old-boot', providerId: 'instagram', url: 'https://instagram.com/p/A/', message: {} });
        await store.reconcileInterruptedExpansionTraces('new-boot');
        await store.interruptActiveExpansionTraces('shutdown_SIGTERM');
    });

    assert.equal(calls.length, 3);
    assert.match(calls[1].sql, /state='interrupted'/);
    assert.equal(calls[1].params.at(-1), 'new-boot');
    assert.match(calls[2].sql, /state='interrupted'/);
    assert.equal(calls[2].params[0], 'shutdown_SIGTERM');
});
