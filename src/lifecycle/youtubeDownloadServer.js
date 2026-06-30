'use strict';

const express = require('express');
const store = require('../youtubeDownloadStore');

const PORT = 30987;

let server = null;

function start(port = PORT) {
    if (server) return server;

    const app = express();
    app.get('/', (_req, res) => {
        res.type('text/plain').send('YouTube download cache is running.');
    });
    app.get(`${store.ROUTE_PREFIX}/:token/:filename`, (req, res) => {
        store.handleDownloadRequest(req, res).catch(err => {
            console.warn('[youtubeDownloadServer] request failed:', err?.message || err);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        });
    });
    app.use((_req, res) => res.status(404).send('Not Found'));

    store.startCleanupTimer();
    server = app.listen(port, () => {
        console.log(`[youtubeDownloadServer] listening on http://127.0.0.1:${port}`);
        console.log(`[youtubeDownloadServer] public base: ${store.getPublicBaseUrl()}`);
    });
    return server;
}

function stop() {
    store.stopCleanupTimer();
    if (!server) return;
    server.close();
    server = null;
}

module.exports = {
    PORT,
    start,
    stop,
};
