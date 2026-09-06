'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../../src/db');

test('database logging suppresses only explicitly expected migration error codes', () => {
    assert.equal(_internal.shouldLogDatabaseError({ code: 'ER_DUP_KEYNAME' }, {
        suppressErrorCodes: ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'],
    }), false);
    assert.equal(_internal.shouldLogDatabaseError({ code: 'ER_ACCESS_DENIED_ERROR' }, {
        suppressErrorCodes: ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'],
    }), true);
    assert.equal(_internal.shouldLogDatabaseError({ code: 'ER_DUP_KEYNAME' }, {}), true);
});

test('telemetry owns persistence failure logging and diagnostics never embed rendered SQL', () => {
    assert.equal(_internal.shouldLogDatabaseError({ code: 'ER_NO_SUCH_USER' }, { logErrors: false }), false);
    const error = Object.assign(new Error('missing trigger definer'), {
        code: 'ER_NO_SUCH_USER', errno: 1449, sqlState: 'HY000',
        sql: 'INSERT INTO bot_analytics_events VALUES (' + 'prior telemetry'.repeat(100000) + ')',
        sqlMessage: 'x'.repeat(20000),
    });
    const diagnostic = _internal.databaseErrorDiagnostic(error);
    assert.equal(diagnostic.code, 'ER_NO_SUCH_USER');
    assert.equal(diagnostic.errno, 1449);
    assert.ok(diagnostic.message.length <= 4096);
    assert.ok(diagnostic.stack.length <= 8192);
    assert.ok(JSON.stringify(diagnostic).length < 13000);
    assert.equal('sql' in diagnostic, false);
    assert.ok(error.sql.length > 1000000);
});
