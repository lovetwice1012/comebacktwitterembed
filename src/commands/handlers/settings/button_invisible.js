'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { settings } = require('../../../settings');
const { button_invisible_template, convertBoolToEnableDisable } = require('../../../utils');

function ensureProviderButtonInvisible(providerId, guildId) {
    if (!settings.byProvider) settings.byProvider = {};
    if (!settings.byProvider[providerId]) settings.byProvider[providerId] = {};
    if (!settings.byProvider[providerId].button_invisible) settings.byProvider[providerId].button_invisible = {};
    if (settings.byProvider[providerId].button_invisible[guildId] === undefined) {
        settings.byProvider[providerId].button_invisible[guildId] = { ...button_invisible_template, savetweet: false };
    }
    return settings.byProvider[providerId].button_invisible[guildId];
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
        return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    }

    const providerId = interaction.options.getSubcommandGroup(false) || interaction.options.getString('provider') || 'twitter';

    if (settings.button_invisible[interaction.guildId] === undefined) settings.button_invisible[interaction.guildId] = { ...button_invisible_template, savetweet: false };
    if (settings.button_invisible[interaction.guildId].savetweet === undefined) settings.button_invisible[interaction.guildId].savetweet = false;
    const providerSetting = ensureProviderButtonInvisible(providerId, interaction.guildId);

    //options: showMediaAsAttachments, showAttachmentsAsEmbedsImage, translate, delete, all;  all boolean
    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('savetweet') === null && interaction.options.getBoolean('all') === null) {
        return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }
    if (interaction.options.getBoolean('all') !== null) {
        if (interaction.options.getBoolean('all') === true) {
            providerSetting.showMediaAsAttachments = true;
            providerSetting.showAttachmentsAsEmbedsImage = true;
            providerSetting.translate = true;
            providerSetting.delete = true;
            providerSetting.savetweet = true;
            if (providerId === 'twitter') {
                settings.button_invisible[interaction.guildId].showMediaAsAttachments = true;
                settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = true;
                settings.button_invisible[interaction.guildId].translate = true;
                settings.button_invisible[interaction.guildId].delete = true;
                settings.button_invisible[interaction.guildId].savetweet = true;
            }
            await interaction.reply(t('addedAllButtonLocales', interaction.locale));
        } else {
            providerSetting.showMediaAsAttachments = false;
            providerSetting.showAttachmentsAsEmbedsImage = false;
            providerSetting.translate = false;
            providerSetting.delete = false;
            providerSetting.savetweet = false;
            if (providerId === 'twitter') {
                settings.button_invisible[interaction.guildId].showMediaAsAttachments = false;
                settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = false;
                settings.button_invisible[interaction.guildId].translate = false;
                settings.button_invisible[interaction.guildId].delete = false;
                settings.button_invisible[interaction.guildId].savetweet = false;
            }
            await interaction.reply(t('removedAllButtonLocales', interaction.locale));
        }
    } else {
        if (interaction.options.getBoolean('showmediaasattachments') !== null) {
            providerSetting.showMediaAsAttachments = interaction.options.getBoolean('showmediaasattachments');
            if (providerId === 'twitter') settings.button_invisible[interaction.guildId].showMediaAsAttachments = interaction.options.getBoolean('showmediaasattachments');
            await interaction.reply((t('setshowmediaasattachmentsbuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('showmediaasattachments'), interaction.locale));
        }
        if (interaction.options.getBoolean('showattachmentsasembedsimage') !== null) {
            providerSetting.showAttachmentsAsEmbedsImage = interaction.options.getBoolean('showattachmentsasembedsimage');
            if (providerId === 'twitter') settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = interaction.options.getBoolean('showattachmentsasembedsimage');
            await interaction.reply((t('setshowattachmentsasembedsimagebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('showattachmentsasembedsimage'), interaction.locale));
        }
        if (interaction.options.getBoolean('translate') !== null) {
            providerSetting.translate = interaction.options.getBoolean('translate');
            if (providerId === 'twitter') settings.button_invisible[interaction.guildId].translate = interaction.options.getBoolean('translate');
            await interaction.reply((t('settranslatebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('translate'), interaction.locale));
        }
        if (interaction.options.getBoolean('delete') !== null) {
            providerSetting.delete = interaction.options.getBoolean('delete');
            if (providerId === 'twitter') settings.button_invisible[interaction.guildId].delete = interaction.options.getBoolean('delete');
            await interaction.reply((t('setdeletebuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('delete'), interaction.locale));
        }
        if (interaction.options.getBoolean('savetweet') !== null) {
            providerSetting.savetweet = interaction.options.getBoolean('savetweet');
            if (providerId === 'twitter') settings.button_invisible[interaction.guildId].savetweet = interaction.options.getBoolean('savetweet');
            await interaction.reply((t('setsavetweetbuttonLocales', interaction.locale)) + convertBoolToEnableDisable(!interaction.options.getBoolean('savetweet'), interaction.locale));
        }
    }

};
