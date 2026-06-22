'use strict';

const { descriptionLocales, commandNameLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
module.exports.execute = async function (interaction, client) {

    await interaction.reply({
        embeds: [
            {
                title: 'Invite',
                description: descriptionLocales.invitecommand[interaction.locale] ?? descriptionLocales.invitecommand["en"],
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'Invite link',
                        value: 'https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877958144&scope=bot%20applications.commands'
                    }
                ]
            }
        ]
    });

};

module.exports.definition = {
        name: 'invite',
        name_localizations: conv_en_to_en_US(commandNameLocales.invite),
        description: 'Invite me to your server!',
        description_localizations: conv_en_to_en_US(descriptionLocales.invitecommand)
    };
