'use strict';

const { Events, InteractionType } = require('discord.js');

const HANDLERS = {
    "ping": require('../commands/handlers/ping').execute,
    "help": require('../commands/handlers/help').execute,
    "invite": require('../commands/handlers/invite').execute,
    "support": require('../commands/handlers/support').execute,
    "settings": require('../commands/handlers/settings').execute,
    "showsavetweet": require('../commands/handlers/showsavetweet').execute,
    "deletesavetweet": require('../commands/handlers/deletesavetweet').execute,
    "savetweetquotaoverride": require('../commands/handlers/savetweetquotaoverride').execute,
    "quotastats": require('../commands/handlers/quotastats').execute,
    "checkmyguildsettings": require('../commands/handlers/checkmyguildsettings').execute,
    "autoextract": require('../commands/handlers/autoextract').execute,
};

function register(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.type !== InteractionType.ApplicationCommand) return;
        const handler = HANDLERS[interaction.commandName];
        if (!handler) return;
        await handler(interaction, client);
    });
}

module.exports = { register };
