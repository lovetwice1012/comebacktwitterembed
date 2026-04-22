'use strict';

const { Events, InteractionType } = require('discord.js');
const { buildButtons } = require('../components/_buttons');
const { isAllowed } = require('../components/_permissionCheck');

const HANDLERS = {
    showMediaAsAttachments: require('../components/showMediaAsAttachments'),
    showAttachmentsAsEmbedsImage: require('../components/showAttachmentsAsEmbedsImage'),
    delete: require('../components/delete'),
    translate: require('../components/translate'),
    savetweet: require('../components/savetweet'),
};

function register(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.type !== InteractionType.MessageComponent) return;
        await interaction.deferReply({ ephemeral: true });
        if (!(await isAllowed(interaction))) return;

        const handler = HANDLERS[interaction.customId];
        if (!handler) return;

        const ctx = { client, buttons: buildButtons(interaction) };
        await handler.handle(interaction, ctx);
    });
}

module.exports = { register };