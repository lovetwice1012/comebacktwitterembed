'use strict';

// Global worker configuration stays batch-only: owner preference plus explicit
// current-plan permission controls realtime. An environment value cannot grant
// realtime access to every owner or bypass the normal startup feature gate.
function resolveXProcessingPolicy(value) {
    return value === undefined || value === 'batch' ? 'batch' : null;
}

module.exports = { resolveXProcessingPolicy };
