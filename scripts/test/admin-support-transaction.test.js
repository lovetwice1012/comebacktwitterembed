'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('shared settings helpers use the same transaction connection and independent concurrent contexts', async () => {
    const poolPath = require.resolve('../../src/databasePool');
    const dbPath = require.resolve('../../src/db');
    const originalPool = require.cache[poolPath];
    const originalDb = require.cache[dbPath];
    const calls = [];
    let transactions = 0;
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: {
        createDatabasePool: () => ({
            query: async sql => { calls.push(['outside', sql]); return 'outside'; },
            withTransaction: async fn => {
                const number = ++transactions;
                return fn(async sql => { calls.push([number, sql]); return number; });
            },
        }),
    } };
    delete require.cache[dbPath];
    try {
        const db = require(dbPath);
        const values = await Promise.all([1, 2].map(index => db.withDatabaseTransaction(async () => {
            await new Promise(resolve => setImmediate(resolve));
            const direct = await db.queryDatabase(`direct-${index}`);
            const nested = await db.withDatabaseTransaction(() => db.queryDatabase(`nested-${index}`));
            assert.equal(direct, nested);
            return direct;
        })));
        assert.deepEqual(values, [1, 2]);
        assert.equal(transactions, 2);
        assert.equal(await db.queryDatabase('read-outside'), 'outside');
        assert.deepEqual(calls.filter(([kind]) => kind === 'outside'), [['outside', 'read-outside']]);
    } finally {
        if (originalPool) require.cache[poolPath] = originalPool; else delete require.cache[poolPath];
        if (originalDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath];
    }
});
