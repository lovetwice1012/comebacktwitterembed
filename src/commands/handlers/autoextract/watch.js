'use strict';

const { provider } = require('../../../providers/autoWatch');
const { registerTarget, validateWebhook, assertRegistrationAllowed } = require('../../../providers/autoWatch/store');
const { createWebhookForChannel } = require('../../../components/_webhookDestination');
const { failureReason } = require('../../../userFacingErrors');
const { recordError } = require('../../../errorTracking');
const db = require('../../../db');
const { withRateOperation } = require('../../../automation/rate-operation');

function localized(locale, japanese, english) {
    return String(locale || '').toLowerCase().startsWith('ja') ? japanese : english;
}

function errorReply(locale, message) {
    return {
        embeds: [{
            title: localized(locale, '新着通知の登録', 'Auto watch'),
            description: localized(locale, `登録できませんでした: ${message}`, `Registration failed: ${message}`),
            color: 0xe74c3c,
        }],
    };
}

module.exports = async function (interaction) {
    const providerId = interaction.options.getString('provider');
    const source = interaction.options.getString('source');
    const destination = interaction.options.getString('destination') || 'webhook';
    let webhookUrl = interaction.options.getString('webhook');
    if (!providerId || !source || !interaction.guildId) {
        return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale, 'サーバー内でプロバイダーと監視対象を指定してください。', 'Use this command in a server and provide a provider and source.')));
    }

    if (interaction.options.getBoolean?.('responsibility') !== true) {
        return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale,
            '内容・権利・通知先を確認し、responsibility を true にしてください。機械チェックは適法性や安全性を保証しません。',
            'Confirm content, rights and destination and set responsibility to true. Mechanical checks do not guarantee legality or safety.')));
    }
    /** @type {import('discord.js').Webhook | null} */
    let createdWebhook = null;
    try {
        await require('../../../db_schema').ensureDatabaseSchema();
        return await withRateOperation(db, { userId: interaction.user.id }, 'monitor', async () => {
        await assertRegistrationAllowed(interaction.user.id);
        if (!['dm', 'webhook', 'channel'].includes(destination)) {
            return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale, '通知先が不正です。', 'Invalid notification destination.')));
        }
        let destinationType = destination === 'dm' ? 'dm' : 'webhook';
        let destinationLabel = localized(interaction.locale, 'DM', 'DM');
        if (destination === 'channel') {
            const channel = interaction.options.getChannel('channel');
            if (!channel?.id) return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale, 'Webhookを作成するチャンネルを指定してください。', 'Select a channel where the bot can create a webhook.')));
            const created = await createWebhookForChannel(interaction, channel.id, 'ComebackTwitterEmbed auto watch');
            createdWebhook = created.webhook;
            webhookUrl = created.webhookUrl;
            destinationLabel = localized(interaction.locale, `チャンネル #${created.channel.name || created.channel.id}`, `Channel #${created.channel.name || created.channel.id}`);
        }
        if (destinationType === 'webhook') {
            const webhook = await validateWebhook(webhookUrl);
            if (webhook.guildId !== interaction.guildId) {
                return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale, 'Webhookはこのサーバーのものではありません。', 'The webhook belongs to another server.')));
            }
            if (destination === 'webhook') destinationLabel = localized(interaction.locale, '指定Webhook', 'Specified webhook');
        }
        const result = await registerTarget({
            userId: interaction.user.id,
            providerId,
            source,
            destinationType,
            webhookUrl,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            channelNsfw: interaction.channel?.nsfw === true,
            sourceLocale: interaction.locale,
        });
        const adapter = provider(result.providerId);
        const initial = result.initialCheckNotBeforeMs
            ? localized(interaction.locale, `<t:${Math.floor(result.initialCheckNotBeforeMs / 1000)}:R> に初回確認し、既存投稿は送信しません。`, `The first check is <t:${Math.floor(result.initialCheckNotBeforeMs / 1000)}:R> and will not post historical items.`)
            : localized(interaction.locale, 'この監視対象はすでに初期化されています。', 'This watch source has already been initialized.');
        return await interaction.editReply({
            embeds: [{
                title: localized(interaction.locale, '新着通知を登録しました', 'Auto watch registered'),
                description: [
                    localized(interaction.locale, `ID: ${result.id}`, `ID: ${result.id}`),
                    `${adapter.label}: ${result.sourceUrl}`,
                    localized(interaction.locale, `通知先: ${destinationLabel}`, `Destination: ${destinationLabel}`),
                    initial,
                    result.destinationType === 'dm'
                        ? localized(interaction.locale, '新着は機械チェックと通知ルールを通して直接DMへ送ります。', 'New items will be sent directly in DM after mechanical checks and notification rules.')
                        : localized(interaction.locale, '機械チェックと通知ルールを通して、指定Webhookへ直接送ります。', 'Checked notifications will be sent directly to the selected webhook according to their rules.'),
                ].join('\n'),
                color: 0x1DA1F2,
            }],
        });
        });
    } catch (error) {
        try { await createdWebhook?.delete?.(); } catch { /* keep the original registration failure */ }
        if (error?.code === 'AUTOMATION_RATE_LIMITED') {
            const hour = error.windowMs === 3600000, limit = Number.isSafeInteger(error.limit) ? error.limit : hour ? 120 : 10;
            const seconds = Math.ceil((Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 60000) / 1000);
            return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale,
                `通知の登録・変更は${hour ? '1時間' : '1分'}に${limit}件までです。${seconds}秒後に再度お試しください。`,
                `Notification registration and changes are limited to ${limit} per ${hour ? 'hour' : 'minute'}. Try again in ${seconds} seconds.`)));
        }
        if (error?.code === 'AUTOMATION_SLOT_LIMIT') return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale,
            '通知枠の上限に達しています。新着・価格の登録を合わせて確認し、不要な登録を削除してください。一時停止中も枠を使用します。',
            'Your shared notification slots are full. Delete an unused auto or price registration; paused registrations still occupy a slot.')));
        if (error?.code === 'AUTOMATION_RATE_LIMIT_UNAVAILABLE') return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale,
            '利用制限を確認できませんでした。少し待ってから再度お試しください。', 'Usage limits could not be verified. Please try again shortly.')));
        recordError(error, { source: 'autoextract.watch', providerId, guildId: interaction.guildId, userId: interaction.user.id });
        const code = String(error?.code || '');
        const explanation = code === 'AUTO_WATCH_INVALID_SOURCE'
            ? localized(interaction.locale, require('../../../automation/monitor-input').sourceGuidance(providerId).help, 'Use an account profile or channel URL rather than a single post.')
            : code === 'AUTO_WATCH_SLOT_LIMIT' ? localized(interaction.locale, '登録できる監視枠がありません。不要な監視を削除してから再度登録してください。一時停止中も枠を使用します。', 'No watch slots remain. Delete an unused watch before registering another; paused watches still occupy a slot.')
                : code === 'AUTO_WATCH_INVALID_WEBHOOK' ? localized(interaction.locale, '通知先のWebhookを確認してください。DMを選ぶとWebhookなしで登録できます。', 'Check the destination webhook, or choose DM to register without a webhook.')
                    : failureReason(error, interaction.locale);
        return await interaction.editReply(errorReply(interaction.locale, explanation));
    }
};

module.exports._internal = { errorReply, localized };
