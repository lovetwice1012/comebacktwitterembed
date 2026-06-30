'use strict';

const express = require('express');
const store = require('../youtubeDownloadStore');
const niconicoStore = require('../niconicoDownloadStore');

const PORT = 30987;

let server = null;

function start(port = PORT) {
    if (server) return server;

    const app = express();
    app.get('/', (_req, res) => {
        res.type('text/plain').send('Media download cache is running.');
    });
    app.get(`${store.ROUTE_PREFIX}/:token/:filename`, (req, res) => {
        store.handleDownloadRequest(req, res).catch(err => {
            console.warn('[youtubeDownloadServer] request failed:', err?.message || err);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        });
    });
    app.get(`${niconicoStore.ROUTE_PREFIX}/:token/:filename`, (req, res) => {
        niconicoStore.handleDownloadRequest(req, res).catch(err => {
            console.warn('[youtubeDownloadServer] niconico request failed:', err?.message || err);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        });
    });
    app.use((_req, res) => res.status(404).send('Not Found'));

    store.startCleanupTimer();
    niconicoStore.startCleanupTimer();
    server = app.listen(port, () => {
        console.log(`[youtubeDownloadServer] listening on http://127.0.0.1:${port}`);
        console.log(`[youtubeDownloadServer] public base: ${store.getPublicBaseUrl()}`);
        console.log(`[youtubeDownloadServer] niconico public base: ${niconicoStore.getPublicBaseUrl()}`);
    });
    return server;
}

function stop() {
    store.stopCleanupTimer();
    niconicoStore.stopCleanupTimer();
    if (!server) return;
    server.close();
    server = null;
}

module.exports = {
    PORT,
    start,
    stop,
};
