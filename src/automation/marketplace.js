'use strict';

// Keep the shared entry point stable while publication and install/update
// transactions remain independently testable.
module.exports = require('./marketplace-core');
