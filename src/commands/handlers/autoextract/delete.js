'use strict';

const { t } = require('../../../locales');
const { connection } = require('../../../db');

module.exports = async function (interaction, client) {

    const id = interaction.options.getInteger('id');
    if (id === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    //idが数字か確認する
    if (isNaN(id)) return await interaction.reply("指定されたIDは数字ではありません。");
    connection.query('DELETE FROM rss WHERE userid = ? AND id = ?', [interaction.user.id, id], async function (error, results, fields) {
        if (error) throw error;
        if (results.affectedRows === 0) return await interaction.reply("指定されたIDの登録は存在しません。");
        await interaction.reply({ embeds: [{ title: 'Auto extract delete', description: '削除が完了しました。', color: 0x1DA1F2 }] });
    });

};
