'use strict';

const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');

function getAttachmentUrls(attachments) {
    if (!attachments) return [];
    if (typeof attachments.map === 'function') return attachments.map(a => a.url).filter(Boolean);
    return Array.from(attachments).map(a => (Array.isArray(a) ? a[1]?.url : a?.url)).filter(Boolean);
}

async function handle(interaction, { buttons }) {
    const { showAttachmentsAsMediaButton, translateButton, deleteButton } = buttons;

    const files = new Set(getAttachmentUrls(interaction.message.attachments));
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
        if (element.image) files.add(element.image.url);
    });
    messageObject.files = [...files];

    const deepCopyEmbed0 = JSON.parse(JSON.stringify(interaction.message.embeds[0]));
    delete deepCopyEmbed0.image;
    messageObject.embeds.push(deepCopyEmbed0);

    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = await checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId, providerId);
    await interaction.message.edit(messageObject);
    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply(); }, 3000);
}

module.exports = { handle };
