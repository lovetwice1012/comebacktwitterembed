'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const handlerPath = require.resolve('../../src/commands/handlers/autoextract/checkfreeslot');
const dbPath = require.resolve('../../src/db');

async function queryDatabaseStub(sql, params) {
    if (sql.includes('COUNT(*) AS total')) return [{ total: 0 }];
    return [];
}

test('autoextract checkfreeslot handles users row missing', async () => {
    const originalDb = require.cache[dbPath];
    const originalHandler = require.cache[handlerPath];

    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { queryDatabase: queryDatabaseStub },
    };
    delete require.cache[handlerPath];

    try {
        const checkfreeslot = require(handlerPath);
        let reply = null;
        const interaction = {
            user: { id: 'user-without-row' },
            editReply: async (payload) => {
                reply = payload;
            },
        };

        await checkfreeslot(interaction, {});

        assert.equal(reply.embeds[0].title, 'Auto extract check free slot');
        assert.match(reply.embeds[0].description, /\/0/);
    } finally {
        delete require.cache[handlerPath];
        if (originalHandler) require.cache[handlerPath] = originalHandler;
        if (originalDb) require.cache[dbPath] = originalDb;
        else delete require.cache[dbPath];
    }
});
