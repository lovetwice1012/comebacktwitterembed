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
