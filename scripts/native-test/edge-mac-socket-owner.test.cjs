'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const helper = process.env.MAC_SOCKET_HELPER;

test('Mac peer check accepts only an owned Edge descendant with the expected loopback socket', { skip: !helper }, () => {
    function run(args, mode = 'good') {
        const env = { ...process.env, MAC_IDENTITY_TEST_CASE: mode };
        return spawnSync(helper, args, { env, encoding: 'utf8', timeout: 5000 });
    }
    const args = ['123', '1700000000', '123456', '30001', '23457'];
    const good = run(args); assert.equal(good.status, 0); assert.equal(good.stdout, '1'); assert.equal(good.stderr, '');
    for (const mode of ['missing', 'pid', 'parent', 'user', 'seconds', 'microseconds', 'path', 'child-path', 'fd-error', 'child-error', 'port', 'address', 'closed', 'duplicate', 'reused']) {
        const bad = run(args, mode); assert.notEqual(bad.status, 0, mode); assert.equal(bad.stdout, '0'); assert.equal(bad.stderr, '');
    }
    for (const badArgs of [[], ['123', '1700000001', '123456', '30001', '23457'], ['123', '1700000000', '123456', '30001', '30001'],
        ['123', '18446744073709551616', '123456', '30001', '23457'], ['123', '1700000000', '1000000', '30001', '23457']]) {
        const bad = run(badArgs); assert.notEqual(bad.status, 0); assert.equal(bad.stdout, '0');
    }
});
