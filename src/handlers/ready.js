'use strict';

const { buildSlashCommands } = require('../commands');
const presence = require('../lifecycle/presence');
const deregisterNotifier = require('../lifecycle/deregisterNotifier');
const statsPoster = require('../lifecycle/statsPoster');
const consoleFlush = require('../lifecycle/consoleFlush');
const boothSaleNotifier = require('../lifecycle/boothSaleNotifier');
const errorRateNotifier = require('../lifecycle/errorRateNotifier');
const mediaDeliveryServer = require('../lifecycle/mediaDeliveryServer');
const { recordError } = require('../errorTracking');

function register(client, webhookClient, errorNotificationWebhookClient = webhookClient) {
    client.on('ready', async () => {
        console.log(`${client.user.tag} is ready!`);

        try {
            await client.application.commands.set(buildSlashCommands());
        } catch (err) {
            recordError(err, { errorType: 'slash_command_registration_failed', source: 'ready.registerCommands' });
            console.error('Failed to register slash commands:', err);
        }

        presence.start(client);
        deregisterNotifier.start(client);
        statsPoster.start(client);
        consoleFlush.start(client, webhookClient);
        boothSaleNotifier.start(client);
        errorRateNotifier.start(errorNotificationWebhookClient);
        mediaDeliveryServer.start();
    });
}

module.exports = { register };
