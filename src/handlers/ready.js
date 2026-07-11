'use strict';

const { Events } = require('discord.js');
const { buildSlashCommands } = require('../commands');
const deregisterNotifier = require('../lifecycle/deregisterNotifier');
const statsPoster = require('../lifecycle/statsPoster');
const consoleFlush = require('../lifecycle/consoleFlush');
const boothSaleNotifier = require('../lifecycle/boothSaleNotifier');
const errorRateNotifier = require('../lifecycle/errorRateNotifier');
const mediaDeliveryServer = require('../lifecycle/mediaDeliveryServer');
const { recordError } = require('../errorTracking');

async function initialize(readyClient, webhookClient, errorNotificationWebhookClient) {
    console.log(`${readyClient.user.tag} is ready!`);

    try {
        await readyClient.application.commands.set(buildSlashCommands());
    } catch (err) {
        recordError(err, { errorType: 'slash_command_registration_failed', source: 'ready.registerCommands' });
        console.error('Failed to register slash commands:', err);
    }

    deregisterNotifier.start(readyClient);
    statsPoster.start(readyClient);
    consoleFlush.start(readyClient, webhookClient);
    boothSaleNotifier.start(readyClient);
    errorRateNotifier.start(errorNotificationWebhookClient);
    mediaDeliveryServer.start();
}

function register(client, webhookClient, errorNotificationWebhookClient = webhookClient) {
    client.once(Events.ClientReady, readyClient => {
        initialize(readyClient, webhookClient, errorNotificationWebhookClient).catch(err => {
            recordError(err, { errorType: 'ready_initialization_failed', severity: 'fatal', source: 'ready.initialize' });
            console.error('Failed to initialize ready lifecycle:', err);
        });
    });
}

module.exports = { register, _internal: { initialize } };
