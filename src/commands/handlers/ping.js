'use strict';

const { descriptionLocales, commandNameLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
module.exports.execute = async function (interaction, client) {

    await interaction.reply({
        embeds: [
            {
                title: 'Pong!',
                description: 'Ping: ' + client.ws.ping + 'ms',
                color: 0x1DA1F2
            }
        ]
    });

};

module.exports.definition = {
        name: 'ping',
        name_localizations: conv_en_to_en_US(commandNameLocales.ping),
        description: 'Pong!',
        description_localizations: conv_en_to_en_US(descriptionLocales.pingcommand)
    };
