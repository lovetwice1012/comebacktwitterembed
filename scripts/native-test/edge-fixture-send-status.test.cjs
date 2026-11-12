'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifySendResponse, formatSendResponses } = require('../../experiments/chrome-push/edge-fixture-send-status.cjs');

test('synthetic status classification never returns arbitrary response contents', () => {
    const result = classifySendResponse({ statusCode: 201, headers: { 'x-wns-deviceconnectionstatus': 'disconnected', 'x-wns-status': 'received',
        'x-wns-msg-id': 'secret-message-id', 'location': 'secret-endpoint' }, body: 'secret-body' });
    assert.equal(result, 'H201-DDISCONNECTED-WRECEIVED');
    assert.equal(classifySendResponse({ statusCode: 'secret', headers: { 'x-wns-deviceconnectionstatus': 'secret', 'x-wns-status': 'secret' } }),
        'HUNKNOWN-DOTHER-WOTHER');
    assert.equal(classifySendResponse({ statusCode: 202, headers: {} }), 'H202-DABSENT-WABSENT');
    assert.equal(classifySendResponse({ statusCode: 410, headers: { 'x-wns-deviceconnectionstatus': ['connected'], 'x-wns-status': 'DROPPED' } }),
        'H410-DOTHER-WDROPPED');
    assert(!result.includes('secret'));
});
test('only three bounded classified statuses can be formatted', () => {
    assert.equal(formatSendResponses(['H201-DABSENT-WABSENT', 'H200-DCONNECTED-WRECEIVED']),
        'H201-DABSENT-WABSENT;H200-DCONNECTED-WRECEIVED');
    for (const input of [['secret'], Array(4).fill('H200-DABSENT-WABSENT'), [null], 'H200-DABSENT-WABSENT'])
        assert.throws(() => formatSendResponses(input), /PROBE_SEND_DIAGNOSTIC_INVALID/);
});
