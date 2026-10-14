'use strict';

// Approved standard: receive continuously, then process every retained event
// in the current plan's window. Unsupported modes cannot bypass that interval.
function resolveXProcessingPolicy(value) {
    return value === undefined || value === 'batch' ? 'batch' : null;
}

module.exports = { resolveXProcessingPolicy };
