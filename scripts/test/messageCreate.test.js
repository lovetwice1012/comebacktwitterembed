'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Events } = require('discord.js');

const messageCreateModulePath = require.resolve('../../src/handlers/messageCreate');
const utilsModulePath = require.resolve('../../src/utils');
const loaderModulePath = require.resolve('../../src/providers/_loader');
const providerSettingsModulePath = require.resolve('../../src/providers/_provider_settings');
const dispatcherModulePath = require.resolve('../../src/providers/_dispatcher');
const errorTrackingModulePath = require.resolve('../../src/errorTracking');
const realUtils = require('../../src/utils');

async function withMessageCreateMocks(mocks, callback) {
    const modulePaths = [
        messageCreateModulePath,
        utilsModulePath,
        loaderModulePath,
        providerSettingsModulePath,
        dispatcherModulePath,
        errorTrackingModulePath,
    ];
    const originals = new Map(modulePaths.map(modulePath => [modulePath, require.cache[modulePath]]));

    require.cache[utilsModulePath] = {
        id: utilsModulePath,
        filename: utilsModulePath,
        loaded: true,
        exports: mocks.utils,
    };
    require.cache[loaderModulePath] = {
        id: loaderModulePath,
        filename: loaderModulePath,
        loaded: true,
        exports: mocks.loader,
    };
    require.cache[providerSettingsModulePath] = {
        id: providerSettingsModulePath,
        filename: providerSettingsModulePath,
        loaded: true,
        exports: mocks.providerSettings,
    };
    require.cache[dispatcherModulePath] = {
        id: dispatcherModulePath,
        filename: dispatcherModulePath,
        loaded: true,
        exports: mocks.dispatcher,
    };
    require.cache[errorTrackingModulePath] = {
        id: errorTrackingModulePath,
        filename: errorTrackingModulePath,
        loaded: true,
        exports: mocks.errorTracking,
    };
    delete require.cache[messageCreateModulePath];

    try {
        return await callback(require(messageCreateModulePath));
    } finally {
        delete require.cache[messageCreateModulePath];
        for (const [modulePath, original] of originals) {
            if (original) require.cache[modulePath] = original;
            else delete require.cache[modulePath];
        }
    }
}

function createClient() {
    const listeners = [];
    return {
        client: {
            user: { id: 'bot-user' },
            on: (event, listener) => {
                if (event === Events.MessageCreate) listeners.push(listener);
            },
        },
        listeners,
    };
}

test('messageCreate fetches uncached guild member before role disable check', async () => {
    const disabledRoleId = 'role-disabled';
    const provider = {
        id: 'twitter',
        extract: async () => {
            assert.fail('provider.extract should not run for a role-disabled member');
        },
    };
    const fetchCalls = [];
    const sendCalls = [];

    await withMessageCreateMocks({
        utils: {
            ifUserHasRole: realUtils.ifUserHasRole,
            cleanMessageContent: content => content,
        },
        loader: {
            extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }],
        },
        providerSettings: {
            getProviderSettings: async () => ({
                enabled: true,
                disable: { user: [], channel: [], role: [disabledRoleId] },
            }),
        },
        dispatcher: {
            runSendSteps: async (...args) => {
                sendCalls.push(args);
            },
        },
        errorTracking: {
            recordAnalyticsEvent: () => {},
            recordError: () => {},
            recordMetric: () => {},
            recordProviderContentEvent: () => {},
        },
    }, async ({ register }) => {
        const { client, listeners } = createClient();
        register(client);

        const message = {
            guild: {
                id: 'guild-1',
                members: {
                    fetch: async (userId) => {
                        fetchCalls.push(userId);
                        return { roles: { cache: new Map([[disabledRoleId, { id: disabledRoleId }]]) } };
                    },
                },
            },
            guildId: 'guild-1',
            channel: { id: 'channel-1' },
            channelId: 'channel-1',
            author: { id: 'user-1', bot: false },
            member: null,
            content: 'https://x.com/u/status/1',
        };

        for (const listener of listeners) {
            await listener(message);
        }
    });

    assert.deepEqual(fetchCalls, ['user-1']);
    assert.equal(sendCalls.length, 0);
});

