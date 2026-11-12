'use strict';
const STAGES = new Set(['SETUP', 'CALIBRATION', 'STORE', 'BASELINE', 'CONNECT', 'SUPPRESSED_OPEN', 'SEND', 'RECEIVE', 'DECRYPT', 'OBSERVE']);
function fixtureFailure(stage) { return new Error(`FIXTURE_SUPPRESSION_${STAGES.has(stage) ? stage : 'UNKNOWN'}_FAILED`); }
async function safeFixtureSend(send) {
    try { await send(); } catch { throw fixtureFailure('SEND'); }
}
module.exports = { fixtureFailure, safeFixtureSend };
