'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransport } = require('../../src/automation/transport');
const { DeliveryGateError } = require('../../src/automation/delivery-gate');
const { NODE_TYPES } = require('../../src/automation/schema');
const rateLimiter = { reserveNotifications: async (_principal, count) => ({ count, expiresAtMs: Number.MAX_SAFE_INTEGER }), beginNotification: async () => {}, commitNotification: async () => {}, releaseNotifications: async () => {}, retainUnknownNotification: async () => {} };
const entitlementResolver = async (_db, input) => ({ slotId: `${input.ownerUserId}:1`, slotIndex: 1, minuteLimit: 5, dayLimit: 24 });
test('slow mechanical checks cannot submit after quiet hours or expiry', async () => {
    let now = Date.parse('2026-09-22T08:59:59Z'), messages = 0;
    const owner = '222222222222222222', channel = '333333333333333333';
    const rest = { post: async route => { if (route === '/users/@me/channels') return { id: channel }; messages++; return { id: '444444444444444444', channel_id: channel }; } };
    const transport = createTransport({}, {}, { options: { jsonTransformer: value => value } }, { rest, rateLimiter, entitlementResolver, clock: () => now, safety: { assertNotification: async () => { now += 2000; } } });
    const job = { id: 'fixture', owner_user_id: owner, plan: { event: {}, context: {}, text: 'normal', display: { format: 'text', media: 'inherit' }, schedules: [{ ...NODE_TYPES.schedule.defaults, zone: 'UTC', windows: [{ start: '08:00', end: '09:00' }] }] } };
    const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
    await assert.rejects(transport.sendStep(prepared, job, 0), error => error instanceof DeliveryGateError && error.state === 'pending');
    job.deadline_ms = now - 1;
    const expiredPrepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
    await assert.rejects(transport.sendStep(expiredPrepared, job, 0), error => error instanceof DeliveryGateError && error.state === 'expired');
    assert.equal(messages, 0);
});
test('final lifecycle fence can cancel after inspection but before HTTP submission', async () => {
    let submitted = 0, fenced = 0;
    const owner = '222222222222222222', channel = '333333333333333333';
    const transport = createTransport({}, {}, { options: { jsonTransformer: value => value } }, {
        rateLimiter,
        entitlementResolver,
        rest: { post: async route => { if (route !== '/users/@me/channels') submitted++; return { id: channel }; } },
        beforeSubmit: async () => { fenced++; throw new DeliveryGateError('cancelled', 'MONITOR_CHANGED'); },
    });
    const job = { id: 'fixture', owner_user_id: owner, plan: { event: {}, context: {}, text: 'normal', display: { format: 'text', media: 'inherit' }, schedules: [] } };
    const prepared = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
    await assert.rejects(transport.sendStep(prepared, job, 0), { code: 'MONITOR_CHANGED' });
    assert.equal(fenced, 1); assert.equal(submitted, 0);
});
