'use strict';
const { scheduleDelivery } = require('./schedule');
class DeliveryGateError extends Error {
    constructor(state, code, dueAtMs = null) { super(code); this.name = 'DeliveryGateError'; this.state = state; this.code = code; this.dueAtMs = dueAtMs; this.beforeSubmission = true; }
}
function assertWindowOpen(job, now = Date.now()) {
    const deadline = job.deadline_ms ?? job.plan.deadlineMs ?? Infinity;
    const allowed = scheduleDelivery(now, job.plan.schedules || [], Number(deadline));
    if (allowed === null || allowed > now) throw new DeliveryGateError(allowed === null ? 'expired' : 'pending', 'WINDOW_CLOSED_BEFORE_SUBMISSION', allowed);
}
module.exports = { DeliveryGateError, assertWindowOpen };
