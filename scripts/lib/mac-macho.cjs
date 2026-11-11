'use strict';

// Bounded, read-only checks for the Mac binaries used by the preview builder.
// This does not validate a code signature or establish binary provenance.
const MAX_MINIMUM_VERSION = 0x000d0500; // macOS 13.5
const CPU = Object.freeze({ x64: 0x01000007, arm64: 0x0100000c });
function validSlice(bytes, arch, type) {
    if (!Object.hasOwn(CPU, arch) || !Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf
        || bytes.readUInt32LE(4) !== CPU[arch] || bytes.readUInt32LE(12) !== type) return false;
    const count = bytes.readUInt32LE(16), length = bytes.readUInt32LE(20), end = 32 + length;
    if (!count || count > 4096 || length > 4 * 1024 * 1024 || end > bytes.length) return false;
    let offset = 32, minVersion = null;
    for (let i = 0; i < count; i++) {
        if (offset + 8 > end) return false;
        const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
        if (size < 8 || offset + size > end) return false;
        if (command === 0x32) { // LC_BUILD_VERSION, platform 1 = macOS.
            if (size < 24 || bytes.readUInt32LE(offset + 8) !== 1 || minVersion !== null) return false;
            minVersion = bytes.readUInt32LE(offset + 12);
        } else if (command === 0x24) { // LC_VERSION_MIN_MACOSX.
            if (size < 16 || minVersion !== null) return false;
            minVersion = bytes.readUInt32LE(offset + 8);
        }
        offset += size;
    }
    return offset === end && minVersion !== null && minVersion > 0 && minVersion <= MAX_MINIMUM_VERSION;
}
function isMacExecutable(bytes, arch) { return validSlice(bytes, arch, 2); }
function isRestrictedMacExecutable(bytes, arch) {
    if (!isMacExecutable(bytes, arch)) return false;
    const count = bytes.readUInt32LE(16), end = 32 + bytes.readUInt32LE(20); let offset = 32, found = 0;
    const name = (start, expected) => {
        const field = bytes.subarray(start, start + 16), zero = field.indexOf(0), length = zero < 0 ? field.length : zero;
        return field.subarray(0, length).toString('ascii') === expected && (zero < 0 || field.subarray(zero).every(byte => byte === 0));
    };
    for (let i = 0; i < count; i++) {
        const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
        if (command === 0x19) { // LC_SEGMENT_64 and section_64 records.
            if (size < 72) return false;
            const sections = bytes.readUInt32LE(offset + 64);
            if (sections > 4096 || 72 + sections * 80 !== size) return false;
            for (let j = 0; j < sections; j++) {
                const section = offset + 72 + j * 80;
                if (name(offset + 8, '__RESTRICT') && name(section, '__restrict') && name(section + 16, '__RESTRICT')) {
                    const length = bytes.readBigUInt64LE(section + 40), location = bytes.readUInt32LE(section + 48);
                    if (length < 1n || length > 4096n || location < end || BigInt(location) + length > BigInt(bytes.length)) return false;
                    found++;
                }
            }
        }
        offset += size;
    }
    return found === 1;
}
function isUniversalMacAddon(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 48 || bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt32BE(4) !== 2) return false;
    const seen = new Set(), ranges = [];
    for (let i = 0; i < 2; i++) {
        const start = 8 + i * 20, cpu = bytes.readUInt32BE(start), offset = bytes.readUInt32BE(start + 8), size = bytes.readUInt32BE(start + 12);
        const arch = Object.keys(CPU).find(name => CPU[name] === cpu);
        if (!arch || seen.has(arch) || offset < 48 || size < 32 || offset + size > bytes.length
            || ranges.some(range => offset < range.end && offset + size > range.start)) return false;
        if (!validSlice(bytes.subarray(offset, offset + size), arch, 8)) return false;
        seen.add(arch); ranges.push({ start: offset, end: offset + size });
    }
    return seen.size === 2;
}
module.exports = { isMacExecutable, isRestrictedMacExecutable, isUniversalMacAddon, MAX_MINIMUM_VERSION };
