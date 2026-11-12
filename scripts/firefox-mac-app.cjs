'use strict';

// The experimental entry remains gated even if called programmatically.
const { main: runLocalSetup } = require('./firefox-mac-app-core.cjs');
async function main() {
    if (process.env.CBTE_FIREFOX_MAC_EXPERIMENTAL !== '1') throw new Error('X_FIREFOX_MAC_APP_INVALID');
    return runLocalSetup();
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
