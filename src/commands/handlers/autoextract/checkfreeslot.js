'use strict';

const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');

const FREE_SLOT_LIMIT = 175;
const PREMIUM_SLOT_LIMIT = 150;

async function countRows(sql, params) {
    const rows = await queryDatabase(sql, params);
    return rows[0]?.total ?? 0;
}

module.exports = async function (interaction, client) {
    const free_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE premium_slot = 0 AND enabled = 1`,
        []
    );
    const premium_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE premium_slot = 1 AND enabled = 1`,
        []
    );
    const user_using_free_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE user_id = ? AND premium_slot = 0 AND enabled = 1`,
        [interaction.user.id]
    );
    const user_using_premium_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE user_id = ? AND premium_slot = 1 AND enabled = 1`,
        [interaction.user.id]
    );
    const userRows = await queryDatabase(
        `SELECT additional_auto_extract_slots FROM ${TABLES.users} WHERE user_id = ?`,
        [interaction.user.id]
    );
    const user_have_additional_autoextraction_slot = userRows[0]?.additional_auto_extract_slots ?? 0;

    const all_using_slot = free_slot + premium_slot;
    const all_slot = FREE_SLOT_LIMIT + PREMIUM_SLOT_LIMIT;
    const free_slot_percent = Math.floor((free_slot / FREE_SLOT_LIMIT) * 100);
    const premium_slot_percent = Math.floor((premium_slot / PREMIUM_SLOT_LIMIT) * 100);
    const all_using_slot_percent = Math.floor((all_using_slot / all_slot) * 100);
    let content = '';
    content += 'Free slots remaining: ' + (FREE_SLOT_LIMIT - free_slot) + '/' + FREE_SLOT_LIMIT + ' (' + free_slot_percent + '%)\n';
    content += 'Additional slots remaining: ' + (PREMIUM_SLOT_LIMIT - premium_slot) + '/' + PREMIUM_SLOT_LIMIT + ' (' + premium_slot_percent + '%)\n';
    content += 'Your free slots used: ' + user_using_free_slot + '/' + free_slot + '\n';
    content += 'Your additional slots used: ' + user_using_premium_slot + '/' + premium_slot + '\n';
    content += 'Your additional slot quota: ' + user_using_premium_slot + '/' + user_have_additional_autoextraction_slot + '\n';
    content += 'Total usage: ' + all_using_slot + '/' + all_slot + ' (' + all_using_slot_percent + '%)\n';
    await interaction.editReply({ embeds: [{ title: 'Auto extract check free slot', description: content, color: 0x1DA1F2 }] });
};
