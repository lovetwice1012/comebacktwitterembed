'use strict';
// Sealed synthetic read models for local visual QA only. No key, ciphertext,
// production account ID, payment client or network implementation is present.
const quality = { planId: 'basic', priority: 2, minuteLimit: 7, dayLimit: 48, intervalMinutes: 5 };
const rollout = { mode: 'supporters', eligible: true, reasonCode: null, reason: null };
const timing = (cost = 5, source = 'slots', mode = 'batch') => ({ requestedMode: mode, explicitMode: mode, modeSource: 'monitor', effectiveMode: mode,
    realtimeSource: mode === 'realtime' ? source : null, realtimeEligibilitySource: source, slotCost: mode === 'realtime' ? cost : 1,
    effectiveSlotCost: mode === 'realtime' ? cost : 1, realtimeSlotCost: cost, canEnableRealtime: true, additionalSlotsNeeded: cost === 5 ? 4 : 0,
    configured: true, intervalMinutes: 5, reasonCode: null });
const plans = [
    { planId: 'light', label: 'ライト', slotLimit: 8, minuteLimit: 5, dayLimit: 48, priority: 1, variationId: 'fixture-light', catalogName: '検証用ライト', cadence: 'MONTHLY', amount: 500, currency: 'JPY' },
    { planId: 'basic', label: 'ベーシック', slotLimit: 16, minuteLimit: 7, dayLimit: 96, priority: 2, variationId: 'fixture-basic', catalogName: '検証用ベーシック', cadence: 'MONTHLY', amount: 1000, currency: 'JPY' },
    { planId: 'basic', label: 'ベーシック', slotLimit: 16, minuteLimit: 7, dayLimit: 96, priority: 2, variationId: 'fixture-basic-year', catalogName: '検証用ベーシック年額', cadence: 'ANNUAL', amount: 10000, currency: 'JPY' },
];
const subscription = () => ({ id: 'cc2cb493-a60d-41d6-936f-2ed33d7ea2c7', state: 'stored', revision: 1, createdAtMs: 1791972000000, updatedAtMs: 1791972000000,
    browserVersion: '158.0', receiverState: 'listening', boundMonitorCount: 1, lastReceivedAtMs: 1791972300000,
    receiptCounts: { received: 0, routed: 2, unsupported: 0, decryptionFailed: 0, unmatched: 0 } });
module.exports = function createPreview(options = {}) {
    const states = new Map();
    function state(scenario) {
        if (!states.has(scenario)) states.set(scenario, { subscriptions: scenario === 'fresh' ? [] : [subscription()], monitors: scenario === 'fresh' || scenario === 'unbound' ? [] : [{
            id: 'fixture-monitor-1', accountId: null, accountHandle: 'sample_artist', name: 'イラストのお知らせ', enabled: true, state: 'ready', poolKind: 'free',
            notificationSettings: { subscriptionId: 'cc2cb493-a60d-41d6-936f-2ed33d7ea2c7', ...(options.destinationId ? { destinationId: options.destinationId } : {}) }, subscriptionState: 'bound', revision: 1, quality,
            processing: scenario === 'rt-plan' ? timing(1, 'plan') : timing(),
        }, {
            id: 'fixture-monitor-2', accountId: null, accountHandle: 'sample_news', name: 'ニュースのお知らせ', enabled: true, state: 'ready', poolKind: 'supporter',
            notificationSettings: { subscriptionId: 'cc2cb493-a60d-41d6-936f-2ed33d7ea2c7', ...(options.destinationId ? { destinationId: options.destinationId } : {}) }, subscriptionState: 'bound', revision: 1, quality,
            processing: timing(1, 'supporter', 'realtime'),
        }], processing: 'batch', subscriptionPending: scenario === 'pending' });
        const current = states.get(scenario);
        if (current.subscriptions[0]) { current.subscriptions[0].boundMonitorCount = current.monitors.filter(row => row.notificationSettings.subscriptionId).length;
            if (scenario === 'unbound' && current.monitors.length === 0) { current.subscriptions[0].receiverState = 'awaiting'; current.subscriptions[0].lastReceivedAtMs = null; } }
        return current;
    }
    return { dispatch: async ({ route, method, body, scenario }) => {
        const s = state(scenario), full = scenario === 'full', used = full ? 19 : 3 + s.monitors.reduce((sum, row) => sum + row.processing.slotCost, 0), available = Math.max(0, 19 - used);
        if (route === 'x-monitor-quota') return { featureEnabled: true, currentPlan: { ...quality, label: 'ベーシック', tier: 'paid', baseSlotLimit: 16 }, personal: { totalLimit: 19, registeredCount: full ? 19 : 1 + s.monitors.length, used, available, supporterExtraSlots: 3 },
            x: { used: s.monitors.length, available, specialLimit: 4, specialUsed: 0, reasonCode: full ? 'X_MONITOR_PERSONAL_LIMIT' : null }, pools: { free: { limit: 50, used: 34, available: 16 }, supporter: { limit: 100, used: 23, available: 77 } },
            registrationProcessing: { ...timing(scenario === 'rt-plan' ? 1 : 5, scenario === 'rt-plan' ? 'plan' : 'slots', 'realtime'), canEnableRealtime: available >= (scenario === 'rt-plan' ? 1 : 5), isPreview: true } };
        if (route === 'entitlements') return { plan: { id: 'basic', name: 'ベーシック', baseSlotLimit: 16, slotLimit: 19, minuteLimit: 7, dayLimit: 96, priority: 2 }, slots: { used, max: 19, available }, usage: { entries: [{ targetKind: 'auto', targetId: '1', todayUsed: 2, todayReserved: 0, dayLimit: 96, minuteLimit: 7 }] } };
        if (route === 'x-setup') return { available: true, receiverEnabled: true, rollout, subscriptions: s.subscriptions, maxFileBytes: 32768, nextCursor: null,
            download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) } };
        if (route === 'x-processing-settings') { if (method === 'PUT') s.processing = body.mode; return { requestedMode: s.processing, effectiveMode: s.processing, realtimeAllowed: scenario === 'rt-plan', planId: 'basic', planLabel: 'ベーシック', intervalMinutes: 5, configured: true, reasonCode: null, rollout }; }
        if (route === 'x-monitors') { if (method === 'POST') s.monitors.push({ id: `fixture-monitor-${s.monitors.length + 1}`, accountId: null, accountHandle: body.accountHandle, name: body.name || body.accountHandle, enabled: true, state: 'ready', poolKind: 'free', notificationSettings: body.notificationSettings || {}, subscriptionState: body.notificationSettings?.subscriptionId ? 'bound' : 'pending', revision: 1, quality,
            processing: timing(scenario === 'rt-plan' ? 1 : 5, scenario === 'rt-plan' ? 'plan' : 'slots', body.processingMode || 'batch') }); return method === 'POST' ? s.monitors.at(-1) : { items: s.monitors }; }
        if (route.startsWith('x-monitors/')) { const id = route.split('/')[1], row = s.monitors.find(item => item.id === id); if (!row) throw Object.assign(new Error('検証用の監視が見つかりません。'), { status: 404 }); if (method === 'DELETE') { s.monitors = s.monitors.filter(item => item.id !== id); return { released: true, id }; }
            for (const key of ['name','enabled','accountHandle','notificationSettings','poolKind']) if (body[key] !== undefined) row[key] = body[key];
            if (body.processingMode) row.processing = timing(row.processing.realtimeSlotCost, row.processing.realtimeEligibilitySource, body.processingMode);
            row.revision++; return row; }
        if (route === 'billing/options') return { configured: true, environment: 'sandbox', applicationId: 'fixture-app', locationId: 'fixture-location', plans };
        if (route === 'billing/status') return { configured: true, environment: 'sandbox', subscription: null, pending: s.subscriptionPending ? { checkoutId: 'fixture-checkout', state: 'CARD_STORED', retryable: false, resumeAllowed: true, abortAllowed: true, quote: { checkoutId: 'fixture-checkout', expiresAtMs: Date.now() + 600000, plan: plans[1], email: 'fixture@example.test', name: '検証アカウント' } } : null, refresh: { state: 'checked', retryAtMs: Date.now() } };
        if (route === 'billing/quote') return { checkoutId: 'fixture-quote', expiresAtMs: Date.now() + 600000, plan: plans.find(item => item.variationId === body.variationId), name: body.name, email: body.email };
        if (route.startsWith('billing/') && ['subscribe','resume','abort','cancel'].includes(route.split('/')[1])) { s.subscriptionPending = false; return { configured: true, environment: 'sandbox', subscription: null, pending: null, refresh: { state: 'checked', retryAtMs: Date.now() } }; }
        if (route === 'billing/donations/options') return { configured: true, enabled: true, environment: 'sandbox', applicationId: 'fixture-app', locationId: 'fixture-location', currency: 'JPY', minorUnitDigits: 0, minimumAmount: 500, maximumAmount: 20000, supporterThreshold: 1500, validityDays: 30, updatedAtMs: 10, slotGrantPolicy: { currency: 'JPY', unitAmount: 500, slotsPerUnit: 1, permanent: true } };
        if (route === 'billing/donations/status') return { history: [{ attemptId: 'fixture-donation', state: 'COMPLETED', verified: true, amount: 1500, currency: 'JPY', refundedAmount: 0, netAmount: 1500, createdAtMs: 1791831600000, completedAtMs: 1791831600100 }], pending: null, permanentSupport: { totalSupporterSlots: 3, legacySlots: 1, newPaidSlots: 2, isSupporter: true }, supporter: { active: true, manualActive: false, threshold: 1500, validityDays: 30, netAmount: 1500, validUntilAtMs: 1794423600000 }, refresh: { state: 'checked', retryAtMs: Date.now() } };
        if (route === 'billing/donations/quote') return { attemptId: 'fixture-quote', expiresAtMs: Date.now() + 600000, amount: body.amount, currency: 'JPY', minorUnitDigits: 0, name: body.name, email: body.email };
        if (route.startsWith('billing/')) throw Object.assign(new Error('この操作は模擬画面では実行しません。'), { status: 400 });
        if (route.startsWith('x-')) throw Object.assign(new Error('この操作は模擬画面では実行しません。'), { status: 400 });
        return undefined;
    } };
};
