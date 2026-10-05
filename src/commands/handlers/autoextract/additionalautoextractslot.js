'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');
const { sendEmbedPages } = require('../../../interactionResponse');

const DONOR_GRANT_CONTEXT = Object.freeze({
    guildId: '1132814274734067772',
    channelId: '1201521425756979352',
    operatorUserId: '796972193287503913',
});

function hasAdminPerm(member) {
    return Boolean(member?.permissions?.has) && (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

function isDonorGrantContext(interaction) {
    return interaction.guildId === DONOR_GRANT_CONTEXT.guildId
        && interaction.channelId === DONOR_GRANT_CONTEXT.channelId
        && interaction.user?.id === DONOR_GRANT_CONTEXT.operatorUserId;
}

module.exports = async function (interaction, client) {
    if (!isDonorGrantContext(interaction) || !hasAdminPerm(interaction.member)) {
        return await interaction.editReply(t('userDonthavePermissionLocales', interaction.locale));
    }

    const slot = interaction.options.getInteger('slot');
    const user = interaction.options.getUser('user');

    if (slot === null || user === null) return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (slot < 1) return await interaction.editReply('Slot must be 1 or greater.');

    await queryDatabase(
        `INSERT INTO ${TABLES.users} (user_id, registered_at_ms, additional_auto_extract_slots, is_donor)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
            additional_auto_extract_slots = VALUES(additional_auto_extract_slots),
            is_donor = 1`,
        [user.id, Date.now(), slot]
    );

    const donors = await queryDatabase(
        `SELECT user_id FROM ${TABLES.users} WHERE is_donor = 1 ORDER BY user_id`,
        []
    );
    await sendEmbedPages(interaction, {
        title: 'Auto extract additional slot',
        lines: [
            `Additional slot setting saved for <@${user.id}>.`,
            'Donor users:',
            ...donors.map(donor => `<@${donor.user_id}>`),
        ],
        emptyDescription: 'No donor users are registered.',
        color: 0x1DA1F2,
        ephemeralFollowUps: true,
    });
};
