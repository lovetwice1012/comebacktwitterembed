'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseManifest } = require('../native-test/edge-mac-manifest-research.cjs');
test('research manifest accepts only the exact fixed schema and digest', () => {
    const hash = 'a'.repeat(64);
    assert.equal(parseManifest(JSON.stringify({ kind: 'mac-edge-lock-research-v1', addonSha256: hash })).addonSha256, hash);
    for (const text of ['{}', JSON.stringify({ kind: 'mac-edge-lock-research-v1', addonSha256: 'bad' }),
        JSON.stringify({ kind: 'wrong', addonSha256: hash }), `{"kind":"mac-edge-lock-research-v1","kind":"other","addonSha256":"${hash}"}`])
        assert.throws(() => parseManifest(text), { code: 'RESEARCH_MANIFEST_INVALID' });
});
