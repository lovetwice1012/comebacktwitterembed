'use strict';

const { Events, InteractionType } = require('discord.js');
const { buildButtons } = require('../components/_buttons');
const { isAllowed } = require('../components/_permissionCheck');
const guisetting = require('../commands/handlers/guisetting');
const {
    isIgnorableInteractionAckError,
    isInteractionAlreadyAcknowledgedError,
} = require('../utils');
const { recordError, recordMetric } = require('../errorTracking');

const HANDLERS = {
    showMediaAsAttachments: require('../components/showMediaAsAttachments'),
    showAttachmentsAsEmbedsImage: require('../components/showAttachmentsAsEmbedsImage'),
    delete: require('../components/delete'),
    translate: require('../components/translate'),
    savetweet: require('../components/savetweet'),
    notifyBoothSale: require('../components/notifyBoothSale'),
    downloadYouTubeVideo: require('../components/downloadYouTubeVideo'),
};

function ignoredInteractionErrorType(err) {
    return isInteractionAlreadyAcknowledgedError(err)
        ? 'discord_interaction_already_acknowledged'
        : 'discord_unknown_interaction';
}

function ignoredInteractionWarning(err, interaction) {
    const interactionId = interaction.id ?? '';
    if (isInteractionAlreadyAcknowledgedError(err)) {
        return `[components] Ignoring already acknowledged interaction ${interactionId}`;
    }
    return `[components] Ignoring expired interaction ${interactionId}`;
}

function recordIgnoredInteraction(err, interaction, source) {
    recordError(err, {
        errorType: ignoredInteractionErrorType(err),
        severity: 'warn',
        source,
        interaction,
    });
    recordMetric('component_error', { interaction });
    console.warn(ignoredInteractionWarning(err, interaction));
}

async function deferComponentReply(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        return true;
    } catch (err) {
        if (isIgnorableInteractionAckError(err)) {
            recordIgnoredInteraction(err, interaction, 'messageComponents.defer');
            return false;
        }
        throw err;
    }
}

async function replyComponentError(interaction, err) {
    if (isIgnorableInteractionAckError(err)) {
        recordIgnoredInteraction(err, interaction, 'messageComponents.handle');
        return;
    }

    recordError(err, {
        errorType: 'component_failed',
        source: 'messageComponents.handle',
        interaction,
    });
    recordMetric('component_error', { interaction });
    console.error('Failed to handle component interaction:', err);
    const payload = { content: 'Action failed. Please check the bot logs.', ephemeral: true };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(async () => {
            await interaction.followUp(payload).catch(() => {});
        });
        return;
    }

    await interaction.reply(payload).catch(() => {});
}

function register(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            const baseCustomId = typeof interaction.customId === 'string' ? interaction.customId.split(':')[0] : interaction.customId;
            if (interaction.type === InteractionType.ModalSubmit && baseCustomId === 'guisetting') {
                recordMetric('modal_submit_attempt', { interaction, componentId: baseCustomId });
                await guisetting.handleModalSubmit(interaction);
                recordMetric('modal_submit_success', { interaction, componentId: baseCustomId });
                return;
            }

            if (interaction.type !== InteractionType.MessageComponent) return;
            recordMetric('component_attempt', { interaction, componentId: baseCustomId });
            if (baseCustomId === 'guisetting') {
                await guisetting.handleComponent(interaction);
                recordMetric('component_success', { interaction, componentId: baseCustomId });
                return;
            }

            if (!(await deferComponentReply(interaction))) return;
            if (!(await isAllowed(interaction))) return;

            const handler = HANDLERS[baseCustomId];
            if (!handler) {
                await interaction.deleteReply().catch(() => {});
                return;
            }

            const ctx = { client, buttons: buildButtons(interaction) };
            await handler.handle(interaction, ctx);
            recordMetric('component_success', { interaction, componentId: baseCustomId });
        } catch (err) {
            await replyComponentError(interaction, err);
        }
    });
}

module.exports = { register };
