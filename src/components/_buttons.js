'use strict';

const { ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales');

// Builds the four standard buttons whose labels are interaction-locale aware.
function buildButtons(interaction) {
    return {
        deleteButton: new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel('Delete').setCustomId('delete'),
        translateButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Translate').setCustomId('translate'),
        showAttachmentsAsMediaButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('showAttachmentsAsEmbedsImagebuttonLocales', interaction.locale)).setCustomId('showAttachmentsAsEmbedsImage'),
        showMediaAsAttachmentsButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('showMediaAsAttachmentsButtonLocales', interaction.locale)).setCustomId('showMediaAsAttachments'),
    };
}

module.exports = { buildButtons };
