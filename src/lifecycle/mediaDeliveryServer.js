'use strict';

const express = require('express');
const youtubeStore = require('../youtubeDownloadStore');
const niconicoStore = require('../niconicoDownloadStore');

const PORT = 30987;

const MEDIA_STORES = {
    youtube: youtubeStore,
    niconico: niconicoStore,
};

let server = null;

function truthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function mediaDeliveryConfig() {
    try {
        const config = /** @type {any} */ (require('../../config.json'));
        return config.mediaDelivery || {};
    } catch {
        return {};
    }
}

function isDashboardIntegratedMode() {
    const config = mediaDeliveryConfig();
    const mode = String(process.env.MEDIA_DELIVERY_SERVER_MODE || config.serverMode || '').toLowerCase();
    if (mode === 'express') return false;
    if (mode === 'dashboard' || mode === 'next') return true;
    if (truthy(process.env.DASHBOARD_INTEGRATED_MEDIA_SERVER)) return true;
    if (config.serverMode === 'dashboard' || config.serverMode === 'next') return true;
    return Boolean(process.env.NEXTAUTH_URL || process.env.DASHBOARD_BASE_URL);
}

function mountStoreRoute(app, providerId, store) {
    const handler = (req, res) => {
        store.handleDownloadRequest(req, res).catch(err => {
            console.warn(`[mediaDeliveryServer] ${providerId} request failed:`, err?.message || err);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        });
    };

    app.get(`/media/${providerId}/:token/:filename`, handler);
    app.get(`${store.ROUTE_PREFIX}/:token/:filename`, handler);
}

function start(port = PORT) {
    if (server) return server;

    if (isDashboardIntegratedMode()) {
        youtubeStore.startCleanupTimer();
        niconicoStore.startCleanupTimer();
        console.log('[mediaDeliveryServer] using dashboard-integrated media routes; express listener is disabled.');
        return null;
    }

    const app = express();
    app.get('/', (_req, res) => {
        res.type('text/plain').send('Media delivery cache is running.');
    });

    for (const [providerId, store] of Object.entries(MEDIA_STORES)) {
        mountStoreRoute(app, providerId, store);
    }

    app.use((_req, res) => res.status(404).send('Not Found'));

    youtubeStore.startCleanupTimer();
    niconicoStore.startCleanupTimer();
    server = app.listen(port, () => {
        console.log(`[mediaDeliveryServer] listening on http://127.0.0.1:${port}`);
        for (const [providerId, store] of Object.entries(MEDIA_STORES)) {
            console.log(`[mediaDeliveryServer] ${providerId} public base: ${store.getPublicBaseUrl()}`);
            console.log(`[mediaDeliveryServer] ${providerId} routes: /media/${providerId} and ${store.ROUTE_PREFIX}`);
        }
    });
    return server;
}

function stop() {
    youtubeStore.stopCleanupTimer();
    niconicoStore.stopCleanupTimer();
    if (!server) return;
    server.close();
    server = null;
}

module.exports = {
    PORT,
    MEDIA_STORES,
    start,
    stop,
    _internal: {
        mountStoreRoute,
    },
};
