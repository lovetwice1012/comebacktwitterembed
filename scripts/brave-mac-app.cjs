'use strict';

// Experimental entry remains unavailable unless explicitly requested.
const { main: runLocalSetup } = require('./brave-mac-app-core.cjs');
async function main() {
    if (process.env.CBTE_EXPERIMENTAL_BRAVE_MAC_LOCAL !== '1') throw new Error('X_BRAVE_MAC_APP_UNAVAILABLE');
    return runLocalSetup();
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
