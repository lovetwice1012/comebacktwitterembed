'use strict';

// Candidate-only bundle entry. The ordinary experimental entry retains its
// environment gate. This entry is selected only by the release builder; it
// does not turn on server intake or publish a package.
const { main } = require('./brave-mac-app-core.cjs');
main().catch(() => { process.exitCode = 1; });
