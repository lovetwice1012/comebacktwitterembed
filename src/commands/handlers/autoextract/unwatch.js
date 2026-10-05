'use strict';

const { deleteTarget } = require('../../../providers/autoWatch/store');

module.exports = async function (interaction) {
    const id = interaction.options.getInteger('id');
    if (!Number.isSafeInteger(id) || id <= 0) {
        return await interaction.editReply({ embeds: [{ title: 'Auto watch', description: 'A valid watch ID is required.', color: 0xe74c3c }] });
    }
    try {
        await deleteTarget(interaction.user.id, id);
        return await interaction.editReply({ embeds: [{ title: 'Auto watch', description: 'Watch registration deleted.', color: 0x1DA1F2 }] });
    } catch (error) {
        return await interaction.editReply({ embeds: [{ title: 'Auto watch', description: error?.message || String(error), color: 0xe74c3c }] });
    }
};
