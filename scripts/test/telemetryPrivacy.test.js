'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const telemetry = require('../../src/adminSupport/telemetry');

test('persistent telemetry omits secret fields and secret URL parameters', () => {
    const evidence = telemetry.serializable({
        authorization: 'Bearer private-value',
        nested: {
            token: 'private-value',
            keep: 'visible',
            url: 'https://example.test/path?stkn=private-value&keep=1',
        },
        content: 'inspect https://example.test/path?stkn=private-value&keep=1',
    });
    const serialized = JSON.stringify(evidence);

    assert.equal(evidence.authorization, undefined);
    assert.equal(evidence.nested.token, undefined);
    assert.equal(evidence.nested.keep, 'visible');
    assert.doesNotMatch(evidence.nested.url, /stkn=/);
    assert.match(evidence.nested.url, /keep=1/);
    assert.doesNotMatch(evidence.content, /stkn=/);
    assert.doesNotMatch(serialized, /private-value/);
});
