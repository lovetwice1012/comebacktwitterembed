'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { button_invisible_template, convertBoolToEnableDisable } = require('../../../utils');
const { getSetting, setSetting } = require('../../../providers/_provider_settings');

async function getProviderButtonInvisible(providerId, guildId) {
    const raw = await getSetting({ id: providerId }, 'button_invisible', guildId);
    return { ...button_invisible_template, savetweet: false, ...(raw || {}) };
}

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';
    const providerSetting = await getProviderButtonInvisible(providerId, interaction.guildId);

    //options: showMediaAsAttachments, showAttachmentsAsEmbedsImage, translate, delete, all;  all boolean
    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('savetweet') === null && interaction.options.getBoolean('all') === null) {
        return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }
    if (interaction.options.getBoolean('all') !== null) {
        if (interaction.options.getBoolean('all') === true) {
            providerSetting.showMediaAsAttachments = true;
            providerSetting.showAttachmentsAsEmbedsImage = true;
            providerSetting.translate = true;
            providerSetting.delete = true;
            providerSetting.savetweet = true;
            await setSetting({ id: providerId }, 'button_invisible', interaction.guildId, providerSetting);
            await interaction.editReply(t('addedAllButtonLocales', interaction.locale));
        } else {
            providerSetting.showMediaAsAttachments = false;
            providerSetting.showAttachmentsAsEmbedsImage = false;
            providerSetting.translate = false;
            providerSetting.delete = false;
            providerSetting.savetweet = false;
            await setSetting({ id: providerId }, 'button_invisible', interaction.guildId, providerSetting);
            await interaction.editReply(t('removedAllButtonLocales', interaction.locale));
        }
    } else {
        const response = [];
        if (interaction.options.getBoolean('showmediaasattachments') !== null) {
            providerSetting.showMediaAsAttachments = interaction.options.getBoolean('showmediaasattachments');
            response.push((t('setshowmediaasattachmentsbuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('showmediaasattachments'), interaction.locale));
        }
        if (interaction.options.getBoolean('showattachmentsasembedsimage') !== null) {
            providerSetting.showAttachmentsAsEmbedsImage = interaction.options.getBoolean('showattachmentsasembedsimage');
            response.push((t('setshowattachmentsasembedsimagebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('showattachmentsasembedsimage'), interaction.locale));
        }
        if (interaction.options.getBoolean('translate') !== null) {
            providerSetting.translate = interaction.options.getBoolean('translate');
            response.push((t('settranslatebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('translate'), interaction.locale));
        }
        if (interaction.options.getBoolean('delete') !== null) {
            providerSetting.delete = interaction.options.getBoolean('delete');
            response.push((t('setdeletebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('delete'), interaction.locale));
        }
        if (interaction.options.getBoolean('savetweet') !== null) {
            providerSetting.savetweet = interaction.options.getBoolean('savetweet');
            response.push((t('setsavetweetbuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('savetweet'), interaction.locale));
        }
        await setSetting({ id: providerId }, 'button_invisible', interaction.guildId, providerSetting);
        await interaction.editReply(response.join('\n'));
    }

};
