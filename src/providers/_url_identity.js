'use strict';

// Compare identities without changing the original URL passed to a provider.
// Keep functional parameters (timestamps, language, image/variant selections).
function urlIdentity(providerId, value) {
    try {
        const url = new URL(value);
        for (const key of [...url.searchParams.keys()]) {
            if (/^utm_/i.test(key) || ['fbclid', 'igsh', 'igshid'].includes(key)) url.searchParams.delete(key);
        }
        if (providerId === 'twitter' && ['twitter.com', 'x.com'].includes(url.hostname)) {
            const status = /^\/[^/]+\/status\/(\d+)(\/.*)?$/.exec(url.pathname);
            if (status) {
                url.protocol = 'https:';
                url.hostname = 'x.com';
                url.pathname = `/i/status/${status[1]}${status[2] === '/' ? '' : status[2] || ''}`;
                for (const key of ['s', 't', 'ref_src', 'ref_url']) url.searchParams.delete(key);
            }
        }
        return `${providerId}\u0001${url.href}`;
    } catch {
        return `${providerId}\u0001${value}`;
    }
}

module.exports = { urlIdentity };
