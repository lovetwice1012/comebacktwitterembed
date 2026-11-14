'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createRestoreJournal } = require('../../src/twitterGridRestoreJournal');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (![33621, 33622].includes(port)) throw Error('An explicit isolated test database port is required');

test('restore intents remain committed across manifest rollback and fence late cleanup', { timeout: 60000 }, async () => {
    const database = await createTestDatabase(port);
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.AUTOMATION_TEST_DB_PASSWORD || '',
        database: database.schema, connectionLimit: 2, supportBigNumbers: true, bigNumberStrings: true });
    database.queryDatabaseIndependent = (sql, params = []) => new Promise((resolve, reject) => pool.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    try {
        await database.queryDatabase(`CREATE TABLE IF NOT EXISTS bot_twitter_grid_action_intents (
            gallery_id CHAR(32) PRIMARY KEY,guild_id VARCHAR(22),channel_id VARCHAR(22),message_id VARCHAR(22),
            operation_id CHAR(32),payload_json LONGTEXT,updated_at_ms BIGINT) ENGINE=InnoDB`);
        // A deliberately separate connection verifies the exact production
        // requirement rather than using the enclosing transaction context.
        const scope = { lockId: 'a'.repeat(32), galleryId: 'a'.repeat(32), guildId: '111111111111111111',
            channelId: '222222222222222222', messageId: '333333333333333333' };
        const urls = Array.from({ length: 13 }, (_, i) => `https://pbs.twimg.com/media/photo${i}?format=jpg`);
        const journal = createRestoreJournal(database, scope), spec = { edit: urls.slice(0, 10), sends: [urls.slice(10)] };
        const request = { mode: 'rest' }, source = { id: '1234567890123456789' };
        const snapshot = { first: { id: scope.messageId, content: '', embeds: [], attachments: new Map(), components: [] }, payload: { imageUrls: urls } };
        const proofs = (op, start, count) => Array.from({ length: count }, (_, i) => ({ name: `restore-${op.id}-${start + i}.jpg`, sha256: 'f'.repeat(64) }));
        const firstSplit = { edit: urls.slice(0, 8), sends: [urls.slice(8, 10)] };
        await assert.rejects(journal.begin({ mode: 'first' }, snapshot, firstSplit, source), /GRID_RESTORE_CONFIRM_REQUIRED/);
        const confirmed = await journal.begin({ mode: 'first', splitConfirmed: true }, snapshot, firstSplit, source);
        await journal.cancel(confirmed);
        const canceled = await journal.begin(request, snapshot, spec, source);
        await journal.cancel(canceled);
        assert.equal((await database.queryDatabase('SELECT gallery_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [scope.lockId])).length, 0);
        let op;
        await assert.rejects(database.withDatabaseTransaction(async () => {
            op = await journal.begin(request, snapshot, spec, source);
            await journal.plan(op, { index: 0, type: 'edit', start: 0, count: 10, previousId: scope.messageId, proofs: proofs(op, 0, 10) });
            await journal.confirm(op, { index: 0, type: 'edit', messageId: scope.messageId });
            throw Error('simulated manifest rollback');
        }), /simulated manifest rollback/);
        const rows = await database.queryDatabase('SELECT operation_id,payload_json FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [scope.lockId]);
        assert.equal(rows.length, 1); assert.equal(rows[0].operation_id, op.id);
        assert.equal(JSON.parse(rows[0].payload_json).steps[0].state, 'confirmed');
        await assert.rejects(journal.cancel(op), /GRID_RESTORE_JOURNAL_INVALID/);
        await assert.rejects(journal.markFinished(op), /GRID_RESTORE_JOURNAL_INVALID/);
        await assert.rejects(journal.begin(request, snapshot, spec, source), /duplicate/i);
        await journal.plan(op, { index: 1, type: 'send', start: 10, count: 3, previousId: scope.messageId, proofs: proofs(op, 10, 3) });
        await journal.markUnknown(op);
        await assert.rejects(journal.plan(op, { index: 2, type: 'send', start: 2, count: 1, previousId: scope.messageId }), /GRID_RESTORE_JOURNAL_INVALID/);
        await assert.rejects(journal.clearAfterCommit(op), /GRID_RESTORE_JOURNAL_INVALID/);
        // A separate fixture operation has been externally reconciled. Once
        // cleared, a stale cleanup may not erase its successor's record.
        await database.queryDatabaseIndependent('DELETE FROM bot_twitter_grid_action_intents WHERE gallery_id=? AND operation_id=?', [scope.lockId, op.id]);
        const old = await journal.begin({ mode: 'first' }, snapshot, { edit: urls.slice(0, 10), sends: [] }, source);
        await journal.plan(old, { index: 0, type: 'edit', start: 0, count: 10, previousId: scope.messageId, proofs: proofs(old, 0, 10) });
        await journal.confirm(old, { index: 0, type: 'edit', messageId: scope.messageId });
        await journal.markFinished(old); await journal.clearAfterCommit(old);
        const next = await journal.begin(request, snapshot, spec, source);
        await journal.clearAfterCommit(old);
        const after = await database.queryDatabase('SELECT operation_id FROM bot_twitter_grid_action_intents WHERE gallery_id=?', [scope.lockId]);
        assert.equal(after[0].operation_id, next.id);
    } finally {
        await new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve()));
        await database.close();
    }
});

test('independent transaction atomically commits or rolls back both plan and gallery', { timeout: 60000 }, async () => {
    const database = await createTestDatabase(port);
    try {
        await database.queryDatabase('CREATE TABLE restore_plan_fixture (id INT PRIMARY KEY, value INT) ENGINE=InnoDB');
        await database.queryDatabase('CREATE TABLE restore_gallery_fixture (id INT PRIMARY KEY, value INT) ENGINE=InnoDB');
        await database.queryDatabase('INSERT INTO restore_plan_fixture VALUES (1,0)');
        await database.queryDatabase('INSERT INTO restore_gallery_fixture VALUES (1,0)');
        await assert.rejects(database.withDatabaseTransaction(async () => {
            await database.withIndependentTransaction(async query => {
                await query('UPDATE restore_plan_fixture SET value=1 WHERE id=1');
                await query('UPDATE restore_gallery_fixture SET value=1 WHERE id=1');
            });
            throw Error('outer rollback');
        }), /outer rollback/);
        assert.equal((await database.queryDatabase('SELECT value FROM restore_plan_fixture WHERE id=1'))[0].value, 1);
        assert.equal((await database.queryDatabase('SELECT value FROM restore_gallery_fixture WHERE id=1'))[0].value, 1);
        await assert.rejects(database.withIndependentTransaction(async query => {
            await query('UPDATE restore_plan_fixture SET value=2 WHERE id=1');
            await query('UPDATE restore_gallery_fixture SET value=2 WHERE id=1');
            throw Error('independent rollback');
        }), /independent rollback/);
        assert.equal((await database.queryDatabase('SELECT value FROM restore_plan_fixture WHERE id=1'))[0].value, 1);
        assert.equal((await database.queryDatabase('SELECT value FROM restore_gallery_fixture WHERE id=1'))[0].value, 1);
    } finally { await database.close(); }
});
