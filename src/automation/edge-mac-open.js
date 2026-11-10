'use strict';

// Experimental startup for a dedicated, stopped Edge profile. The profile
// lease spans inspection and browser launch, so another setup operation cannot
// change the profile in between. Actual Mac WNS behavior is not yet verified.
const fs = require('node:fs/promises');
const path = require('node:path');
const { ClassicLevel } = require('classic-level');
const { acquireMacProfileLease, releaseMacProfileLease } = require('./chrome-mac-profile-lease');
const { withMacEdgeSnapshot } = require('./chrome-mac-snapshot');
const { inspectEdgeSnapshot } = require('./edge-wns-snapshot-io');
const { startMacEdgeBroker } = require('./edge-mac-broker');
const fail = code => Object.assign(new Error(code), { code });

async function openMacEdgeForSetup({ rootPath, profileId, helperPath, expectedSha256 }) {
    const lease = await acquireMacProfileLease({ rootPath, profileId, browser: 'edge' });
    let handedOff = false;
    try {
        const profilePath = path.join(rootPath, 'edge-profile'), contents = await fs.readdir(profilePath);
        let suppressReceive = false;
        if (contents.length) {
            // A nonempty profile must have an inspectable store. Missing or
            // malformed storage is not proof that there is no subscription.
            const inspected = await withMacEdgeSnapshot({ rootPath, profileId, helperPath, expectedSha256, profileLease: lease,
                work: snapshot => inspectEdgeSnapshot({ ...snapshot, dbFactory: directory =>
                    new ClassicLevel(directory, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' }) }) });
            if (!inspected || typeof inspected.hasXSubscription !== 'boolean') throw fail('X_EDGE_MAC_INSPECTION_INVALID');
            suppressReceive = inspected.hasXSubscription;
        }
        try {
            const broker = await startMacEdgeBroker({ rootPath, profileId, suppressReceive, profileLease: lease });
            handedOff = true;
            return broker;
        } catch (error) {
            if (error?.code === 'X_EDGE_MAC_BROKER_CLEANUP_PENDING') handedOff = true;
            throw error;
        }
    } finally {
        if (!handedOff) await releaseMacProfileLease(lease);
    }
}
module.exports = { openMacEdgeForSetup };
