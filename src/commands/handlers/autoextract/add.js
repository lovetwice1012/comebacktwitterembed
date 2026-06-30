'use strict';

const { t } = require('../../../locales');
const { ensureUserExistsInDatabase, queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');
const crypto = require('crypto');
const fetch = require('node-fetch');

const FREE_SLOT_LIMIT = 175;
const USER_FREE_SLOT_LIMIT = 5;

async function countRows(sql, params) {
    const rows = await queryDatabase(sql, params);
    return rows[0]?.total ?? 0;
}

async function ensureTwitterAccount(username) {
    await queryDatabase(
        `INSERT INTO ${TABLES.twitterAccounts} (twitter_username)
         VALUES (?)
         ON DUPLICATE KEY UPDATE twitter_username = twitter_username`,
        [username]
    );
}

async function ensureWebhookEndpoint(webhookUrl) {
    const hash = crypto.createHash('sha256').update(webhookUrl).digest('hex');
    const result = await queryDatabase(
        `INSERT INTO ${TABLES.webhookEndpoints} (webhook_url_hash, webhook_url)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), webhook_url = VALUES(webhook_url)`,
        [hash, webhookUrl]
    );
    return result.insertId;
}

function invalidWebhookReply() {
    return {
        embeds: [{
            title: 'Auto extract add',
            description: 'The specified webhook is invalid.',
            color: 0x1DA1F2,
        }],
    };
}

module.exports = async function (interaction) {
    let premium_flag = 0;

    await ensureUserExistsInDatabase(interaction.user.id);
    const userRows = await queryDatabase(
        `SELECT additional_auto_extract_slots FROM ${TABLES.users} WHERE user_id = ?`,
        [interaction.user.id]
    );
    const additional_autoextraction_slot = userRows[0]?.additional_auto_extract_slots ?? 0;

    const freeUsed = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE premium_slot = 0 AND enabled = 1`,
        []
    );
    const limit_free_check = freeUsed < FREE_SLOT_LIMIT;
    if (!limit_free_check && additional_autoextraction_slot === 0) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: 'The free auto extract slots are full.', color: 0x1DA1F2 }] });
    }

    const userFreeUsed = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE user_id = ? AND premium_slot = 0 AND enabled = 1`,
        [interaction.user.id]
    );
    const over_5_check = userFreeUsed < USER_FREE_SLOT_LIMIT;
    if (!over_5_check && additional_autoextraction_slot === 0) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: 'You cannot register more than 5 free auto extracts.', color: 0x1DA1F2 }] });
    }

    const now_using_additional_autoextraction_slot = await countRows(
        `SELECT COUNT(*) AS total FROM ${TABLES.autoExtractTargets} WHERE user_id = ? AND premium_slot = 1 AND enabled = 1`,
        [interaction.user.id]
    );
    if (additional_autoextraction_slot !== 0 && (now_using_additional_autoextraction_slot >= additional_autoextraction_slot) && (!over_5_check || !limit_free_check)) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: 'Your additional auto extract slots are full.', color: 0x1DA1F2 }] });
    } else if (additional_autoextraction_slot !== 0 && (now_using_additional_autoextraction_slot < additional_autoextraction_slot) && (over_5_check || limit_free_check)) {
        premium_flag = 1;
    }

    const username = interaction.options.getString('username');
    const webhooks = interaction.options.getString('webhook');
    const webhooks_array = (webhooks || '').split(',').map(webhook => webhook.trim()).filter(Boolean);
    if (username === null || webhooks_array.length === 0) return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    if (!username.match(/^[0-9a-zA-Z_]+$/)) {
        return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: 'The specified Twitter username is invalid.\n[Input](https://twitter.com/' + username + ')', color: 0x1DA1F2 }] });
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
                    title: 'Auto extract registered',
                    description: 'ComebackTwitterEmbed will post updates for [' + username + '](https://twitter.com/' + username + ') to this channel.',
                }],
            }),
        });
        if (webhookResponse.status !== 204) return await interaction.reply(invalidWebhookReply());
    }

    const registered = [];
    await ensureTwitterAccount(username);
    for (const webhook of webhooks_array) {
        const webhookEndpointId = await ensureWebhookEndpoint(webhook);
        await queryDatabase(
            `INSERT INTO ${TABLES.autoExtractTargets}
             (user_id, twitter_username, webhook_endpoint_id, last_extracted_at_ms, created_at_ms, premium_slot)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                enabled = 1,
                premium_slot = VALUES(premium_slot),
                last_extracted_at_ms = VALUES(last_extracted_at_ms)`,
            [interaction.user.id, username, webhookEndpointId, Date.now(), Date.now(), premium_flag]
        );
        registered.push(webhook);
    }

    return await interaction.reply({
        embeds: [{
            title: 'Auto extract add',
            description: 'Registration completed.\n[Registered user](https://twitter.com/' + username + ')' + (registered.length > 1 ? '\nWEBHOOK: ' + registered.length : ''),
            color: 0x1DA1F2,
        }],
    });
};
