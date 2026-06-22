'use strict';

const { ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales');

function getExistingDeleteCustomId(interaction) {
    for (const row of interaction.message.components || []) {
        for (const component of row.components || []) {
            if (typeof component.customId === 'string' && component.customId.startsWith('delete')) {
                return component.customId;
            }
        }
    }
    return 'delete';
}

// Builds the four standard buttons whose labels are interaction-locale aware.
function buildButtons(interaction) {
    const deleteCustomId = getExistingDeleteCustomId(interaction);
    return {
        deleteButton: new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel('Delete').setCustomId(deleteCustomId),
        translateButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Translate').setCustomId('translate'),
        showAttachmentsAsMediaButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('showAttachmentsAsEmbedsImagebuttonLocales', interaction.locale)).setCustomId('showAttachmentsAsEmbedsImage'),
        showMediaAsAttachmentsButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('showMediaAsAttachmentsButtonLocales', interaction.locale)).setCustomId('showMediaAsAttachments'),
    };
}

module.exports = { buildButtons };
