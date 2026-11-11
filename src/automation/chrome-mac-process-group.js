'use strict';

// Only called after the directly spawned, detached child has closed. A group
// check is additional evidence, not proof that no descendant escaped it.
async function waitForMacProcessGroupExit(pid, { timeoutMs = 8000, intervalMs = 100 } = {}) {
    if (!Number.isSafeInteger(pid) || pid < 2 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000
        || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) return false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { process.kill(-pid, 0); }
        catch (error) { if (error?.code === 'ESRCH') return true; return false; }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
    }
}
module.exports = { waitForMacProcessGroupExit };
