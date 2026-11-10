'use strict';
// Loopback-only wrapper. The production receipt adapter is exercised with
// disposable subscriptions; this wrapper cannot authorize a real site.
const { createEdgeWnsReceiver } = require('../../src/automation/edge-wns-receiver');
const fail = code => Object.assign(new Error(code), { code });
function createSyntheticDurableReceiver({ scope, store, lease, channel, authorize, sendAck, beforeAck = async () => {} }) {
    if (typeof scope !== 'string' || !/^http:\/\/(?:localhost|127\.0\.0\.1):[1-9][0-9]{0,4}\/$/.test(scope)
        || !store || typeof store.recordFrame !== 'function' || typeof store.assertLease !== 'function' || !lease || !Buffer.isBuffer(channel) || !channel.length
        || typeof authorize !== 'function' || typeof sendAck !== 'function' || typeof beforeAck !== 'function')
        throw fail('PROBE_DURABLE_CONFIG_INVALID');
    const instrumented = { ...store, async recordFrame(...args) { const saved = await store.recordFrame(...args); await beforeAck(saved); return saved; } };
    return createEdgeWnsReceiver({ store: instrumented, lease, channel, authorize, sendAck });
}
module.exports = { createSyntheticDurableReceiver };
