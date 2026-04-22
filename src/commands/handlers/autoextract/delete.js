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

    const id = interaction.options.getInteger('id');
    if (id === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    //idが数字か確認する
    if (isNaN(id)) return await interaction.reply("指定されたIDは数字ではありません。");
    connection.query('DELETE FROM rss WHERE userid = ? AND id = ?', [interaction.user.id, id], async function (error, results, fields) {
        if (error) throw error;
        if (results.affectedRows === 0) return await interaction.reply("指定されたIDの登録は存在しません。");
        await interaction.reply({ embeds: [{ title: 'Auto extract delete', description: '削除が完了しました。', color: 0x1DA1F2 }] });
    });

};
