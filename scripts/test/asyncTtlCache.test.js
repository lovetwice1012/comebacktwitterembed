'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AsyncTtlCache } = require('../../src/asyncTtlCache');

test('settings cache coalesces 100 simultaneous cold reads and refreshes after expiry', async () => {
    let now = 0;
    let calls = 0;
    const cache = new AsyncTtlCache({ ttlMs: 30, now: () => now });
    const load = async () => ++calls;
    assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => cache.getOrLoad('guild', load))), Array(100).fill(1));
    now = 29;
    assert.equal(await cache.getOrLoad('guild', load), 1);
    now = 30;
    assert.equal(await cache.getOrLoad('guild', load), 2);
});

test('invalidation during a slow read cannot replace a newer cached setting', async () => {
    const cache = new AsyncTtlCache();
    let finish;
    const old = cache.getOrLoad('guild', () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    cache.delete('guild');
    assert.equal(await cache.getOrLoad('guild', () => 'new'), 'new');
    finish('old');
    assert.equal(await old, 'old');
    assert.equal(await cache.getOrLoad('guild', () => assert.fail('must stay cached')), 'new');
});

test('failed reads are retryable without erasing a newer in-flight read', async () => {
    const cache = new AsyncTtlCache();
    let rejectOld;
    const old = cache.getOrLoad('guild', () => new Promise((_, reject) => { rejectOld = reject; }));
    await Promise.resolve();
    cache.clear();
    const current = cache.getOrLoad('guild', () => 'new');
    rejectOld(new Error('offline'));
    await assert.rejects(old, /offline/);
    assert.equal(await current, 'new');
    assert.equal(await cache.getOrLoad('guild', () => 'wrong'), 'new');
    await assert.rejects(cache.getOrLoad('failed', () => { throw new Error('failed'); }), /failed/);
    assert.equal(await cache.getOrLoad('failed', () => 'retry'), 'retry');
});

test('settings cache retains a fixed number of guilds and evicts least recently used entries', async () => {
    const cache = new AsyncTtlCache({ maxSize: 2 });
    await cache.getOrLoad('a', () => 1);
    await cache.getOrLoad('b', () => 2);
    await cache.getOrLoad('a', () => 3);
    await cache.getOrLoad('c', () => 4);
    assert.equal(cache.size, 2);
    assert.equal(await cache.getOrLoad('a', () => 5), 1);
    assert.equal(await cache.getOrLoad('b', () => 6), 6);
    for (let i = 0; i < 13200; i++) await cache.getOrLoad(String(i), () => i);
    assert.equal(cache.size, 2);
});
