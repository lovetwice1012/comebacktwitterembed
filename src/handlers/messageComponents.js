'use strict';

const { Events, InteractionType } = require('discord.js');
const { buildButtons } = require('../components/_buttons');
const { isAllowed } = require('../components/_permissionCheck');
const guisetting = require('../commands/handlers/guisetting');
const { isUnknownInteractionError } = require('../utils');

const HANDLERS = {
    showMediaAsAttachments: require('../components/showMediaAsAttachments'),
    showAttachmentsAsEmbedsImage: require('../components/showAttachmentsAsEmbedsImage'),
    delete: require('../components/delete'),
    translate: require('../components/translate'),
    savetweet: require('../components/savetweet'),
    notifyBoothSale: require('../components/notifyBoothSale'),
};

async function deferComponentReply(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        return true;
    } catch (err) {
        if (isUnknownInteractionError(err)) {
            console.warn(`[components] Ignoring expired interaction ${interaction.id ?? ''}`);
            return false;
        }
        throw err;
    }
}

async function replyComponentError(interaction, err) {
    if (isUnknownInteractionError(err)) {
        console.warn(`[components] Ignoring expired interaction ${interaction.id ?? ''}`);
        return;
    }

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
                await guisetting.handleModalSubmit(interaction);
                return;
            }

            if (interaction.type !== InteractionType.MessageComponent) return;
            if (baseCustomId === 'guisetting') {
                await guisetting.handleComponent(interaction);
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
        } catch (err) {
            await replyComponentError(interaction, err);
        }
    });
}

module.exports = { register };
