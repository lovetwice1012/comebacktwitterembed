'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function probe(sequence) {
    const source = await fs.readFile(path.join(__dirname, '../../src/automation/chrome-mac-process-group.js'), 'utf8');
    const module = { exports: {} }; let calls = 0;
    const process = { kill(pid, signal) {
        assert.equal(pid, -12345); assert.equal(signal, 0);
        const outcome = sequence[Math.min(calls++, sequence.length - 1)];
        if (outcome !== 'alive') throw Object.assign(new Error('synthetic'), { code: outcome });
    } };
    vm.runInNewContext(source, { module, exports: module.exports, process, Number, Date, setTimeout });
    return { wait: module.exports.waitForMacProcessGroupExit, calls: () => calls };
}
test('group exit waits through permission errors and requires an observed absence', async () => {
    const p = await probe(['EPERM', 'ESRCH']);
    assert.equal(await p.wait(12345, { timeoutMs: 100, intervalMs: 1 }), true); assert.equal(p.calls(), 2);
    const denied = await probe(['EPERM']); assert.equal(await denied.wait(12345, { timeoutMs: 0, intervalMs: 1 }), false);
    const bad = await probe(['EINVAL']); assert.equal(await bad.wait(12345, { timeoutMs: 100, intervalMs: 1 }), false);
});
