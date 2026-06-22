'use strict';

const { connection } = require('../../../db');

module.exports = async function (interaction, client) {

    const free_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE premium_flag = 0', [], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results.length);
        });
    });
    //無料枠の空き数と支援者優先枠の空き数を表示する。また、支援者優先枠の空き数が0の場合はその旨を表示する。さらに、全体の空き数と使用数、使用率を表示する。
    const premium_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE premium_flag = 1', [], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results.length);
        });
    });
    const user_using_free_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 0', [interaction.user.id], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results.length);
        });
    });
    const user_using_premium_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 1', [interaction.user.id], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results.length);
        });
    });
    const user_have_additional_autoextraction_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM users WHERE userid = ?', [interaction.user.id], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results[0]?.additional_autoextraction_slot ?? 0);
        });
    });
    const all_using_slot = free_slot + premium_slot;
    const all_free_slot = 175;
    const all_donater_slot = 150;
    const all_slot = all_free_slot + all_donater_slot;
    const free_slot_percent = Math.floor((free_slot / all_free_slot) * 100);
    const premium_slot_percent = Math.floor((premium_slot / all_donater_slot) * 100);
    const all_using_slot_percent = Math.floor((all_using_slot / all_slot) * 100);
    let content = '';
    content += '無料枠の空き数: ' + (all_free_slot - free_slot) + '/' + all_free_slot + ' (' + free_slot_percent + '%)\n';
    content += '支援者優先枠の空き数: ' + (all_donater_slot - premium_slot) + '/' + all_donater_slot + ' (' + premium_slot_percent + '%)\n';
    content += 'あなたの無料枠の使用数: ' + user_using_free_slot + '/' + free_slot + '\n';
    content += 'あなたの支援者優先枠の使用数: ' + user_using_premium_slot + '/' + premium_slot + '\n';
    content += 'あなたの追加スロットの使用数: ' + user_using_premium_slot + '/' + user_have_additional_autoextraction_slot + '\n';
    content += '全体の使用数: ' + all_using_slot + '/' + all_slot + ' (' + all_using_slot_percent + '%)\n';
    await interaction.reply({ embeds: [{ title: 'Auto extract check free slot', description: content, color: 0x1DA1F2 }] });

};
