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

    let premium_flag = 0;
    //premiun_flagが0でuseridが一致するレコードが5件以上あるか確認する
    let additional_autoextraction_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM users WHERE userid = ?', [interaction.user.id], async function (error, results, fields) {
            if (error) throw error;
            if (results.length === 0) {
                connection.query('INSERT INTO users (userid, register_date) VALUES (?, ?)', [interaction.user.id, new Date().getTime()], async function (error, results, fields) {
                    if (error) throw error;
                });
                return resolve(0);
            }
            return resolve(results[0].additional_autoextraction_slot);
        });
    });
    const limit_free_check = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE premium_flag = 0', [], async function (error, results, fields) {
            if (error) throw error;
            if (results.length < 175) return resolve(true);
            resolve(false);
        });
    });
    if (!limit_free_check && additional_autoextraction_slot === 0) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '無料枠の登録は上限に達しているため追加できません。', color: 0x1DA1F2 }] });
    const over_5_check = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 0', [interaction.user.id], async function (error, results, fields) {
            if (error) throw error;
            if (results.length >= 5) return resolve(false);
            resolve(true);
        });
    });
    if (!over_5_check && additional_autoextraction_slot === 0) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '5件以上の登録はできません。', color: 0x1DA1F2 }] });
    const now_using_additional_autoextraction_slot = await new Promise(resolve => {
        connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 1', [interaction.user.id], async function (error, results, fields) {
            if (error) throw error;
            return resolve(results.length);
        });
    });
    if (additional_autoextraction_slot != 0 && (now_using_additional_autoextraction_slot >= additional_autoextraction_slot) && (!over_5_check || !limit_free_check)) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '支援者優先枠の登録上限に達しているため追加できません。', color: 0x1DA1F2 }] });
    } else if (additional_autoextraction_slot != 0 && (now_using_additional_autoextraction_slot < additional_autoextraction_slot) && (over_5_check || limit_free_check)) {
        premium_flag = 1;
    }

    const username = interaction.options.getString('username');
    const webhooks = interaction.options.getString('webhook');
    const webhooks_array = webhooks.split(',');
    for (let i = 0; i < webhooks_array.length; i++) {
        const webhook = webhooks_array[i];
        if (username === null || webhook === null) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
        //usernameが存在するか確認する(数字とアルファベットと_のみで構成されているか確認する)
        if (!username.match(/^[0-9a-zA-Z_]+$/)) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたユーザーは無効です。\n[入力されたユーザー](https://twitter.com/' + username + ')', color: 0x1DA1F2 }] });
        //webhookが正しい形式か確認する
        if (!webhook.match(/^https:\/\/discord.com\/api\/webhooks\/[0-9]+\/[a-zA-Z0-9_-]+$/)) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたWEBHOOKは正しい形式ではないか、無効です。', color: 0x1DA1F2 }] });
        //webhookにテストメッセージを送信する
        const webhookResponse = await fetch(webhook, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ embeds: [{ title: 'このチャンネルにツイートを送信します', description: 'これはComebackTwitterEmbedの新着自動展開機能の登録確認メッセージです。\n今後はこのチャンネルに[' + username + '](https://twitter.com/' + username + ')のツイートが更新されるたびに通知を行います。' }] })
        });
        if (webhookResponse.status !== 204) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたWEBHOOKは正しい形式ではないか、無効です。', color: 0x1DA1F2 }] });
        connection.query('INSERT INTO rss (userid, username, lastextracted, webhook, created_at, premium_flag) VALUES (?, ?, ?, ?, ?, ?)', [interaction.user.id, username, new Date().getTime(), webhook, new Date().getTime(), premium_flag], async function (error, results, fields) {
            if (error) throw error;
            await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '登録が完了しました。\n[登録されたユーザー](https://twitter.com/' + username + ')', color: 0x1DA1F2 }] });
        });
    }

};
