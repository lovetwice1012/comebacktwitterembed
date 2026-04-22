'use strict';

const fs = require('fs');
const path = require('path');
const { ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');
const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../../../locales');
const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../../../settings');
const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../../../db');
const {
    button_disabled_template,
    button_invisible_template,
    antiDirectoryTraversalAttack,
    ifUserHasRole,
    convertBoolToEnableDisable,
    conv_en_to_en_US,
} = require('../../../utils');

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
