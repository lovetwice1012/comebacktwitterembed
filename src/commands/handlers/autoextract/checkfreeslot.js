'use strict';

const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');

const FREE_SLOT_LIMIT = 175;

async function countRows(sql, params) {
    const rows = await queryDatabase(sql, params);
    return rows[0]?.total ?? 0;
}

module.exports = async function (interaction, client) {
    const free_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoWatchTargets} WHERE premium_slot = 0 AND enabled = 1`,
        []
    );
    const premium_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoWatchTargets} WHERE premium_slot = 1 AND enabled = 1`,
        []
    );
    const user_using_free_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoWatchTargets} WHERE user_id = ? AND premium_slot = 0 AND enabled = 1`,
        [interaction.user.id]
    );
    const user_using_premium_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoWatchTargets} WHERE user_id = ? AND premium_slot = 1 AND enabled = 1`,
        [interaction.user.id]
    );
    const userRows = await queryDatabase(
        `SELECT additional_auto_extract_slots, is_donor FROM ${TABLES.users} WHERE user_id = ?`,
        [interaction.user.id]
    );
    const user_have_additional_autoextraction_slot = userRows[0]?.additional_auto_extract_slots ?? 0;

    const all_using_slot = free_slot + premium_slot;
    const all_slot = FREE_SLOT_LIMIT + user_have_additional_autoextraction_slot;
    const free_slot_percent = Math.floor((free_slot / FREE_SLOT_LIMIT) * 100);
    const premium_slot_percent = user_have_additional_autoextraction_slot > 0
        ? Math.floor((user_using_premium_slot / user_have_additional_autoextraction_slot) * 100)
        : 0;
    const all_using_slot_percent = Math.floor((all_using_slot / all_slot) * 100);
    let content = '';
    content += String(interaction.locale || '').startsWith('ja')
        ? `新着自動展開の登録は寄付者限定です。現在の登録資格: ${Number(userRows[0]?.is_donor) === 1 ? '登録可能' : '寄付者登録が必要'}\n`
        : `New-post automatic expansion registration is donors only. Your eligibility: ${Number(userRows[0]?.is_donor) === 1 ? 'eligible' : 'donor registration required'}\n`;
    content += 'Free slots remaining: ' + (FREE_SLOT_LIMIT - free_slot) + '/' + FREE_SLOT_LIMIT + ' (' + free_slot_percent + '%)\n';
    content += 'Your additional slots remaining: ' + Math.max(0, user_have_additional_autoextraction_slot - user_using_premium_slot) + '/' + user_have_additional_autoextraction_slot + ' (' + premium_slot_percent + '%)\n';
    content += 'Your free slots used: ' + user_using_free_slot + '/' + free_slot + '\n';
    content += 'Your additional slots used: ' + user_using_premium_slot + '/' + user_have_additional_autoextraction_slot + '\n';
    content += 'Your additional slot quota: ' + user_using_premium_slot + '/' + user_have_additional_autoextraction_slot + '\n';
    content += 'Total usage: ' + all_using_slot + '/' + all_slot + ' (' + all_using_slot_percent + '%)\n';
    await interaction.editReply({ embeds: [{ title: 'Auto watch check free slot', description: content, color: 0x1DA1F2 }] });
};
