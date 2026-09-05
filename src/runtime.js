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

function assertSupportedRuntime(versions = process.versions) {
    if (versions?.bun) {
        throw new Error(BUN_RUNTIME_DISABLED_MESSAGE);
    }
    if (!versions?.node || !isVersionAtLeast(versions.node, MINIMUM_NODE_VERSION)) {
        throw new Error(
            'Unsupported Node.js version: ' + (versions?.node || 'unknown') + '. '
            + 'Node.js ' + MINIMUM_NODE_VERSION + ' or newer is required.'
        );
    }
    return 'node';
}

module.exports = {
    BUN_RUNTIME_DISABLED_MESSAGE,
    MINIMUM_NODE_VERSION,
    assertSupportedRuntime,
};
