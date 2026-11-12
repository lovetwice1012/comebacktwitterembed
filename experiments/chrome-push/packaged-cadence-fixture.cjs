'use strict';

// Test-only cadence setup; never move the live receiver lease clock forward.
async function makeBatchDue(db, subscriptionId, now) {
    if (!db || typeof db.queryDatabase !== 'function' || !/^cbte_automation_test_[0-9a-f]{20}$/.test(db.schema || '')
        || typeof subscriptionId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(subscriptionId)
        || !Number.isSafeInteger(now) || now < 301000) throw new Error('FIXTURE_CADENCE_INVALID');
    const result = await db.queryDatabase('UPDATE automation_x_push_receivers SET last_process_at_ms=? WHERE subscription_id=?', [now - 301000, subscriptionId]);
    if (Number(result.affectedRows) !== 1) throw new Error('FIXTURE_CADENCE_RECEIVER_MISSING');
    return now;
}
module.exports = { makeBatchDue };
