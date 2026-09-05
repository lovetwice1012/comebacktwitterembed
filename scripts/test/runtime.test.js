'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    BUN_RUNTIME_DISABLED_MESSAGE,
    MINIMUM_NODE_VERSION,
    assertSupportedRuntime,
} = require('../../src/runtime');

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

test('runtime guard accepts supported Node versions', () => {
    assert.equal(assertSupportedRuntime({ node: '24.0.0' }), 'node');
    assert.equal(assertSupportedRuntime({ node: MINIMUM_NODE_VERSION }), 'node');
});

test('runtime guard rejects old Node and all Bun runtimes with actionable errors', () => {
    assert.throws(
        () => assertSupportedRuntime({ node: '22.11.9' }),
        error => {
            assert.match(error.message, /Unsupported Node\.js version: 22\.11\.9/);
            assert.match(error.message, new RegExp('Node\\.js ' + MINIMUM_NODE_VERSION));
            return true;
        }
    );
    assert.throws(
        () => assertSupportedRuntime({ node: '24.0.0', bun: '1.3.14' }),
        error => {
            assert.equal(error.message, BUN_RUNTIME_DISABLED_MESSAGE);
            return true;
        }
    );
});

test('production startup remains pinned to Node rather than Bun', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const serviceUnit = fs.readFileSync(path.join(repoRoot, 'deploy', 'systemd', 'cbte.service'), 'utf8');

    assert.equal(packageJson.scripts.start, 'node index.js');
    assert.equal(packageJson.engines.node, '>=22.12.0');
    assert.equal(packageJson.engines.bun, undefined);
    assert.match(serviceUnit, /^ExecStart=\/usr\/local\/bin\/node \.\/index\.js$/m);
    assert.match(serviceUnit, /^Restart=on-failure$/m);
    assert.doesNotMatch(serviceUnit, /bun \.\/index\.js/);
});
