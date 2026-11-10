'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSyntheticWorker } = require('../../experiments/chrome-push/edge-fixture-process.cjs');

test('synthetic worker refuses non-test mode, non-fixture schemas and other ports', () => {
    const previous = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'production';
        assert.throws(() => startSyntheticWorker({ schema: `cbte_automation_test_${'a'.repeat(20)}`, dbPort: 33621 }), /PROBE_WORKER_INPUT_INVALID/);
        process.env.NODE_ENV = 'test';
        assert.throws(() => startSyntheticWorker({ schema: 'real_schema', dbPort: 33621 }), /PROBE_WORKER_INPUT_INVALID/);
        assert.throws(() => startSyntheticWorker({ schema: `cbte_automation_test_${'a'.repeat(20)}`, dbPort: 3306 }), /PROBE_WORKER_INPUT_INVALID/);
    } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('synthetic worker cannot run directly without its private IPC', () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../experiments/chrome-push/edge-fixture-worker.cjs')],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
