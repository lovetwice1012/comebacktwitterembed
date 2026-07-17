'use strict';

const { Events, InteractionType } = require('discord.js');
const { loadProviderCommands } = require('../providers/_loader');
const { applyDelegatedEditPermissions } = require('../delegatedAccess');
const {
    recordAnalyticsEvent = () => {},
    recordError,
    recordMetric,
    runWithErrorContext = (_context, fn) => fn(),
} = require('../errorTracking');

const CORE_HANDLERS = {
    "ping":                 require('../commands/handlers/ping').execute,
    "help":                 require('../commands/handlers/help').execute,
    "invite":               require('../commands/handlers/invite').execute,
    "support":              require('../commands/handlers/support').execute,
    "settings":             require('../commands/handlers/settings').execute,
    "guisetting":           require('../commands/handlers/guisetting').execute,
    "quotastats":           require('../commands/handlers/quotastats').execute,
    "checkmyguildsettings": require('../commands/handlers/checkmyguildsettings').execute,
    "autoextract":          require('../commands/handlers/autoextract').execute,
    "provider":             require('../commands/handlers/provider').execute,
};

async function resolveDelegatedEditPermissions(interaction) {
    try {
        return await applyDelegatedEditPermissions(interaction);
    } catch (error) {
        // Delegated access is optional; fail closed without blocking native Discord permissions.
        recordError(error, {
            fallbackType: 'delegated_access_lookup_failed',
            source: 'applicationCommands.delegatedAccess',
            interaction,
            commandName: interaction.commandName,
        });
        console.error('Failed to resolve delegated access:', error);
        return () => {};
    }
}

// provider が export する slash command を統合して dispatch table を構築する。
function buildHandlers() {
    const merged = { ...CORE_HANDLERS };
    for (const c of loadProviderCommands()) {
        merged[c.definition.name] = c.execute;
    }
    return merged;
}

function shouldDeferEphemeral(interaction) {
    if (interaction.commandName === 'guisetting') return true;
    if (interaction.commandName === 'provider') return true;
    if (interaction.commandName === 'autoextract') {
        return interaction.options.getSubcommand() === 'list';
    }
    if (interaction.commandName === 'showsavetweet') {
        return interaction.options.getString('id') !== null;
    }
    if (interaction.commandName === 'et') return true;
    return false;
}

async function replyCommandError(interaction, error) {
    recordError(error, {
        fallbackType: 'command_failed',
        source: 'applicationCommands.execute',
        interaction,
        commandName: interaction.commandName,
    });
    recordMetric('command_error', { interaction, commandName: interaction.commandName });
    console.error(`Failed to execute /${interaction.commandName}:`, error);
    const payload = {
        content: 'Command failed. Please check the bot logs.',
    };
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(async () => {
            await interaction.followUp(payload).catch(() => {});
        });
        return;
    }
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
}

function register(client) {
    const handlers = buildHandlers();
    client.on(Events.InteractionCreate, async (interaction) => runWithErrorContext({
        source: 'applicationCommands.execute',
        interaction,
        commandName: interaction.commandName,
    }, async () => {
        if (interaction.type !== InteractionType.ApplicationCommand) return;
        const handler = handlers[interaction.commandName];
        if (!handler) return;
        const startedAt = Date.now();
        recordMetric('command_attempt', { interaction, commandName: interaction.commandName });
        let restoreDelegatedPermissions = () => {};
        try {
            await interaction.deferReply({ ephemeral: shouldDeferEphemeral(interaction) });
            restoreDelegatedPermissions = await resolveDelegatedEditPermissions(interaction);
            await handler(interaction, client);
            recordMetric('command_success', { interaction, commandName: interaction.commandName });
            recordAnalyticsEvent('command', {
                source: 'applicationCommands.execute',
                interaction,
                commandName: interaction.commandName,
                success: true,
                durationMs: Date.now() - startedAt,
            });
        } catch (err) {
            recordAnalyticsEvent('command', {
                source: 'applicationCommands.execute',
                interaction,
                commandName: interaction.commandName,
                success: false,
                durationMs: Date.now() - startedAt,
                details: { error_name: err?.name || null },
            });
            await replyCommandError(interaction, err);
        } finally {
            restoreDelegatedPermissions();
        }
    }));
}

module.exports = {
    register,
    _internal: {
        shouldDeferEphemeral,
        resolveDelegatedEditPermissions,
    },
};
