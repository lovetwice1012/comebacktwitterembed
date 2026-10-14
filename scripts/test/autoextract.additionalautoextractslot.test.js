'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const handlerPath = require.resolve('../../src/commands/handlers/autoextract/additionalautoextractslot');
const dbPath = require.resolve('../../src/db');
const grantsPath = require.resolve('../../src/automation/push-support-grants');

const DONOR_GUILD_ID = '1132814274734067772';
const DONOR_CHANNEL_ID = '1201521425756979352';
const DONOR_OPERATOR_ID = '796972193287503913';
const TARGET_USER_ID = '123456789012345678';

function createInteraction(overrides = {}) {
    const replies = [];
    return {
        interaction: {
            id: '123456789012345679',
            guildId: DONOR_GUILD_ID,
            channelId: DONOR_CHANNEL_ID,
            user: { id: DONOR_OPERATOR_ID },
            locale: 'en-US',
            member: { permissions: { has: () => true } },
            options: {
                getInteger: name => name === 'slot' ? 7 : null,
                getUser: name => name === 'user' ? { id: TARGET_USER_ID } : null,
            },
            editReply: async payload => replies.push(payload),
            followUp: async payload => replies.push(payload),
            ...overrides,
        },
        replies,
    };
}

async function withHandler(queryDatabase, callback, adjustments = []) {
    const originalDb = require.cache[dbPath];
    const originalHandler = require.cache[handlerPath];
    const originalGrants = require.cache[grantsPath];
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { queryDatabase, withDatabaseTransaction: work => work(queryDatabase) },
    };
    require.cache[grantsPath] = { id: grantsPath, filename: grantsPath, loaded: true, exports: { explicitAdminAdjustment: async (query, actor, input) => { adjustments.push({ actor, input }); } } };
    delete require.cache[handlerPath];

    try {
        await callback(require(handlerPath));
    } finally {
        delete require.cache[handlerPath];
        if (originalHandler) require.cache[handlerPath] = originalHandler;
        if (originalDb) require.cache[dbPath] = originalDb;
        else delete require.cache[dbPath];
        if (originalGrants) require.cache[grantsPath] = originalGrants;
        else delete require.cache[grantsPath];
    }
}

test('additionalautoextractslot marks only its approved target as a donor and lists donors', async () => {
    const queries = [];
    const adjustments = [];
    const { interaction, replies } = createInteraction();

    await withHandler(async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT user_id FROM users WHERE is_donor = 1')) {
            return [{ user_id: TARGET_USER_ID }];
        }
        if (sql.includes('SELECT additional_auto_extract_slots')) return [{ additional_auto_extract_slots: 3 }];
        return { affectedRows: 1 };
    }, async additionalAutoExtractSlot => {
        await additionalAutoExtractSlot(interaction, {});
    }, adjustments);

    const insert = queries.find(query => query.sql.includes('INSERT INTO users'));
    assert.ok(insert);
    assert.equal(insert.params[0], TARGET_USER_ID);
    assert.equal(typeof insert.params[1], 'number');
    assert.equal(queries.filter(query => query.sql.includes('INSERT INTO users')).length, 1);
    assert.deepEqual(adjustments, [{ actor: { userId: DONOR_OPERATOR_ID, isAdmin: true }, input: { userId: TARGET_USER_ID, idempotencyKey: 'discord:123456789012345679', expectedManualSlots: 3, manualSlots: 7, reason: 'Approved Discord additionalautoextractslot command' } }]);
    assert.ok(queries.some(query => query.sql.includes('UPDATE users SET is_donor=1') && query.params[0] === TARGET_USER_ID));
    assert.equal(replies.length, 1);
    assert.match(replies[0].embeds[0].description, new RegExp(`<@${TARGET_USER_ID}>`));
});

test('additionalautoextractslot requires a real interaction ID before an audited mutation', async () => {
    const queries = [], adjustments = [];
    const { interaction, replies } = createInteraction({ id: undefined });
    await withHandler(async (...input) => { queries.push(input); return []; }, handler => handler(interaction, {}), adjustments);
    assert.equal(queries.length, 0); assert.equal(adjustments.length, 0);
    assert.match(replies[0], /Interaction ID/);
});

test('additionalautoextractslot does not change donor flags outside the approved guild, channel, and operator context', async () => {
    const queries = [];
    const { interaction, replies } = createInteraction({ channelId: '1201521425756979353' });

    await withHandler(async (sql, params) => {
        queries.push({ sql, params });
        return [];
    }, async additionalAutoExtractSlot => {
        await additionalAutoExtractSlot(interaction, {});
    });

    assert.equal(queries.length, 0);
    assert.equal(replies.length, 1);
});
