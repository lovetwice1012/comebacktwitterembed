'use strict';

// Test-only classifier. It never returns a file name or file contents.
function classifyName(name, regular) {
    if (typeof name !== 'string' || regular !== true) return 'other';
    if (name === 'LOCK') return 'lock';
    if (name === 'CURRENT') return 'current';
    if (/^MANIFEST-[0-9]+$/.test(name)) return 'manifest';
    if (name === 'LOG' || name === 'LOG.old') return 'diagnosticLog';
    if (/^[0-9]+\.log$/.test(name)) return 'journal';
    if (/^[0-9]+\.(?:ldb|sst)$/.test(name)) return 'table';
    return 'other';
}
function plausibleHeader(kind, prefix, size) {
    if (!Buffer.isBuffer(prefix) || !Number.isSafeInteger(size) || size < 0 || prefix.length > size) return 'unavailable';
    if (size === 0) return 'empty';
    if (kind === 'current') return size <= 128 && prefix.length === size && /^MANIFEST-[0-9]+\n$/.test(prefix.toString('latin1')) ? 'plausible' : 'unrecognized';
    if (kind === 'diagnosticLog') return /^\d{4}\/\d{2}\/\d{2}-\d{2}:\d{2}:\d{2}\.\d{6}[ \t]/.test(prefix.toString('latin1')) ? 'plausible' : 'unrecognized';
    if (kind === 'journal') {
        if (prefix.length < 7) return 'unrecognized';
        const length = prefix.readUInt16LE(4), type = prefix[6];
        return type >= 1 && type <= 4 && length > 0 && length <= size - 7 ? 'plausible' : 'unrecognized';
    }
    return 'unavailable';
}
module.exports = { classifyName, plausibleHeader };
