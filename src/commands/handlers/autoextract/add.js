'use strict';

const { t } = require('../../../locales');
const { connection } = require('../../../db');
const fetch = require('node-fetch');

function queryAsync(sql, params) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (error, results) => {
            if (error) reject(error);
            else resolve(results);
        });
    });
}

function invalidWebhookReply() {
    return {
        embeds: [{
            title: 'Auto extract add',
            description: '指定されたWEBHOOKは正しい形式ではないか、無効です。',
            color: 0x1DA1F2,
        }],
    };
}

module.exports = async function (interaction) {
    let premium_flag = 0;

    const userRows = await queryAsync('SELECT * FROM users WHERE userid = ?', [interaction.user.id]);
    let additional_autoextraction_slot = 0;
    if (userRows.length === 0) {
        await queryAsync('INSERT INTO users (userid, register_date) VALUES (?, ?)', [interaction.user.id, new Date().getTime()]);
    } else {
        additional_autoextraction_slot = userRows[0].additional_autoextraction_slot ?? 0;
    }

    const freeRows = await queryAsync('SELECT * FROM rss WHERE premium_flag = 0', []);
    const limit_free_check = freeRows.length < 175;
    if (!limit_free_check && additional_autoextraction_slot === 0) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '無料枠の登録は上限に達しているため追加できません。', color: 0x1DA1F2 }] });
    }

    const userFreeRows = await queryAsync('SELECT * FROM rss WHERE userid = ? AND premium_flag = 0', [interaction.user.id]);
    const over_5_check = userFreeRows.length < 5;
    if (!over_5_check && additional_autoextraction_slot === 0) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '5件以上の登録はできません。', color: 0x1DA1F2 }] });
    }

    const userPremiumRows = await queryAsync('SELECT * FROM rss WHERE userid = ? AND premium_flag = 1', [interaction.user.id]);
    const now_using_additional_autoextraction_slot = userPremiumRows.length;
    if (additional_autoextraction_slot !== 0 && (now_using_additional_autoextraction_slot >= additional_autoextraction_slot) && (!over_5_check || !limit_free_check)) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '支援者優先枠の登録上限に達しているため追加できません。', color: 0x1DA1F2 }] });
    } else if (additional_autoextraction_slot !== 0 && (now_using_additional_autoextraction_slot < additional_autoextraction_slot) && (over_5_check || limit_free_check)) {
        premium_flag = 1;
    }

    const username = interaction.options.getString('username');
    const webhooks = interaction.options.getString('webhook');
    const webhooks_array = (webhooks || '').split(',').map(webhook => webhook.trim()).filter(Boolean);
    if (username === null || webhooks_array.length === 0) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (!username.match(/^[0-9a-zA-Z_]+$/)) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたユーザーは無効です。\n[入力されたユーザー](https://twitter.com/' + username + ')', color: 0x1DA1F2 }] });
    }

    for (const webhook of webhooks_array) {
        if (!webhook.match(/^https:\/\/discord.com\/api\/webhooks\/[0-9]+\/[a-zA-Z0-9_-]+$/)) return await interaction.reply(invalidWebhookReply());
    }

    for (const webhook of webhooks_array) {
        const webhookResponse = await fetch(webhook, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [{
                    title: 'このチャンネルにツイートを送信します',
                    description: 'これはComebackTwitterEmbedの新着自動展開機能の登録確認メッセージです。\n今後このチャンネルに[' + username + '](https://twitter.com/' + username + ')のツイートが更新されるたびに通知を行います。',
                }],
            }),
        });
        if (webhookResponse.status !== 204) return await interaction.reply(invalidWebhookReply());
    }

    const registered = [];
    for (const webhook of webhooks_array) {
        await queryAsync('INSERT INTO rss (userid, username, lastextracted, webhook, created_at, premium_flag) VALUES (?, ?, ?, ?, ?, ?)', [interaction.user.id, username, new Date().getTime(), webhook, new Date().getTime(), premium_flag]);
        registered.push(webhook);
    }

    return await interaction.reply({
        embeds: [{
            title: 'Auto extract add',
            description: '登録が完了しました。\n[登録されたユーザー](https://twitter.com/' + username + ')' + (registered.length > 1 ? '\nWEBHOOK: ' + registered.length : ''),
            color: 0x1DA1F2,
        }],
    });
};
