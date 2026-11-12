'use strict';
// Only selected by the unpublished candidate builder; no upload is performed.
const { main } = require('./edge-mac-app-core.cjs');
main().catch(() => { process.exitCode = 1; });
