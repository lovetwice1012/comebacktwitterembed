'use strict';

// Populate only after the corresponding distribution has passed native Mac
// verification, Developer ID signing and notarization. Preview archives are
// deliberately excluded; runtime flags cannot turn an unpinned file into a release.
const RELEASES = Object.freeze({ arm64: null, x64: null });

function getChromeMacRelease(arch) {
    if (!Object.hasOwn(RELEASES, arch)) return null;
    const release = RELEASES[arch];
    if (!release || typeof release !== 'object' || Array.isArray(release)
        || Object.keys(release).sort().join(',') !== 'bytes,filename,sha256,version'
        || typeof release.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.version)
        || release.filename !== `chrome-mac-${arch}-${release.version}.zip`
        || typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.sha256)
        || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > 200 * 1024 * 1024) return null;
    return Object.freeze({ ...release });
}
module.exports = { getChromeMacRelease };
