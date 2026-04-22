'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../locales');

async function handle(interaction) {
    const finishAndCleanup = async () => {
        await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
        setTimeout(() => { interaction.deleteReply(); }, 3000);
    };

    if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        await interaction.message.delete();
        await finishAndCleanup();
        return;
    }

    // Non-managers can only delete embeds they originally requested. The author
    // ID is encoded in the embed author name as `<name>:<userId>)`.
    const requesterId = interaction.message.embeds[0].author.name.split(':')[1].split(')')[0];
    if (requesterId !== interaction.user.id) {
        await interaction.editReply({ content: t('youcantdeleteotherusersmessagesLocales', interaction.locale), ephemeral: true });
        setTimeout(() => { interaction.deleteReply(); }, 3000);
        return;
    }
    await interaction.message.delete();
    await finishAndCleanup();
}

module.exports = { handle };
