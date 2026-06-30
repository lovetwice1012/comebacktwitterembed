'use strict';

const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');

module.exports = async function (interaction, client) {
    const results = await queryDatabase(
        `SELECT t.id, t.twitter_username, w.webhook_url
         FROM ${TABLES.autoExtractTargets} t
         INNER JOIN ${TABLES.webhookEndpoints} w ON w.id = t.webhook_endpoint_id
         WHERE t.user_id = ? AND t.enabled = 1
         ORDER BY t.id`,
        [interaction.user.id]
    );

    if (results.length === 0) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract list', description: 'No auto extract entries are registered.', color: 0x1DA1F2 }] });
    }

    let content = '';
    results.forEach(element => {
        if (element.webhook_url === null) return;
        content += element.id + ': [' + element.twitter_username + '](https://twitter.com/' + element.twitter_username + ') [WEBHOOK](' + element.webhook_url + ')\n';
    });
    await interaction.reply({
        embeds: [
            {
                title: 'Auto extract list',
                description: content,
                color: 0x1DA1F2,
            },
        ],
        flags: 64,
    });
};
