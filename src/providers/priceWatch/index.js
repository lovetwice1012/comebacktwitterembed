'use strict';

const fs = require('fs');
const path = require('path');
const fetchDefault = require('../../providerFetch').withDeadline(require('node-fetch'));

function discover() {
    const out = {};
    const providersDir = path.resolve(__dirname, '..');
    for (const entry of fs.readdirSync(providersDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_') || ['autoWatch', 'priceWatch'].includes(entry.name)) continue;
        const filename = path.join(providersDir, entry.name, 'priceWatch.js');
        if (!fs.existsSync(filename)) continue;
        const adapter = require(filename);
        if (!adapter || adapter.id !== entry.name || typeof adapter.normalizeSource !== 'function' || typeof adapter.fetch !== 'function' || typeof adapter.formatPrice !== 'function') {
            throw new Error(`Invalid price-watch adapter: ${filename}`);
        }
        out[adapter.id] = Object.freeze(adapter);
    }
    return Object.freeze(out);
}

const PROVIDERS = discover();

function provider(providerId) {
    const adapter = PROVIDERS[String(providerId || '').toLowerCase()];
    if (!adapter) throw Object.assign(new Error(`Unsupported price-watch provider: ${providerId}.`), { code: 'PRICE_WATCH_UNSUPPORTED_PROVIDER' });
    return adapter;
}

function normalizeSource(providerId, input) {
    return provider(providerId).normalizeSource(input);
}

async function fetchPrice(source, context) {
    return await provider(source.provider_id).fetch(source, { ...context, fetch: context?.fetch || fetchDefault });
}

function nextIntervalMs(providerId) {
    return provider(providerId).defaultPollMs;
}

module.exports = {
    PROVIDERS,
    fetchPrice,
    nextIntervalMs,
    normalizeSource,
    provider,
    _internal: { discover },
};
