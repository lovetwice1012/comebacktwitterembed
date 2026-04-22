'use strict';

const fetch = require('node-fetch');
const { settings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');

const TRANSLATE_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwmofa3n_K15ze_-4KrpH-B-eBHiKXmmgLeqsJInS3dJUDM0IJ-627h8Xu-w8PIc2f-ug/exec';

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
    if (sourceEmbed.images) copyEmbed.image = sourceEmbed.image;
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

    const lines = sourceEmbed.description.split('\n');
    const trailingTail = lines.slice(lines.length - 4).join('\n');
    const translatable = lines.slice(0, lines.length - 3).join('\n');

    const res = await fetch(`${TRANSLATE_ENDPOINT}?target=${target}&text=${encodeURIComponent(translatable)}`);
    const translated = await res.text();
    messageObject.embeds[0].description = translated + trailingTail;

    messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId);
    await interaction.editReply(messageObject);

    if (settings.editOriginalIfTranslate[interaction.guildId] === true) {
        if (interaction.message.attachments.length > 0) {
            messageObject.files = [];
            interaction.message.attachments.forEach(a => messageObject.files.push(a.url));
        }
        messageObject.components = interaction.message.components;
        await interaction.message.edit(messageObject);
    }
}

module.exports = { handle };
