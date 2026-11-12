'use strict';

// Selected only for the unpublished release candidate; the experimental
// entry retains its flag. This does not publish or upload anything.
const { main } = require('./firefox-mac-app-core.cjs');
main().catch(() => { process.exitCode = 1; });
