'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectFrameForVersion } = require('../../src/automation/edge-wns-connect-version');
const { parseEdgeAgentMetadata } = require('../../src/automation/edge-wns-agent-metadata');
const agent = { os: 'SyntheticOS', osVersion: '1.2.3', architecture: 'synthetic64', locale: 'ja-JP' };

test('experimental connect builder preserves the requested version and agent', () => {
    for (const version of ['1', '2']) {
        const frame = connectFrameForVersion(agent, 1, version);
        try { assert.deepEqual(parseEdgeAgentMetadata(frame), { connectVersion: version, agent }); }
        finally { frame.fill(0); }
    }
});
test('experimental connect builder rejects unsupported versions, invalid metadata and sequences', () => {
    for (const version of ['0', '3', 1, null, undefined, '2</ver>'])
        assert.throws(() => connectFrameForVersion(agent, 1, version), { code: 'X_EDGE_WNS_CONNECT_VERSION_INVALID' });
    assert.throws(() => connectFrameForVersion({ ...agent, os: '<private>' }, 1, '2'), { code: 'X_EDGE_WNS_CONNECT_VERSION_INVALID' });
    assert.throws(() => connectFrameForVersion(agent, 0, '1'), { code: 'X_EDGE_WNS_CONNECT_VERSION_INVALID' });
});
