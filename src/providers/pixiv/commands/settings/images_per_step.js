'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../../locales');
const { setSetting } = require('../../../_provider_settings');

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

module.exports = async function (interaction) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    }

    const imagesPerStep = interaction.options.getInteger('value');
    if (imagesPerStep !== 4 && imagesPerStep !== 10) {
        return await interaction.reply(t('pixivImagesPerStepMustBe4Or10Locales', interaction.locale));
    }

    setSetting({ id: 'pixiv' }, 'pixiv_images_per_step', interaction.guildId, imagesPerStep);
    return await interaction.reply(t('setPixivImagesPerStepToLocales', interaction.locale) + imagesPerStep);
};
