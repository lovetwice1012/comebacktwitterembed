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
