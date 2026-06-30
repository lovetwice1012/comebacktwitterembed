'use strict';

const { t, descriptionLocales, commandNameLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
module.exports.execute = async function (interaction, client) {

    await interaction.editReply({
        embeds: [
            {
                title: 'Help',
                description: t('helpDiscriptionLocales', interaction.locale),
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'Commands',
                        value: t('helpCommandsLocales', interaction.locale)
                    }
                ]
            }
        ]
    });

};

module.exports.definition = {
        name: 'help',
        name_localizations: conv_en_to_en_US(commandNameLocales.help),
        description: 'Shows help message.',
        description_localizations: conv_en_to_en_US(descriptionLocales.helpcommand)
    };
