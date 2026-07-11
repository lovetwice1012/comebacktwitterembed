'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MINIMUM_NODE_VERSION,
    SUPPORTED_BUN_VERSION,
    assertSupportedRuntime,
} = require('../../src/runtime');

test('runtime guard accepts supported Node and Bun versions', () => {
    assert.equal(assertSupportedRuntime({ node: '24.0.0' }), 'node');
    assert.equal(assertSupportedRuntime({ node: MINIMUM_NODE_VERSION }), 'node');
    assert.equal(assertSupportedRuntime({ node: '22.0.0', bun: SUPPORTED_BUN_VERSION }), 'bun');
});

test('runtime guard rejects old runtimes with actionable version requirements', () => {
    assert.throws(
        () => assertSupportedRuntime({ node: '22.11.9' }),
        error => {
            assert.match(error.message, /Unsupported Node\.js version: 22\.11\.9/);
            assert.match(error.message, new RegExp('Node\\.js ' + MINIMUM_NODE_VERSION));
            return true;
        }
    );
    assert.throws(
        () => assertSupportedRuntime({ node: '24.0.0', bun: '1.3.13' }),
        error => {
            assert.match(error.message, /Unsupported Bun version: 1\.3\.13/);
            assert.match(error.message, new RegExp('Bun ' + SUPPORTED_BUN_VERSION));
            return true;
        }
    );
    assert.throws(
        () => assertSupportedRuntime({ node: '24.0.0', bun: '1.4.0' }),
        error => {
            assert.match(error.message, /Unsupported Bun version: 1\.4\.0/);
            assert.match(error.message, new RegExp('Bun ' + SUPPORTED_BUN_VERSION));
            return true;
        }
    );
});
