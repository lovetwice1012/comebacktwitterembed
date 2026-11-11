'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectFrame } = require('../../src/automation/edge-wns-protocol');
const { parseEdgeAgentMetadata } = require('../../src/automation/edge-wns-agent-metadata');
const agent = { os: 'SyntheticOS', osVersion: '1.2.3', architecture: 'synthetic64', locale: 'ja-JP' };
function frame(body, command = 'CNT 1 CON') {
    const data = Buffer.from(`Context: SYNTHETIC-PRIVATE\r\n\r\n${body}`, 'ascii');
    return Buffer.concat([Buffer.from(`${command} ${data.length}\r\n`, 'ascii'), data]);
}
test('extracts only agent values from a bounded synthetic connect request', () => {
    const input = connectFrame(agent, 1), original = Buffer.from(input), output = parseEdgeAgentMetadata(input);
    assert.deepEqual(output, agent); assert.deepEqual(input, original);
    assert(!JSON.stringify(output).includes('Context')); input.fill(0); original.fill(0);
});
test('rejects malformed, ambiguous or unrecognized agent requests without exposing content', () => {
    const body = '<connect><ver>1</ver><agent><os>SyntheticOS</os><osVer>1.2.3</osVer><proc>synthetic64</proc><lcid>ja-JP</lcid></agent></connect>';
    const valid = frame(body), nonAscii = frame(body); nonAscii[nonAscii.length - 1] = 0xff;
    const inputs = [valid.subarray(0, -1), Buffer.alloc(300000), nonAscii, frame(body, 'CNT 1 OTHER'),
        frame(body.replace('<os>SyntheticOS</os>', '<os>SyntheticOS</os><os>private</os>')),
        frame(body.replace('SyntheticOS', 'x&amp;y')), frame(body.replace('<ver>1</ver>', '<ver>2</ver>')),
        frame(body.replace('SyntheticOS', '')), frame(body.replace('SyntheticOS', 'x'.repeat(129))),
        frame(body.replace('</agent>', '<extra>private</extra></agent>')), frame(body.replace('</connect>', ''))];
    for (const input of inputs) assert.throws(() => parseEdgeAgentMetadata(input), error => error.code === 'X_EDGE_WNS_AGENT_INVALID'
        && !error.message.includes('PRIVATE') && !error.message.includes('private'));
    for (const input of inputs) input.fill(0);
});
