'use strict';

const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');
const { getAttachmentItems, isSpoiler, preserveAttachment } = require('./_attachmentPreservation');
const {
    getImageExtensionFromContentType,
    getImageExtensionFromUrl,
    resolveImageExtension,
} = require('./showMediaAsAttachments')._internal;

const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
const IMAGES_PER_GROUP = 4;
const MAX_FILES_PER_MESSAGE = 10;

function getExtensionFromName(name) {
    if (typeof name !== 'string') return null;
    const ext = name.split('.').pop()?.toLowerCase();
    if (!ext || ext === name.toLowerCase()) return null;
    return ext === 'jpeg' ? 'jpg' : ext;
}

function getExtensionFromUrlPath(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    const ext = u.pathname.split('.').pop()?.toLowerCase();
    if (!ext || ext === u.pathname.toLowerCase()) return null;
    return ext === 'jpeg' ? 'jpg' : ext;
}

function getAttachmentExtension(attachment) {
    const fromContentType = getImageExtensionFromContentType(attachment.contentType);
    if (fromContentType) return fromContentType;
    return getExtensionFromName(attachment.name)
        || getImageExtensionFromUrl(attachment.url)
        || getExtensionFromUrlPath(attachment.url);
}

function isNonImageMediaAttachment(attachment) {
    const contentType = String(attachment.contentType || '').toLowerCase();
    if (contentType.startsWith('image/')) return !getImageExtensionFromContentType(contentType);
    if (contentType && !contentType.startsWith('application/octet-stream')) return true;

    const extension = getAttachmentExtension(attachment);
    return !imageExtensions.includes(extension);
}

async function buildEmbedImageAttachment(attachment, index) {
    const knownExtension = getAttachmentExtension(attachment);
    const extension = imageExtensions.includes(knownExtension)
        ? knownExtension
        : await resolveImageExtension(attachment.url);
    const name = `embed-image-${index}.${extension}`;
    return {
        file: { attachment: attachment.url, name },
        embedUrl: `attachment://${name}`,
    };
}

function embedGroupUrl(baseUrl, index) {
    if (!baseUrl) return undefined;
    const groupIndex = Math.floor(index / IMAGES_PER_GROUP);
    if (groupIndex === 0) return baseUrl;
    try {
        const url = new URL(baseUrl);
        url.hash = `g${groupIndex}`;
        return url.toString();
    } catch {
        return `${baseUrl}#g${groupIndex}`;
    }
}

async function handle(interaction, { buttons }) {
    const { showMediaAsAttachmentsButton, translateButton, deleteButton } = buttons;

    if (interaction.message.attachments === undefined || interaction.message.attachments === null) {
        return interaction.editReply('There are no attachments to show.');
    }
    const attachments = getAttachmentItems(interaction.message.attachments);
    const imageAttachments = [];
    const otherAttachments = [];
    attachments.forEach(attachment => {
        if (isNonImageMediaAttachment(attachment)) otherAttachments.push(attachment);
        else imageAttachments.push(attachment);
    });

    if (!imageAttachments.length) throw new Error('GRID_NO_DISPLAYABLE_IMAGES');
    if (imageAttachments.some(isSpoiler)) throw new Error('GRID_SPOILER_DISPLAY_UNAVAILABLE');
    if (imageAttachments.some(attachment => !attachment.url)) throw new Error('GRID_SOURCE_INCOMPLETE');

    const maxImageEmbeds = Math.max(0, MAX_FILES_PER_MESSAGE - otherAttachments.length);
    if (imageAttachments.length > maxImageEmbeds) {
        return interaction.editReply(`You can't show more than ${maxImageEmbeds} image attachments as embeds image while keeping non-image attachments.`);
    }

    const messageObject = {
        components: [
            { type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] },
        ],
        embeds: [],
        files: [],
    };
    const retained = [];
    for (const attachment of otherAttachments) preserveAttachment(attachment, retained, messageObject.files);
    if (retained.length) messageObject.attachments = retained;
    messageObject.components.push({
        type: ComponentType.ActionRow,
        components: interaction.message.embeds[0]?.title ? [translateButton, deleteButton] : [deleteButton],
    });
    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = await checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId, providerId);

    const sourceEmbed = interaction.message.embeds[0];
    const baseUrl = sourceEmbed?.url;
    for (let index = 0; index < imageAttachments.length; index++) {
        const element = await buildEmbedImageAttachment(imageAttachments[index], index + 1);
        messageObject.files.push(element.file);
        if (messageObject.embeds.length === 0) {
            const src = sourceEmbed;
            const embed = {
                url: embedGroupUrl(baseUrl, index),
                description: src?.description,
                color: src?.color,
                author: src?.author,
                timestamp: src?.timestamp,
                image: { url: element.embedUrl },
            };
            if (src?.title !== undefined) embed.title = src.title;
            if (src?.footer !== undefined) embed.footer = src.footer;
            if (src?.fields !== undefined) embed.fields = src.fields;
            if (src?.thumbnail !== undefined) embed.thumbnail = src.thumbnail;
            messageObject.embeds.push(embed);
            continue;
        }
        messageObject.embeds.push({
            url: embedGroupUrl(baseUrl, index),
            color: sourceEmbed?.color,
            image: { url: element.embedUrl },
        });
    }

    // Keep quoted posts and other textual embeds when switching display modes.
    for (const source of interaction.message.embeds.slice(1)) {
        const copy = JSON.parse(JSON.stringify(source));
        if (copy.title || copy.description || copy.fields?.length || copy.author?.name || copy.footer?.text || copy.thumbnail?.url || copy.image?.url || copy.video?.url)
            messageObject.embeds.push(copy);
    }
    if (messageObject.embeds.length > 10) throw new Error('GRID_SOURCE_INCOMPLETE');

    if (messageObject.embeds.length === 0 && interaction.message.embeds[0]) {
        messageObject.embeds.push(JSON.parse(JSON.stringify(interaction.message.embeds[0])));
    }

    await interaction.message.edit(messageObject);
    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
}

module.exports = { handle };
module.exports._internal = {
    embedGroupUrl,
    getAttachmentItems,
    isNonImageMediaAttachment,
    buildEmbedImageAttachment,
};
