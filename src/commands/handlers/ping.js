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
