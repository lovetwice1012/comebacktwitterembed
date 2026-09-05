'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const telemetry = require('../../src/adminSupport/telemetry');
const sources = require('../../src/adminSupport/providerSources');

test('provider sources allow only registered IDs and expired overrides automatically restore defaults', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cbte-provider-sources-'));
    const original = process.env.ADMIN_PROVIDER_OVERRIDE_FILE;
    process.env.ADMIN_PROVIDER_OVERRIDE_FILE = path.join(directory, 'sources.json');
    t.after(async () => { if (original === undefined) delete process.env.ADMIN_PROVIDER_OVERRIDE_FILE; else process.env.ADMIN_PROVIDER_OVERRIDE_FILE = original; await fs.rm(directory, { recursive: true, force: true }); });
    assert.equal((await sources.resolvePlan('twitter')).sourceId, 'vxtwitter');
    await assert.rejects(sources.switchSource({ providerId: 'twitter', sourceId: 'https://attacker.invalid', ttlSeconds: 10 }), { code: 'UNREGISTERED_SOURCE' });
    const switched = await sources.switchSource({ providerId: 'twitter', sourceId: 'fxtwitter', ttlSeconds: 10 });
    assert.equal((await sources.resolvePlan('twitter')).sourceId, 'fxtwitter');
    const current = await telemetry.run({ preview: true, events: [], providerSourceId: 'default', providerSourceFallback: false }, () => sources.resolvePlan('twitter'));
    assert.equal(current.sourceId, 'fxtwitter');
    assert.equal(current.sources.length, 1);
    await assert.rejects(sources.switchSource({ providerId: 'twitter', sourceId: 'vxtwitter', expectedRevision: 'stale' }), { code: 'SOURCE_REVISION_CONFLICT' });
    const state = JSON.parse(await fs.readFile(process.env.ADMIN_PROVIDER_OVERRIDE_FILE, 'utf8'));
    state.overrides.twitter.expiresAt = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(process.env.ADMIN_PROVIDER_OVERRIDE_FILE, JSON.stringify(state));
    await sources.sources(); // fresh read updates the bounded runtime cache.
    assert.equal((await sources.resolvePlan('twitter')).sourceId, 'vxtwitter');
    assert.equal(switched.override.sourceId, 'fxtwitter');
});
test('diagnostic source choice is isolated and replay chooses recorded source without reading current overrides', async () => {
    const selected = await telemetry.run({ preview: true, events: [], providerSourceId: 'fxtwitter' }, () => sources.resolvePlan('twitter'));
    assert.equal(selected.sources.length, 1);
    assert.equal(selected.sources[0].origin, 'https://api.fxtwitter.com');
    const replayed = await telemetry.run({ preview: true, events: [], replay: [{ url: 'https://api.fxtwitter.com/a/status/1' }] }, () => sources.resolvePlan('twitter'));
    assert.equal(replayed.sourceId, 'fxtwitter');
    assert.equal(replayed.origin, 'saved_http_evidence');
});
