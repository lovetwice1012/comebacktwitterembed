'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../../../locales');
const { queryDatabase, withDatabaseTransaction } = require('../../../db');
const { lockOwner } = require('../../../automation/entitlements');
const { explicitAdminAdjustment } = require('../../../automation/push-support-grants');
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
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 2147483647) return await interaction.editReply('Slot must be an integer between 1 and 2,147,483,647.');
    if (typeof interaction.id !== 'string' || !/^\d{16,22}$/.test(interaction.id)) return await interaction.editReply('Interaction ID could not be verified. Please run this command again.');

    await withDatabaseTransaction(async query => {
        await lockOwner(query, user.id);
        const current = (await query(`SELECT additional_auto_extract_slots FROM ${TABLES.users} WHERE user_id=? FOR UPDATE`, [user.id]))[0];
        // isAdmin here is derived solely from the unchanged staff/guild/channel
        // gate above. No client field can turn this operation into an admin grant.
        await explicitAdminAdjustment(query, { userId: interaction.user.id, isAdmin: true }, {
            userId: user.id, idempotencyKey: `discord:${interaction.id}`, expectedManualSlots: Number(current?.additional_auto_extract_slots ?? 0),
            manualSlots: slot, reason: 'Approved Discord additionalautoextractslot command',
        });
        await query(`UPDATE ${TABLES.users} SET is_donor=1 WHERE user_id=?`, [user.id]);
    });

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
