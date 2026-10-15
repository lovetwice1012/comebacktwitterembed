'use strict';

// A shared fetch is not proof that this target completed its first check.
// Keep the owner's raw plan separate from the shared acquisition constraint.
function targetTiming(row) {
    const targetNextCheckAtMs = Number(row.next_poll_at_ms || 0);
    const sourceNextCheckAtMs = Number(row.next_check_at_ms || 0);
    const hasTargetPlan = row.next_poll_at_ms !== null && row.next_poll_at_ms !== undefined;
    return {
        lastCheckedAtMs: Number(row.last_polled_at_ms || 0),
        nextCheckAtMs: hasTargetPlan ? Math.max(targetNextCheckAtMs, sourceNextCheckAtMs) : 0,
        targetNextCheckAtMs,
        sourceLastCheckedAtMs: Number(row.last_checked_at_ms || 0),
        sourceNextCheckAtMs,
    };
}

module.exports = { targetTiming };
