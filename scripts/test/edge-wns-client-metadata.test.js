'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindFrame } = require('../../src/automation/edge-wns-protocol');
const { parseEdgeClientMetadata } = require('../../src/automation/edge-wns-client-metadata');
function fixture() {
    return bindFrame({ channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4', nonce: '1'.repeat(32),
        reconnectToken: Buffer.from('PRIVATE-SYNTHETIC-TOKEN'), deviceKey: Buffer.alloc(32, 7) }, 3);
}
function frame(body, route = 'CON\\WNS abc') {
    const data = Buffer.from(`MS-CV: fixture\r\n\r\n${body}`, 'ascii'); return Buffer.concat([Buffer.from(`BND 3 ${route} ${data.length}\r\n`), data]);
}
test('extracts only protocol metadata from a bounded client bind request', () => {
    const data = fixture(), original = Buffer.from(data), metadata = parseEdgeClientMetadata(data);
    assert.deepEqual(metadata, { channel: 'abc', protocolVersion: '1.0', clientName: 'Synthetic', clientVersion: '1.2.3.4' });
    assert.deepEqual(data, original); assert(!JSON.stringify(metadata).includes('PRIVATE-SYNTHETIC-TOKEN')); data.fill(0); original.fill(0);
});
test('rejects malformed, ambiguous and injected requests without exposing them', () => {
    const valid = fixture(), badHeaders = Buffer.from(valid), headerOffset = badHeaders.indexOf('\r\n') + 2; badHeaders[headerOffset] = 1;
    const invalid = [valid.subarray(0, -1), badHeaders, Buffer.alloc(300000), frame('<wns><ver>1.0</ver><client><name>x</name><ver>1</ver></client></wns>', 'OTHER abc'),
        frame('<wns><ver>1.0</ver><client><name>x</name><ver>1</ver><name>other</name></client></wns>'),
        frame('<wns><ver>1.0</ver><client><name>x&amp;y</name><ver>1</ver></client></wns>'), frame('<wns><ver>1.0</ver><client><name>x</name><ver>1</ver>')];
    for (const input of invalid) assert.throws(() => parseEdgeClientMetadata(input), error => error.code === 'X_EDGE_WNS_METADATA_INVALID'
        && !String(error.stack).includes('PRIVATE-SYNTHETIC-TOKEN'));
    valid.fill(0);
});
