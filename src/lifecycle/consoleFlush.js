'use strict';

// Periodically flushes captured stdout/stderr with bounded, sequential sends.

const { consoleBuffer } = require('../state');

const FLUSH_INTERVAL_MS = 10000;
const FAILURE_WARNING_INTERVAL_MS = 60000;
const MAX_CHUNKS_PER_FLUSH = 3;
const CODE_FENCE = String.fromCharCode(96).repeat(3);

let flushTimer = null;
let activeFlush = null;
let lastFailureWarningAt = 0;

async function flush(client, webhookClient) {
    if (!webhookClient || consoleBuffer.text === '') return [];

    const allChunks = consoleBuffer.text.match(/[\s\S]{1,1900}/g) || [];
    const chunks = allChunks.slice(0, MAX_CHUNKS_PER_FLUSH);
    consoleBuffer.text = allChunks.slice(MAX_CHUNKS_PER_FLUSH).join('');
    const results = [];

    for (let index = 0; index < chunks.length; index++) {
        try {
            const value = await webhookClient.sendSlackMessage({
                text: CODE_FENCE + chunks[index] + CODE_FENCE,
                username: '[console]' + client.user.tag + '(' + (index + 1) + '/' + chunks.length + ')',
                icon_url: client.user.displayAvatarURL(),
            });
            results.push({ status: 'fulfilled', value });
        } catch (reason) {
            results.push({ status: 'rejected', reason });
            // Preserve the failed chunk and every chunk not attempted yet. New
            // output written while the request was pending stays at the end.
            consoleBuffer.text = chunks.slice(index).join('') + consoleBuffer.text;
            const now = Date.now();
            if (now - lastFailureWarningAt >= FAILURE_WARNING_INTERVAL_MS) {
                lastFailureWarningAt = now;
                console.warn(
                    '[consoleFlush] Failed to forward console chunk '
                    + (index + 1) + '/' + chunks.length + ':',
                    reason?.message || reason
                );
            }
            break;
        }
    }
    return results;
}

function runScheduledFlush(client, webhookClient) {
    if (activeFlush) return activeFlush;
    activeFlush = flush(client, webhookClient)
        .catch(err => {
            console.warn('[consoleFlush] Flush failed:', err?.message || err);
        })
        .finally(() => {
            activeFlush = null;
        });
    return activeFlush;
}

function start(client, webhookClient) {
    if (!webhookClient) return null;
    if (flushTimer !== null) return flushTimer;

    flushTimer = setInterval(() => void runScheduledFlush(client, webhookClient), FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
    return flushTimer;
}

function stop() {
    if (flushTimer === null) return;
    clearInterval(flushTimer);
    flushTimer = null;
    lastFailureWarningAt = 0;
}

module.exports = {
    flush,
    start,
    stop,
    _internal: {
        MAX_CHUNKS_PER_FLUSH,
        runScheduledFlush,
    },
};
