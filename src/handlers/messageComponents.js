'use strict';

const { Events, InteractionType } = require('discord.js');
const { buildButtons } = require('../components/_buttons');
const { isAllowed } = require('../components/_permissionCheck');
const guisetting = require('../commands/handlers/guisetting');
const { applyDelegatedEditPermissions } = require('../delegatedAccess');
const {
    isIgnorableInteractionAckError,
    isInteractionAlreadyAcknowledgedError,
    isUnknownMessageError,
} = require('../utils');
const {
    recordAnalyticsEvent = () => {},
    recordError,
    recordMetric,
    runWithErrorContext = (_context, fn) => fn(),
} = require('../errorTracking');

const HANDLERS = {
    showMediaAsAttachments: require('../components/showMediaAsAttachments'),
    showAttachmentsAsEmbedsImage: require('../components/showAttachmentsAsEmbedsImage'),
    delete: require('../components/delete'),
    translate: require('../components/translate'),
    savetweet: require('../components/savetweet'),
    notifyBoothSale: require('../components/notifyBoothSale'),
    downloadYouTubeVideo: require('../components/downloadYouTubeVideo'),
    downloadNiconicoVideo: require('../components/downloadNiconicoVideo'),
};

function ignoredInteractionErrorType(err) {
    if (isUnknownMessageError(err)) return 'discord_unknown_message';
    return isInteractionAlreadyAcknowledgedError(err)
        ? 'discord_interaction_already_acknowledged'
        : 'discord_unknown_interaction';
}

function ignoredInteractionWarning(err, interaction) {
    const interactionId = interaction.id ?? '';
    if (isUnknownMessageError(err)) {
        return `[components] Ignoring action for deleted message on interaction ${interactionId}`;
    }
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
    if (isIgnorableInteractionAckError(err) || isUnknownMessageError(err)) {
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

async function resolveGuisettingDelegatedEditPermissions(interaction) {
    try {
        return await applyDelegatedEditPermissions(interaction);
    } catch (error) {
        // Delegated access is optional; retain native Discord authorization if its lookup fails.
        recordError(error, {
            fallbackType: 'delegated_access_lookup_failed',
            source: 'messageComponents.delegatedAccess',
            interaction,
            componentId: 'guisetting',
        });
        console.error('Failed to resolve delegated access:', error);
        return () => {};
    }
}

async function withGuisettingDelegatedEditPermissions(interaction, callback) {
    const restore = await resolveGuisettingDelegatedEditPermissions(interaction);
    try {
        return await callback();
    } finally {
        restore();
    }
}

function register(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        const startedAt = Date.now();
        const baseCustomId = typeof interaction.customId === 'string' ? interaction.customId.split(':')[0] : interaction.customId;
        return runWithErrorContext({
            source: 'messageComponents.handle',
            interaction,
            componentId: baseCustomId,
        }, async () => {
        try {
            if (interaction.type === InteractionType.ModalSubmit && baseCustomId === 'guisetting') {
                recordMetric('modal_submit_attempt', { interaction, componentId: baseCustomId });
                await withGuisettingDelegatedEditPermissions(interaction, async () => {
                    await guisetting.handleModalSubmit(interaction);
                });
                recordMetric('modal_submit_success', { interaction, componentId: baseCustomId });
                recordAnalyticsEvent('modal_submit', {
                    source: 'messageComponents.modalSubmit',
                    interaction,
                    componentId: baseCustomId,
                    success: true,
                    durationMs: Date.now() - startedAt,
                });
                return;
            }

            if (interaction.type !== InteractionType.MessageComponent) return;
            recordMetric('component_attempt', { interaction, componentId: baseCustomId });
            if (baseCustomId === 'guisetting') {
                await withGuisettingDelegatedEditPermissions(interaction, async () => {
                    await guisetting.handleComponent(interaction);
                });
                recordMetric('component_success', { interaction, componentId: baseCustomId });
                recordAnalyticsEvent('component', {
                    source: 'messageComponents.guisetting',
                    interaction,
                    componentId: baseCustomId,
                    success: true,
                    durationMs: Date.now() - startedAt,
                });
                return;
            }

            if (!(await deferComponentReply(interaction))) {
                recordAnalyticsEvent('component', {
                    source: 'messageComponents.defer',
                    interaction,
                    componentId: baseCustomId,
                    success: false,
                    durationMs: Date.now() - startedAt,
                    details: { outcome: 'defer_failed' },
                });
                return;
            }
            if (!(await isAllowed(interaction))) {
                recordAnalyticsEvent('component', {
                    source: 'messageComponents.permission',
                    interaction,
                    componentId: baseCustomId,
                    success: false,
                    durationMs: Date.now() - startedAt,
                    details: { outcome: 'permission_denied' },
                });
                return;
            }

            const handler = HANDLERS[baseCustomId];
            if (!handler) {
                await interaction.deleteReply().catch(() => {});
                recordAnalyticsEvent('component', {
                    source: 'messageComponents.unknown',
                    interaction,
                    componentId: baseCustomId,
                    success: false,
                    durationMs: Date.now() - startedAt,
                    details: { outcome: 'unknown_component' },
                });
                return;
            }

            const ctx = { client, buttons: buildButtons(interaction) };
            await handler.handle(interaction, ctx);
            recordMetric('component_success', { interaction, componentId: baseCustomId });
            recordAnalyticsEvent('component', {
                source: 'messageComponents.handle',
                interaction,
                componentId: baseCustomId,
                success: true,
                durationMs: Date.now() - startedAt,
            });
        } catch (err) {
            const eventType = interaction.type === InteractionType.ModalSubmit ? 'modal_submit' : 'component';
            recordAnalyticsEvent(eventType, {
                source: 'messageComponents.handle',
                interaction,
                componentId: baseCustomId,
                success: false,
                durationMs: Date.now() - startedAt,
                details: { error_name: err?.name || null },
            });
            await replyComponentError(interaction, err);
        }
        });
    });
}

module.exports = {
    register,
    _internal: {
        resolveGuisettingDelegatedEditPermissions,
        withGuisettingDelegatedEditPermissions,
    },
};
