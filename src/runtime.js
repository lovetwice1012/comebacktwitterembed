'use strict';

const MINIMUM_NODE_VERSION = '22.12.0';
const BUN_RUNTIME_DISABLED_MESSAGE =
    'Bun is disabled for this production process after repeated native SIGABRT crashes. '
    + 'Start the application with Node.js ' + MINIMUM_NODE_VERSION + ' or newer.';

function isVersionAtLeast(version, minimum) {
    const actual = String(version || '').split('.').map(part => Number.parseInt(part, 10) || 0);
    const required = minimum.split('.').map(part => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < required.length; index++) {
        if ((actual[index] || 0) > required[index]) return true;
        if ((actual[index] || 0) < required[index]) return false;
    }
    return true;
}

function assertSupportedRuntime(versions = process.versions, platform = process.platform) {
    if (versions?.bun) {
        throw new Error(BUN_RUNTIME_DISABLED_MESSAGE);
    }
    if (!versions?.node || !isVersionAtLeast(versions.node, MINIMUM_NODE_VERSION)) {
        throw new Error(
            'Unsupported Node.js version: ' + (versions?.node || 'unknown') + '. '
            + 'Node.js ' + MINIMUM_NODE_VERSION + ' or newer is required.'
        );
    }
    // The Windows 24.0–24.15 libuv TCP path contains an uninitialized
    // OSVERSIONINFOW size and can terminate the process natively. A JS retry or
    // exception handler cannot repair it. Keep the existing Linux contract;
    // Windows maintainers use the verified project runtime instead.
    const [major, minor] = versions.node.split('.').map(Number);
    if (platform === 'win32' && major === 24 && minor < 16) {
        throw new Error('This Windows Node.js version has a native TCP startup crash: ' + versions.node
            + '. Run scripts/setup-project-node.ps1, then use node scripts/run-project-node.cjs <script>. '
            + 'The project pins Node.js 24.21.0; do not retry on the affected runtime.');
    }
    return 'node';
}

module.exports = {
    BUN_RUNTIME_DISABLED_MESSAGE,
    MINIMUM_NODE_VERSION,
    assertSupportedRuntime,
};
