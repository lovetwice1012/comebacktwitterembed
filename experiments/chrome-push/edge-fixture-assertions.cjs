'use strict';

function assertSuppressedTakeover(result) {
    if (result?.workerReceivedAfterReopen !== true || result.browserReceivedAfterReopen !== false
        || result.workerStoppedDuringReopen !== false) throw new Error('PROBE_WNS_TAKEOVER_FAILED');
}

module.exports = { assertSuppressedTakeover };
