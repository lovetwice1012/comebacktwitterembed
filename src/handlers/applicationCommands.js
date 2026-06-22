'use strict';

const { Events, InteractionType } = require('discord.js');
const { loadProviderCommands } = require('../providers/_loader');

const CORE_HANDLERS = {
    "ping":                 require('../commands/handlers/ping').execute,
    "help":                 require('../commands/handlers/help').execute,
    "invite":               require('../commands/handlers/invite').execute,
    "support":              require('../commands/handlers/support').execute,
    "settings":             require('../commands/handlers/settings').execute,
    "quotastats":           require('../commands/handlers/quotastats').execute,
    "checkmyguildsettings": require('../commands/handlers/checkmyguildsettings').execute,
    "autoextract":          require('../commands/handlers/autoextract').execute,
    "provider":             require('../commands/handlers/provider').execute,
};

// provider が export する slash command を統合して dispatch table を構築する。
function buildHandlers() {
    const merged = { ...CORE_HANDLERS };
    for (const c of loadProviderCommands()) {
        merged[c.definition.name] = c.execute;
    }
    return merged;
}

function register(client) {
    const handlers = buildHandlers();
    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.type !== InteractionType.ApplicationCommand) return;
        const handler = handlers[interaction.commandName];
        if (!handler) return;
        await handler(interaction, client);
    });
}

module.exports = { register };
