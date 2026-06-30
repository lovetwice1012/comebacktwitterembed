'use strict';

const { t } = require('../../../locales');

function getSourceGuildId(interaction) {
    return interaction.options.getString('source_guild') || interaction.options.getString('sourceguild');
}

module.exports = async function (interaction) {
    const sourceGuildId = getSourceGuildId(interaction);
    if (!sourceGuildId) {
        return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }

    const notice = await require('../guisetting')._internal.importSettingsFromGuild(
        interaction,
        String(sourceGuildId).trim(),
        interaction.guildId
    );
    return await interaction.editReply({ content: notice });
};
