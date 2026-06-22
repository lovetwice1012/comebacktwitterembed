'use strict';

const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');

async function handle(interaction, { buttons }) {
    const { showAttachmentsAsMediaButton, translateButton, deleteButton } = buttons;

    const messageObject = {
        components: [
            { type: ComponentType.ActionRow, components: [showAttachmentsAsMediaButton] },
        ],
        files: [],
        embeds: [],
    };
    messageObject.components.push({
        type: ComponentType.ActionRow,
        components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton],
    });

    interaction.message.embeds.forEach(element => {
        if (element.image) messageObject.files.push(element.image.url);
    });

    const deepCopyEmbed0 = JSON.parse(JSON.stringify(interaction.message.embeds[0]));
    delete deepCopyEmbed0.image;
    messageObject.embeds.push(deepCopyEmbed0);

    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId, providerId);
    await interaction.message.edit(messageObject);
    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply(); }, 3000);
}

module.exports = { handle };
