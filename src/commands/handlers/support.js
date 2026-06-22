'use strict';

const { descriptionLocales, commandNameLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
module.exports.execute = async function (interaction, client) {

    await interaction.reply({
        embeds: [
            {
                title: 'Support',
                description: descriptionLocales.supportcommand[interaction.locale] ?? descriptionLocales.supportcommand["en"],
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'Support server link',
                        value: 'https://discord.gg/V5VUtS83SG'
                    }
                ]
            }
        ]
    });

};

module.exports.definition = {
        name: 'support',
        name_localizations: conv_en_to_en_US(commandNameLocales.support),
        description: 'Join support server!',
        description_localizations: conv_en_to_en_US(descriptionLocales.supportcommand)
    };
