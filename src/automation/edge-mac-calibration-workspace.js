'use strict';

// A fresh, tool-owned profile is used only to learn this Edge installation's
// WNS handshake. It never opens the user's ordinary profile or X account.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseUniqueJson } = require('./strict-json');
const { verifyMacEdgeProfile } = require('./chrome-mac-profile');
const { runMacEdgeCalibrationWithEphemeralCertificate } = require('./edge-mac-calibration');
const fail = code => Object.assign(new Error(code), { code });

async function calibrateMacEdgeInOwnedWorkspace({ rootPath, profileId, identityPath, identitySha256, peerPath, peerSha256, signal }) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('X_EDGE_MAC_CALIBRATION_INVALID');
    if (signal?.aborted) throw fail('X_EDGE_MAC_CALIBRATION_CANCELLED');
    const profile = await verifyMacEdgeProfile(rootPath, profileId);
    const token = randomBytes(16).toString('hex');
    const directory = path.join(profile.rootPath, `edge-calibration-${token}`);
    let identity, created = false, started = false, cleanupConfirmed = false;
    try {
        await fs.mkdir(directory, { mode: 0o700 });
        created = true;
        identity = await fs.lstat(directory);
        if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid()
            || (identity.mode & 0o777) !== 0o700 || await fs.realpath(directory) !== directory)
            throw fail('X_EDGE_MAC_CALIBRATION_INVALID');
        await fs.mkdir(path.join(directory, 'profile'), { mode: 0o700 });
        const handle = await fs.open(path.join(directory, 'owner.json'), 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ appId: 'x-notification-setup', kind: 'edge-calibration-v1', token })); await handle.sync(); }
        finally { await handle.close(); }
        started = true;
        const result = await runMacEdgeCalibrationWithEphemeralCertificate({ rootPath: directory, token,
            identityPath, identitySha256, peerPath, peerSha256, signal, onCleanupConfirmed: () => { cleanupConfirmed = true; } });
        if (signal?.aborted) throw fail('X_EDGE_MAC_CALIBRATION_CANCELLED');
        if (!cleanupConfirmed) throw fail('X_EDGE_MAC_CALIBRATION_CLEANUP_PENDING');
        return result;
    } finally {
        // Before calibration starts no browser exists. Afterwards require an
        // explicit cleanup confirmation even when calibration failed or was
        // cancelled; on uncertainty retain the workspace for inspection.
        if (created && identity && (!started || cleanupConfirmed)) {
            try {
                const current = await fs.lstat(directory);
                if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid()
                    || current.dev !== identity.dev || current.ino !== identity.ino
                    || path.dirname(directory) !== profile.rootPath || path.basename(directory) !== `edge-calibration-${token}`
                    || await fs.realpath(directory) !== directory) throw new Error();
                const marker = await fs.open(path.join(directory, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const stat = await marker.stat();
                    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096) throw new Error();
                    const owner = parseUniqueJson(await marker.readFile('utf8'));
                    if (!owner || Object.keys(owner).sort().join(',') !== 'appId,kind,token'
                        || owner.appId !== 'x-notification-setup' || owner.kind !== 'edge-calibration-v1' || owner.token !== token) throw new Error();
                } finally { await marker.close(); }
                await fs.rm(directory, { recursive: true });
            } catch { throw fail('X_EDGE_MAC_CALIBRATION_CLEANUP_FAILED'); }
        } else if (created) {
            // eslint-disable-next-line no-unsafe-finally
            throw fail('X_EDGE_MAC_CALIBRATION_CLEANUP_PENDING');
        }
    }
}
module.exports = { calibrateMacEdgeInOwnedWorkspace };
