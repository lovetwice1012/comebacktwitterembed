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
