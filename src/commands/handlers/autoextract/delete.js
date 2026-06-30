'use strict';

const { t } = require('../../../locales');
const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');

module.exports = async function (interaction, client) {
    const id = interaction.options.getInteger('id');
    if (id === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (isNaN(id)) return await interaction.reply('The specified ID is not a number.');

    const results = await queryDatabase(
        `DELETE FROM ${TABLES.autoExtractTargets} WHERE user_id = ? AND id = ?`,
        [interaction.user.id, id]
    );
    if (results.affectedRows === 0) return await interaction.reply('No entry exists for the specified ID.');
    await interaction.reply({ embeds: [{ title: 'Auto extract delete', description: 'Delete completed.', color: 0x1DA1F2 }] });
};
