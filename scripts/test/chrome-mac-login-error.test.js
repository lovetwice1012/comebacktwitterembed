'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifySyntheticLoginError } = require('../native-test/chrome-mac-login-error.cjs');
const field = (number, value) => { const data = Buffer.from(value); return Buffer.concat([Buffer.from([number * 8 + 2, data.length]), data]); };

test('synthetic login diagnostics return only fixed categories', () => {
    const response = text => field(3, Buffer.concat([Buffer.from([8, 1]), field(2, text)]));
    assert.equal(classifySyntheticLoginError(response('token expired private-value')), 'EXPIRED');
    assert.equal(classifySyntheticLoginError(response('device denied private-value')), 'DEVICE');
    assert.equal(classifySyntheticLoginError(response('private-value')), 'OTHER');
    assert.equal(classifySyntheticLoginError(Buffer.from([26, 9, 1])), 'MALFORMED');
    assert.ok(!classifySyntheticLoginError(response('private-value')).includes('private-value'));
});
