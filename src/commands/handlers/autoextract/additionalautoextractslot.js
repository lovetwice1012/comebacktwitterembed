'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');

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

    if (interaction.user.id !== '796972193287503913') return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    const slot = interaction.options.getInteger('slot');
    const user = interaction.options.getUser('user');

    if (slot === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (slot < 1) return await interaction.reply('Slot must be 1 or greater.');

    await queryDatabase(
        `INSERT INTO ${TABLES.users} (user_id, registered_at_ms, additional_auto_extract_slots)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE additional_auto_extract_slots = VALUES(additional_auto_extract_slots)`,
        [user.id, Date.now(), slot]
    );

    await interaction.reply({ embeds: [{ title: 'Auto extract additional slot', description: 'Additional slot setting saved.', color: 0x1DA1F2 }] });
};
