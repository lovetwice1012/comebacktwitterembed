'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyaddr = require('proxy-addr');

test('IPv4 addresses cannot be trusted through overly broad IPv6 proxy ranges', () => {
    const request = { socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-forwarded-for': '203.0.113.10' } };
    for (const range of ['::ffff:10.0.0.0/8', '::/1']) {
        const trust = proxyaddr.compile(range);
        assert.equal(trust('8.8.8.8'), false);
        assert.equal(proxyaddr(request, trust), '8.8.8.8');
    }
    const correct = proxyaddr.compile('::ffff:10.0.0.0/104');
    assert.equal(correct('10.1.2.3'), true); assert.equal(correct('8.8.8.8'), false);
});
