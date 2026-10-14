'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectXProcessingSettings, createXProcessingSettings } = require('../../src/automation/x-processing-settings');
const plan = changes => ({ planId: 'ConfiguredPlan', label: '任意の名前', tier: 'paid', intervalMinutes: 30,
    priority: 17, slotLimit: 9, minuteLimit: 3, dayLimit: 12, ...changes });

function queryFor({ requestedMode = 'batch', realtimeEnabled = 0, enabled = 1 } = {}) {
    return async sql => {
        if (sql.startsWith('SELECT x_notification_processing_mode')) return [{ x_notification_processing_mode: requestedMode }];
        if (sql.startsWith('SELECT c.realtime_enabled')) return [{ realtime_enabled: realtimeEnabled, enabled }];
        assert.fail('unexpected settings query');
    };
}

test('owner defaults to the existing plan batch interval even when realtime is available', async () => {
    const result = await inspectXProcessingSettings(queryFor({ realtimeEnabled: 1 }), '1', 1000, { plan: plan() });
    assert.equal(result.requestedMode, 'batch'); assert.equal(result.effectiveMode, 'batch');
    assert.equal(result.intervalMinutes, 30); assert.equal(result.realtimeAllowed, true); assert.equal(result.configured, true);
});

test('realtime is a persisted owner choice plus an explicit current paid-plan flag, independent of names and pools', async () => {
    for (const label of ['Basic+', '任意', 'Free', '最優先']) {
        const configured = await inspectXProcessingSettings(queryFor({ requestedMode: 'realtime', realtimeEnabled: 1 }), '1', 1000, { plan: plan({ label, intervalMinutes: null }) });
        assert.equal(configured.effectiveMode, 'realtime'); assert.equal(configured.configured, true);
        const denied = await inspectXProcessingSettings(queryFor({ requestedMode: 'realtime' }), '1', 1000, { plan: plan({ label }) });
        assert.equal(denied.effectiveMode, 'batch'); assert.equal(denied.requestedMode, 'realtime'); assert.equal(denied.reasonCode, 'X_REALTIME_PLAN_REQUIRED');
    }
});

test('free contracts, disabled plans and invalid flags fall back to batching without losing the owner preference', async () => {
    for (const value of [{ tier: 'free', enabled: 1, flag: 1 }, { tier: 'paid', enabled: 0, flag: 1 }, { tier: 'paid', enabled: 1, flag: 2 }]) {
        const result = await inspectXProcessingSettings(queryFor({ requestedMode: 'realtime', realtimeEnabled: value.flag, enabled: value.enabled }), '1', 1000, { plan: plan({ tier: value.tier }) });
        assert.equal(result.realtimeAllowed, false); assert.equal(result.effectiveMode, 'batch'); assert.equal(result.requestedMode, 'realtime');
    }
});

test('a missing batch interval remains pending while explicit realtime needs no interval', async () => {
    const ordinary = await inspectXProcessingSettings(queryFor({ realtimeEnabled: 1 }), '1', 1000, { plan: plan({ intervalMinutes: null }) });
    assert.equal(ordinary.configured, false); assert.equal(ordinary.reasonCode, 'X_MONITOR_NOT_CONFIGURED');
    const immediate = await inspectXProcessingSettings(queryFor({ requestedMode: 'realtime', realtimeEnabled: 1 }), '1', 1000, { plan: plan({ intervalMinutes: null }) });
    assert.equal(immediate.configured, true); assert.equal(immediate.effectiveMode, 'realtime'); assert.equal(immediate.intervalMinutes, null);
});

test('invalid settings and client-supplied eligibility or owner fields are rejected before any I/O', async () => {
    const noIo = new Proxy({}, { get: () => assert.fail('invalid request must perform zero I/O') });
    const settings = createXProcessingSettings(noIo);
    for (const input of [null, [], {}, { mode: 'instant', expectedMode: 'batch' }, { mode: 'batch', expectedMode: 'instant' },
        { mode: 'realtime', expectedMode: 'batch', realtimeAllowed: true }, { mode: 'batch', expectedMode: 'batch', userId: '2' }])
        await assert.rejects(settings.save({ userId: '1' }, input), { code: 'X_PROCESSING_INVALID_INPUT', status: 422 });
    await assert.rejects(settings.save({}, { mode: 'batch', expectedMode: 'batch' }), { code: 'AUTH_REQUIRED' });
});
