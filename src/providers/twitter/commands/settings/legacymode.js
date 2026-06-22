'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../../locales');
const { settings } = require('../../../../settings');
const { setSetting } = require('../../../../providers/_provider_settings');
const { convertBoolToEnableDisable } = require('../../../../utils');
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

    if (settings.secondary_extract_mode[interaction.guildId] === true) settings.secondary_extract_mode[interaction.guildId] = false;
    if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    const boolean = interaction.options.getBoolean('boolean');
    setSetting({ id: 'twitter' }, 'legacy_mode', interaction.guildId, boolean);
    if (boolean === true) setSetting({ id: 'twitter' }, 'secondary_extract_mode', interaction.guildId, false);
    settings.legacy_mode[interaction.guildId] = boolean;
    await interaction.reply((t('setlegacymodetolocales', interaction.locale)) + convertBoolToEnableDisable(boolean, interaction.locale));
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) await interaction.followUp("※BOTにメッセージの管理権限を付与するとdiscord純正の埋め込みのみを削除して今まで通りの展開が行われます。\nこのBOTにメッセージの管理権限を付与することを検討してみてください。\n(使用感はdiscordがリンクの展開を修正する前と変わらなくなります。)")

};
