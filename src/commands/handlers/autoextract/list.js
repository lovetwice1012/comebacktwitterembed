'use strict';

const { connection } = require('../../../db');

module.exports = async function (interaction, client) {

    connection.query('SELECT * FROM rss WHERE userid = ?', [interaction.user.id], async function (error, results, fields) {
        if (error) throw error;
        if (results.length === 0) return await interaction.reply({ embeds: [{ title: 'Auto extract list', description: 'データが登録されていません。', color: 0x1DA1F2 }] });
        let content = '';
        results.forEach(element => {
            if (element.webhook === null) return;
            content += element.id + ': [' + element.username + '](https://twitter.com/' + element.username + ') [WEBHOOK](' + element.webhook + ')\n';
        });
        await interaction.reply({
            embeds: [
                {
                    title: 'Auto extract list',
                    description: content,
                    color: 0x1DA1F2
                }
            ],
            flags: 64
        });
    }
    );

};
