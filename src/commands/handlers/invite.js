'use strict';

const fs = require('fs');
const path = require('path');
const { ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');
const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../../locales');
const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../../settings');
const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../../db');
const {
    button_disabled_template,
    button_invisible_template,
    antiDirectoryTraversalAttack,
    ifUserHasRole,
    convertBoolToEnableDisable,
    conv_en_to_en_US,
} = require('../../utils');

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
