'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSuppressedTakeover } = require('../../experiments/chrome-push/edge-fixture-assertions.cjs');

test('suppressed takeover requires worker delivery without browser delivery or worker failure', () => {
    const success = { workerReceivedAfterReopen: true, browserReceivedAfterReopen: false, workerStoppedDuringReopen: false };
    assert.doesNotThrow(() => assertSuppressedTakeover(success));
    for (const [field, value] of Object.entries(success)) {
        assert.throws(() => assertSuppressedTakeover({ ...success, [field]: !value }), /PROBE_WNS_TAKEOVER_FAILED/);
        const missing = { ...success };
        delete missing[field];
        assert.throws(() => assertSuppressedTakeover(missing), /PROBE_WNS_TAKEOVER_FAILED/);
    }
});
