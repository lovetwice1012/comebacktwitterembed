'use strict';
const STAGES = new Set(['SETUP', 'CALIBRATION', 'STORE', 'BASELINE_OPEN', 'BASELINE_SEND', 'BASELINE_WAIT', 'BASELINE_STOP',
    'CONNECT', 'SUPPRESSED_OPEN', 'SEND', 'RECEIVE', 'DECRYPT', 'OBSERVE']);
const CATEGORIES = new Set(['HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_410', 'HTTP_413', 'HTTP_429', 'HTTP_500', 'HTTP_503']);
function fixtureFailure(stage) { return new Error(`FIXTURE_SUPPRESSION_${STAGES.has(stage) ? stage : 'UNKNOWN'}_FAILED`); }
function sendCategory(error) { try { const value = error?.category; return CATEGORIES.has(value) ? value : 'OTHER'; } catch { return 'OTHER'; } }
async function safeFixtureSend(send) {
    try { await send(); } catch (error) {
        let status; try { status = error?.statusCode; } catch { status = undefined; }
        const result = fixtureFailure('SEND');
        result.category = [400, 401, 403, 404, 410, 413, 429, 500, 503].includes(status) ? `HTTP_${status}` : 'OTHER';
        throw result;
    }
}
module.exports = { fixtureFailure, safeFixtureSend, sendCategory };
