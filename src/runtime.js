'use strict';

const MINIMUM_NODE_VERSION = '22.12.0';
const SUPPORTED_BUN_VERSION = '1.3.14';

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
        if (String(versions.bun) !== SUPPORTED_BUN_VERSION) {
            throw new Error(
                'Unsupported Bun version: ' + versions.bun + '. '
                + 'This deployment is tested and pinned to Bun ' + SUPPORTED_BUN_VERSION + '.'
            );
        }
        return 'bun';
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
    MINIMUM_NODE_VERSION,
    SUPPORTED_BUN_VERSION,
    assertSupportedRuntime,
};
