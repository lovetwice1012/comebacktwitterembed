'use strict';
const dns = require('node:dns');
const net = require('node:net');

function publicV4(address) {
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;
    return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
        && a !== 0 && a !== 10 && a !== 127 && a < 224
        && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
        && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
        && !(a === 192 && b === 0 && (c === 0 || c === 2))
        && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
        && !(a === 203 && b === 0 && c === 113);
}

function isPublicAddress(address) {
    if (net.isIP(address) === 4) return publicV4(address);
    if (net.isIP(address) !== 6 || address.includes('%')) return false;
    let normalized = address.toLowerCase();
    if (normalized.includes('.')) {
        const lastColon = normalized.lastIndexOf(':'), tail = normalized.slice(lastColon + 1);
        const values = tail.split('.').map(Number);
        normalized = normalized.slice(0, lastColon + 1) + ((values[0] << 8) | values[1]).toString(16)
            + ':' + ((values[2] << 8) | values[3]).toString(16);
    }
    const halves = normalized.split('::');
    const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(x => parseInt(x, 16))
        : left.map(x => parseInt(x, 16));
    if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) {
        return publicV4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    return words.length === 8 && (words[0] & 0xe000) === 0x2000 && !(words[0] === 0x2001 && words[1] === 0x0db8);
}

function lookup(hostname, options, callback) {
    const lookupOptions = /** @type {import('node:dns').LookupAllOptions} */ ({ ...options, all: true });
    dns.lookup(hostname, lookupOptions, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses?.length || addresses.some(entry => !isPublicAddress(entry.address))) {
            return callback(Object.assign(new Error('Provider DNS returned a non-public destination.'), { code: 'AUTO_WATCH_INVALID_REDIRECT' }));
        }
        // Return the validated addresses to the socket itself: no second DNS
        // resolution is allowed between validation and connection.
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
    });
}

module.exports = { lookup, isPublicAddress };
