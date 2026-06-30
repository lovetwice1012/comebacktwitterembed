'use strict';

const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');
const { videoExtensions } = require('../utils');

const audioExtensions = ['mp3', 'm4a', 'ogg', 'wav', 'flac', 'aac'];

function getAttachmentUrls(attachments) {
    if (!attachments) return [];
    if (typeof attachments.map === 'function') return attachments.map(a => a.url).filter(Boolean);
    return Array.from(attachments).map(a => (Array.isArray(a) ? a[1]?.url : a?.url)).filter(Boolean);
}

function isNonImageMediaAttachment(url) {
    const cleanUrl = url.split(/[?#]/)[0];
    const extension = cleanUrl.split('.').pop()?.toLowerCase();
    return videoExtensions.includes(extension) || audioExtensions.includes(extension);
}

async function handle(interaction, { buttons }) {
    const { showMediaAsAttachmentsButton, translateButton, deleteButton } = buttons;

    if (interaction.message.attachments === undefined || interaction.message.attachments === null) {
        return interaction.editReply('There are no attachments to show.');
    }
    const attachments = getAttachmentUrls(interaction.message.attachments);
    const imageAttachments = [];
    const videoAttachments = [];
    attachments.forEach(url => {
        if (isNonImageMediaAttachment(url)) videoAttachments.push(url);
        else imageAttachments.push(url);
    });

    if (imageAttachments.length > 4) {
        return interaction.editReply("You can't show more than 4 attachments as embeds image.");
    }

    const messageObject = {
        components: [
            { type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] },
        ],
        embeds: [],
        files: videoAttachments,
    };
    messageObject.components.push({
        type: ComponentType.ActionRow,
        components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton],
    });
    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = await checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId, providerId);

    imageAttachments.forEach(element => {
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

    if (messageObject.embeds.length === 0 && interaction.message.embeds[0]) {
        messageObject.embeds.push(JSON.parse(JSON.stringify(interaction.message.embeds[0])));
    }

    await interaction.message.edit(messageObject);
    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply(); }, 3000);
}

module.exports = { handle };
