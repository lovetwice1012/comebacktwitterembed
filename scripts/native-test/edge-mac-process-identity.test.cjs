'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const helper = process.env.MAC_IDENTITY_HELPER;

test('Edge identity checks process owner, parent, executable and full start time', { skip: !helper }, () => {
    function run(pid, mode) {
        const env = { ...process.env, MAC_IDENTITY_TEST_CASE: mode };
        return spawnSync(helper, [pid], { env, encoding: 'utf8', timeout: 5000 });
    }
    const good = run('123', 'good'); assert.equal(good.status, 0); assert.equal(good.stdout, '1700000000:123456\n'); assert.equal(good.stderr, '');
    for (const mode of ['missing', 'pid', 'parent', 'user', 'seconds', 'microseconds', 'path']) {
        const bad = run('123', mode); assert.notEqual(bad.status, 0); assert.equal(bad.stdout, ''); assert.equal(bad.stderr, '');
    }
    for (const pid of ['', '0', '000123', '4', '-1', '12x', '2147483648']) {
        const bad = run(pid, 'good'); assert.notEqual(bad.status, 0); assert.equal(bad.stdout, '');
    }
});
