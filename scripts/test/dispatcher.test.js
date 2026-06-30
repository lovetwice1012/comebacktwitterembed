'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSendSteps } = require('../../src/providers/_dispatcher');
const { counters, loadCounters, _internal } = require('../../src/state');

test('dispatcher: increments processed counters for sent steps', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-dispatcher-'));
    const statsFile = path.join(tmpDir, 'stats.json');

    _internal.configureStatsPersistenceForTest(statsFile);
    loadCounters(new Date(), statsFile);

    const sentMessages = [];
    const message = {
        guildId: 'guild-1',
        channel: {
            send: async (payload) => {
                sentMessages.push(payload);
                return {
                    id: `sent-${sentMessages.length}`,
                    reply: async (replyPayload) => {
                        sentMessages.push(replyPayload);
                        return { id: `reply-${sentMessages.length}` };
                    },
                };
            },
        },
        reply: async (payload) => {
            sentMessages.push(payload);
            return {
                id: `reply-${sentMessages.length}`,
                reply: async (replyPayload) => {
                    sentMessages.push(replyPayload);
                    return { id: `reply-${sentMessages.length}` };
                },
            };
        },
        suppressEmbeds: async () => {},
        delete: async () => {},
    };

    try {
        await runSendSteps(message, [
            { embeds: [{ description: 'one' }] },
            { embeds: [{ description: 'two' }] },
        ], 'twitter');

        const saved = JSON.parse(fs.readFileSync(statsFile, 'utf8'));

        assert.equal(sentMessages.length, 2);
        assert.equal(counters.processed, 2);
        assert.equal(counters.processed_hour, 2);
        assert.equal(counters.processed_day, 2);
        assert.equal(saved.processed, 2);
        assert.equal(saved.processed_hour, 2);
        assert.equal(saved.processed_day, 2);
    } finally {
        _internal.configureStatsPersistenceForTest(_internal.DEFAULT_STATS_FILE);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('dispatcher: missing send permissions are non-fatal', async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => {
        warnings.push(message);
    };

    const message = {
        guildId: 'guild-1',
        channelId: 'channel-1',
        channel: {
            send: async () => {
                throw { code: 50013, rawError: { message: 'Missing Permissions' } };
            },
        },
        reply: async () => {
            throw { code: 50013, rawError: { message: 'Missing Permissions' } };
        },
        suppressEmbeds: async () => {},
        delete: async () => {},
    };

    try {
        await assert.doesNotReject(runSendSteps(message, [{ content: 'hello' }], 'twitter'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Missing Permissions/);
    } finally {
        console.warn = originalWarn;
    }
});
