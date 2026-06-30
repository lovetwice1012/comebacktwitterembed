'use strict';

const { Events, InteractionType } = require('discord.js');
const { buildButtons } = require('../components/_buttons');
const { isAllowed } = require('../components/_permissionCheck');
const guisetting = require('../commands/handlers/guisetting');

const HANDLERS = {
    showMediaAsAttachments: require('../components/showMediaAsAttachments'),
    showAttachmentsAsEmbedsImage: require('../components/showAttachmentsAsEmbedsImage'),
    delete: require('../components/delete'),
    translate: require('../components/translate'),
    savetweet: require('../components/savetweet'),
    notifyBoothSale: require('../components/notifyBoothSale'),
};

function register(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
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

        await interaction.deferReply({ ephemeral: true });
        if (!(await isAllowed(interaction))) return;

        const handler = HANDLERS[baseCustomId];
        if (!handler) return;

        const ctx = { client, buttons: buildButtons(interaction) };
        await handler.handle(interaction, ctx);
    });
}

module.exports = { register };
