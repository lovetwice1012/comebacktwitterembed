'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createXPushRuntime } = require('../../src/automation/x-push-runtime');
const { renewalDelayMs } = require('../../src/automation/x-push-gateway');
const { randomUUID } = require('node:crypto');

test('simultaneously started receivers spread lease renewals before expiry', () => {
    const delays = Array.from({ length: 1000 }, () => renewalDelayMs(randomUUID(), 30000));
    assert(delays.every(value => value.interval === 10000 && value.firstDelay >= 10000 && value.firstDelay <= 15000));
    const buckets = new Set(delays.map(value => Math.floor(value.firstDelay / 500)));
    assert(buckets.size >= 9);
});

test('one worker supervises up to 1000 subscription sessions without per-session processes', async () => {
    const candidates = Array.from({ length: 1050 }, (_, i) => ({ id: String(i + 1).padStart(6, '0'), owner_user_id: '222222222222222222', revision: 1 }));
    const pids = new Set(), active = new Set();
    const gateway = { store: {}, run: input => {
        pids.add(process.pid); active.add(input.subscriptionId);
        return new Promise(resolve => input.signal.addEventListener('abort', () => { active.delete(input.subscriptionId); resolve({ state: 'stopped' }); }, { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async () => [] }, {}, { enabled: true, gateway, router: {},
        rolloutMode: 'public', assertAllowed: () => {}, pageSize: 100,
        listCandidates: async cursor => candidates.filter(row => row.id > cursor).slice(0, 100),
        listActiveSessions: async ids => candidates.filter(row => ids.includes(row.id)) });
    try {
        for (let i = 0; i < 11; i++) await runtime.tick();
        assert.equal(runtime.status().sessions, 1000);
        assert.equal(active.size, 1000);
        assert.deepEqual([...pids], [process.pid]);
    } finally { await runtime.stop(); }
    assert.equal(active.size, 0);
});
test('periodic inbox scans bound concurrent work while retaining all sessions', async () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1).padStart(6, '0'), owner_user_id: '222222222222222222', revision: 1 }));
    let running = 0, peak = 0, scanned = 0;
    const gateway = { store: { assertLease: async () => {} }, run: input => {
        queueMicrotask(() => input.onSession({ lease: { subscriptionId: input.subscriptionId, ownerUserId: input.ownerUserId, revision: 1 } }));
        return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ state: 'stopped' }), { once: true }));
    } };
    const router = { hasRealtimeTargets: async () => { running++; peak = Math.max(peak, running); await new Promise(resolve => setImmediate(resolve)); running--; scanned++; return false; },
        hasBatchTargets: async () => false };
    const runtime = createXPushRuntime({ queryDatabase: async () => [] }, {}, { enabled: true, gateway, router,
        rolloutMode: 'public', assertAllowed: () => {}, pageSize: 100, drainConcurrency: 7,
        listCandidates: async cursor => cursor ? [] : candidates,
        listActiveSessions: async ids => candidates.filter(row => ids.includes(row.id)) });
    try {
        await runtime.tick(); scanned = 0; peak = 0; await runtime.tick();
        assert.equal(runtime.status().sessions, 100);
        assert.equal(scanned, 100);
        assert(peak <= 7);
    } finally { await runtime.stop(); }
});
test('a user-confirmed receiver refresh reconnects only that subscription without a second process', async () => {
    const candidates = [
        { id: 'a', owner_user_id: '222222222222222222', revision: 1, updated_at_ms: 100 },
        { id: 'b', owner_user_id: '333333333333333333', revision: 1, updated_at_ms: 100 },
    ];
    const starts = [], stops = [];
    const gateway = { store: {}, run: input => {
        starts.push({ id: input.subscriptionId, pid: process.pid });
        return new Promise(resolve => input.signal.addEventListener('abort', () => { stops.push(input.subscriptionId); resolve({ state: 'stopped' }); }, { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async () => [] }, {}, { enabled: true, gateway, router: {},
        rolloutMode: 'public', assertAllowed: () => {}, listCandidates: async cursor => cursor ? [] : candidates,
        listActiveSessions: async ids => candidates.filter(row => ids.includes(row.id)) });
    try {
        await runtime.tick(); assert.deepEqual(starts.map(x => x.id), ['a', 'b']);
        candidates[0].updated_at_ms = 101;
        await runtime.tick();
        assert.deepEqual(stops, ['a']); assert.deepEqual(starts.map(x => x.id), ['a', 'b', 'a']);
        assert(starts.every(x => x.pid === process.pid)); assert.equal(runtime.status().sessions, 2);
        await runtime.tick(); assert.equal(starts.length, 3);
    } finally { await runtime.stop(); }
});
test('receiver refresh is prioritized even when the normal candidate page is elsewhere', async () => {
    const candidates = ['a', 'b', 'c'].map(id => ({ id, owner_user_id: '222222222222222222', revision: 1, updated_at_ms: 100 }));
    const starts = [], stops = [];
    const gateway = { store: {}, run: input => {
        starts.push(input.subscriptionId);
        return new Promise(resolve => input.signal.addEventListener('abort', () => { stops.push(input.subscriptionId); resolve({ state: 'stopped' }); }, { once: true }));
    } };
    const runtime = createXPushRuntime({ queryDatabase: async () => [] }, {}, { enabled: true, gateway, router: {}, pageSize: 1, maxConnections: 3,
        rolloutMode: 'public', assertAllowed: () => {}, listCandidates: async cursor => candidates.filter(row => row.id > cursor).slice(0, 1),
        listActiveSessions: async ids => candidates.filter(row => ids.includes(row.id)) });
    try {
        for (let i = 0; i < 3; i++) await runtime.tick();
        assert.deepEqual(starts, ['a', 'b', 'c']);
        candidates[1].updated_at_ms++;
        await runtime.tick();
        assert.deepEqual(stops, ['b']); assert.deepEqual(starts, ['a', 'b', 'c', 'b']);
        assert.equal(runtime.status().sessions, 3);
    } finally { await runtime.stop(); }
});
