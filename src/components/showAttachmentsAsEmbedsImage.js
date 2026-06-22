'use strict';

const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');
const { videoExtensions } = require('../utils');

async function handle(interaction, { buttons }) {
    const { showMediaAsAttachmentsButton, translateButton, deleteButton } = buttons;

    if (interaction.message.attachments === undefined || interaction.message.attachments === null) {
        return interaction.reply('There are no attachments to show.');
    }
    const attachments = interaction.message.attachments.map(a => a.url);
    if (attachments.length > 4) {
        return interaction.reply("You can't show more than 4 attachments as embeds image.");
    }

    const messageObject = {
        components: [
            { type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] },
        ],
        embeds: [],
        files: [],
    };
    messageObject.components.push({
        type: ComponentType.ActionRow,
        components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton],
    });
    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId, providerId);

    attachments.forEach(element => {
        const extension = element.split('?').pop().split('.').pop();
        if (videoExtensions.includes(extension)) {
            messageObject.files.push(element);
            return;
        }
        if (messageObject.embeds.length === 0) {
            const src = interaction.message.embeds[0];
            const embed = {
                url: src.url,
                description: src.description,
                color: src.color,
                author: src.author,
                timestamp: src.timestamp,
                image: { url: element },
            };
            if (src.title !== undefined) embed.title = src.title;
            if (src.footer !== undefined) embed.footer = src.footer;
            if (src.fields !== undefined) embed.fields = src.fields;
            messageObject.embeds.push(embed);
            return;
        }
        messageObject.embeds.push({
            url: messageObject.embeds[0].url,
            image: { url: element },
        });
    });

    messageObject.files = [];
    await interaction.message.edit(messageObject);
    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply(); }, 3000);
}

module.exports = { handle };
