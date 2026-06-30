'use strict';

const fetch = require('node-fetch');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');
const { getSetting } = require('../providers/_provider_settings');
const { normalizeEmbed } = require('../interactionResponse');

const TRANSLATE_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwmofa3n_K15ze_-4KrpH-B-eBHiKXmmgLeqsJInS3dJUDM0IJ-627h8Xu-w8PIc2f-ug/exec';

function getAttachmentUrls(attachments) {
    if (!attachments) return [];
    if (typeof attachments.map === 'function') return attachments.map(a => a.url).filter(Boolean);
    return Array.from(attachments).map(a => (Array.isArray(a) ? a[1]?.url : a?.url)).filter(Boolean);
}

async function handle(interaction) {
    const messageObject = { components: [], embeds: [] };

    const sourceEmbed = interaction.message.embeds[0];
    const copyEmbed = {
        title: sourceEmbed.title,
        url: sourceEmbed.url,
        color: sourceEmbed.color,
        author: sourceEmbed.author,
        footer: sourceEmbed.footer,
        timestamp: sourceEmbed.timestamp,
        fields: sourceEmbed.fields,
    };
    if (sourceEmbed.image) copyEmbed.image = sourceEmbed.image;
    if (sourceEmbed.thumbnail) copyEmbed.thumbnail = sourceEmbed.thumbnail;
    messageObject.embeds.push(copyEmbed);

    if (interaction.message.embeds.length > 1) {
        for (let i = 1; i < interaction.message.embeds.length; i++) {
            messageObject.embeds.push(interaction.message.embeds[i]);
        }
    }

    let target = interaction.locale;
    if (target.startsWith('en-')) target = 'en';
    if (target === 'jp') target = 'ja';

    const originalDescription = sourceEmbed.description || '';
    let translatable = originalDescription;
    let trailingTail = '';
    const looksTwitterLike = /twitter\.com|x\.com|vxtwitter\.com|fxtwitter\.com/.test(sourceEmbed.url || '');

    if (looksTwitterLike) {
        const lines = originalDescription.split('\n');
        if (lines.length > 4) {
            trailingTail = lines.slice(lines.length - 4).join('\n');
            translatable = lines.slice(0, lines.length - 4).join('\n');
        }
    }

    if (translatable.trim().length > 0) {
        const res = await fetch(`${TRANSLATE_ENDPOINT}?target=${target}&text=${encodeURIComponent(translatable)}`);
        const translated = await res.text();
        messageObject.embeds[0].description = trailingTail ? `${translated}\n${trailingTail}` : translated;
    }

    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = await checkComponentIncludesDisabledButtonAndIfFindDeleteIt(interaction.message.components || [], interaction.guildId, providerId);
    messageObject.embeds = messageObject.embeds.map(normalizeEmbed);
    await interaction.editReply(messageObject);

    const editOriginalIfTranslate = await getSetting({ id: providerId || 'twitter' }, 'editOriginalIfTranslate', interaction.guildId) === true;

    if (editOriginalIfTranslate) {
        const attachmentUrls = getAttachmentUrls(interaction.message.attachments);
        if (attachmentUrls.length > 0) messageObject.files = attachmentUrls;
        messageObject.components = interaction.message.components;
        messageObject.embeds = messageObject.embeds.map(normalizeEmbed);
        await interaction.message.edit(messageObject);
    }
}

module.exports = { handle };
