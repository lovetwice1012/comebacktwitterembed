'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Events, InteractionType } = require('discord.js');

const handlerPath = require.resolve('../../src/handlers/messageComponents');
const deleteComponentPath = require.resolve('../../src/components/delete');
const errorTrackingPath = require.resolve('../../src/errorTracking');
const permissionCheckPath = require.resolve('../../src/components/_permissionCheck');
const buttonsPath = require.resolve('../../src/components/_buttons');

test('message component treats a deleted target message as a benign race', async () => {
    const originals = new Map([
        [handlerPath, require.cache[handlerPath]],
        [deleteComponentPath, require.cache[deleteComponentPath]],
        [errorTrackingPath, require.cache[errorTrackingPath]],
        [permissionCheckPath, require.cache[permissionCheckPath]],
        [buttonsPath, require.cache[buttonsPath]],
    ]);
    const recordedErrors = [];
    const metrics = [];

    require.cache[deleteComponentPath] = {
        id: deleteComponentPath,
        filename: deleteComponentPath,
        loaded: true,
        exports: { handle: async () => { throw { code: 10008, message: 'Unknown Message' }; } },
    };
    require.cache[errorTrackingPath] = {
        id: errorTrackingPath,
        filename: errorTrackingPath,
        loaded: true,
        exports: {
            recordAnalyticsEvent: () => {},
            recordError: (_error, context) => recordedErrors.push(context),
            recordMetric: metric => metrics.push(metric),
            runWithErrorContext: (_context, callback) => callback(),
        },
    };
    require.cache[permissionCheckPath] = {
        id: permissionCheckPath,
        filename: permissionCheckPath,
        loaded: true,
        exports: { isAllowed: async () => true },
    };
    require.cache[buttonsPath] = {
        id: buttonsPath,
        filename: buttonsPath,
        loaded: true,
        exports: { buildButtons: () => ({}) },
    };
    delete require.cache[handlerPath];

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const listeners = [];
        const { register } = require(handlerPath);
        register({
            on(event, listener) {
                if (event === Events.InteractionCreate) listeners.push(listener);
            },
        });

        let errorReplyAttempts = 0;
        const interaction = {
            id: 'interaction-1',
            type: InteractionType.MessageComponent,
            customId: 'delete:test',
            deferred: true,
            replied: false,
            deferReply: async () => {},
            editReply: async () => { errorReplyAttempts += 1; },
            followUp: async () => { errorReplyAttempts += 1; },
            reply: async () => { errorReplyAttempts += 1; },
        };

        assert.equal(listeners.length, 1);
        await listeners[0](interaction);

        assert.equal(errorReplyAttempts, 0);
        assert.equal(recordedErrors.at(-1).errorType, 'discord_unknown_message');
        assert.equal(recordedErrors.at(-1).severity, 'warn');
        assert.ok(metrics.includes('component_error'));
    } finally {
        console.warn = originalWarn;
        delete require.cache[handlerPath];
        for (const [modulePath, original] of originals) {
            if (original) require.cache[modulePath] = original;
            else delete require.cache[modulePath];
        }
    }
});
