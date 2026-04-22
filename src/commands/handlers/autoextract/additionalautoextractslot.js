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

function hasAdminPerm(member) {
    return (
        member.permissions.has(PermissionsBitField.Flags.ManageChannels)
        || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
}

module.exports = async function (interaction, client) {
    if (!hasAdminPerm(interaction.member)) {
        return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    }


    /*
    列	型	コメント
    userid	bigint(20)	
    plan	int(11) [0]	
    paid_plan_expired_at	bigint(20) [0]	
    register_date	bigint(20)	
    additional_autoextraction_slot	int(11) [0]	
    save_tweet_quota_override	bigint(20) NULL	
    enabled	tinyint(4) [1]	
    */
    //796972193287503913以外は実行を拒否
    if (interaction.user.id !== '796972193287503913') return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    const slot = interaction.options.getInteger('slot');
    const user = interaction.options.getUser('user');
    //データベースにuseridが存在するか確認する  
    let additional_autoextraction_slot_data = await new Promise(resolve => {
        connection.query('SELECT * FROM users WHERE userid = ?', [user.id], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results.length)
        });
    });
    //存在しない場合は登録する
    //存在する場合はadditional_autoextraction_slotをoption(slot)する

    if (slot === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (slot < 1) return await interaction.reply("追加スロットは1以上で指定してください。");
    if (additional_autoextraction_slot_data === 0) {
        connection.query('INSERT INTO users (userid, register_date, additional_autoextraction_slot) VALUES (?, ?, ?)', [user.id, new Date().getTime(), slot], async function (error, results, fields) {
            if (error) throw error;
            await interaction.reply({ embeds: [{ title: 'Auto extract additional slot', description: '追加スロットの登録が完了しました。', color: 0x1DA1F2 }] });
        });
    } else {
        connection.query('UPDATE users SET additional_autoextraction_slot = ? WHERE userid = ?', [slot, user.id], async function (error, results, fields) {
            if (error) throw error;
            await interaction.reply({ embeds: [{ title: 'Auto extract additional slot', description: '追加スロットの変更が完了しました。', color: 0x1DA1F2 }] });
        });
    }

};
