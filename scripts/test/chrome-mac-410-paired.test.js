'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareFreshSubscriptions, deliveryObservation } = require('../native-test/chrome-mac-410-paired.cjs');

test('paired diagnostic compares a delayed first send without hiding initial 410', async () => {
    let now = 0, sends = 0; const reports = [], subscriptions = [];
    const result = await compareFreshSubscriptions({
        subscribe: async label => { subscriptions.push(label); return label; },
        send: async (_subscription, label) => { sends++; now += 40; if (label === 'immediate') throw { statusCode: 410, body: 'expired secret' }; },
        sleep: async ms => { now += ms; }, elapsedMs: () => now, report: event => reports.push(event),
    });
    assert.deepEqual(subscriptions, ['immediate', 'delayed']); assert.equal(sends, 3);
    assert.equal(result.firstResult, '410_EXPIRED'); assert.equal(result.secondResult, 'accepted');
    assert.equal(result.retryResult, 'accepted'); assert.equal(result.initialFailure, true);
    assert.equal(reports[1].sinceSubscriptionMs, 5000);
    assert.equal(JSON.stringify(reports).includes('secret'), false);
});
test('delivery diagnostics distinguish unaccepted and unattempted sends from observed delivery', () => {
    assert.equal(deliveryObservation('accepted', true), 'observed');
    assert.equal(deliveryObservation('accepted', false), 'not_observed');
    assert.equal(deliveryObservation('410_EXPIRED', true), 'not_accepted');
    assert.equal(deliveryObservation('not_attempted', false), 'not_attempted');
    assert.equal(deliveryObservation('secret', true), 'not_accepted');
});
test('successful immediate send is not repeated and invalid timers fail closed', async () => {
    let now = 0, sends = 0;
    const options = { subscribe: async label => label, send: async () => { sends++; }, sleep: async ms => { now += ms; },
        elapsedMs: () => now, report: () => {} };
    const result = await compareFreshSubscriptions(options);
    assert.equal(result.initialFailure, false); assert.equal(result.retryResult, 'not_attempted'); assert.equal(sends, 2);
    await assert.rejects(compareFreshSubscriptions({ ...options, delayMs: 10001 }), /FIXTURE_PAIR_CONFIG_INVALID/);
    await assert.rejects(compareFreshSubscriptions({ ...options, sleep: async () => {} }), /FIXTURE_PAIR_DELAY_INVALID/);
});
