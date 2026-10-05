'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auto = require('../../src/providers/autoWatch/runner');
const price = require('../../src/providers/priceWatch/runner');
const recovery = require('../../src/recoveryBootstrap');

test('DM and webhook monitoring share the guarded durable runner with no direct-send fallback', async t => {
    t.mock.method(recovery, 'notificationAllowed', () => true);
    for (const runner of [auto, price]) for (const destination_type of ['dm', 'webhook']) {
        const delivery = { id: 'fixture', destination_type, created_at: new Date().toISOString() };
        let routes = 0, failures = 0;
        const store = { routeAutomation: async actual => { assert.equal(actual, delivery); routes++; return { state: 'routed' }; }, failDelivery: async () => { failures++; } };
        const context = { now: 1000, store, fetch: async () => assert.fail('Direct HTTP forbidden'), client: { users: { fetch: async () => assert.fail('Direct DM forbidden') } } };
        assert.equal((await runner._internal.deliverOne(delivery, context)).status, 'routed');
        assert.equal(routes, 1);
        delete store.routeAutomation;
        assert.equal((await runner._internal.deliverOne(delivery, context)).status, 'failed');
        assert.equal(failures, 1);
    }
});
