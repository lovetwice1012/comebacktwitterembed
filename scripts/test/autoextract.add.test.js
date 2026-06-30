'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const handlerPath = require.resolve('../../src/commands/handlers/autoextract/add');
const dbPath = require.resolve('../../src/db');
const fetchPath = require.resolve('node-fetch');

async function queryDatabaseStub(sql, params) {
    if (sql.includes('additional_auto_extract_slots')) {
        return [{ additional_auto_extract_slots: 0 }];
    }
    if (sql.includes('COUNT(*) AS total')) {
        return [{ total: 0 }];
    }
    if (sql.includes('INSERT INTO twitter_accounts')) {
        return { affectedRows: 1 };
    }
    if (sql.includes('INSERT INTO webhook_endpoints')) {
        return { insertId: 123 };
    }
    if (sql.includes('INSERT INTO auto_extract_targets')) {
        return { affectedRows: 1 };
    }
    return [];
}

test('autoextract add posts webhook validation with node-fetch import and replies once for multiple webhooks', async () => {
    const originalDb = require.cache[dbPath];
    const originalFetch = require.cache[fetchPath];
    const originalHandler = require.cache[handlerPath];
    const originalGlobalFetch = global.fetch;
    const calls = [];

    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: {
            ensureUserExistsInDatabase: async () => {},
            queryDatabase: queryDatabaseStub,
        },
    };
    require.cache[fetchPath] = {
        id: fetchPath,
        filename: fetchPath,
        loaded: true,
        exports: async (url, options) => {
            calls.push({ url, options });
            return { status: 204 };
        },
    };
    delete require.cache[handlerPath];
    global.fetch = undefined;

    try {
        const add = require(handlerPath);
        const replies = [];
        const interaction = {
            user: { id: 'user-1' },
            locale: 'en',
            options: {
                getString(name) {
                    if (name === 'username') return 'twitter_user';
                    if (name === 'webhook') return 'https://discord.com/api/webhooks/123/abc_DEF-456, https://discord.com/api/webhooks/456/def_GHI-789';
                    return null;
                },
            },
            reply: async (payload) => {
                replies.push(payload);
            },
        };

        await add(interaction, {});

        assert.equal(calls.length, 2);
        assert.equal(calls[0].url, 'https://discord.com/api/webhooks/123/abc_DEF-456');
        assert.equal(calls[1].url, 'https://discord.com/api/webhooks/456/def_GHI-789');
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(replies.length, 1);
        assert.match(replies[0].embeds[0].description, /WEBHOOK: 2/);
    } finally {
        delete require.cache[handlerPath];
        if (originalHandler) require.cache[handlerPath] = originalHandler;
        if (originalDb) require.cache[dbPath] = originalDb;
        else delete require.cache[dbPath];
        if (originalFetch) require.cache[fetchPath] = originalFetch;
        else delete require.cache[fetchPath];
        global.fetch = originalGlobalFetch;
    }
});
