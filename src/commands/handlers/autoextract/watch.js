'use strict';

const { provider } = require('../../../providers/autoWatch');
const { registerTarget, validateWebhook, assertRegistrationAllowed } = require('../../../providers/autoWatch/store');
const { createWebhookForChannel } = require('../../../components/_webhookDestination');

function localized(locale, japanese, english) {
    return String(locale || '').toLowerCase().startsWith('ja') ? japanese : english;
}

function errorReply(locale, message) {
    return {
        embeds: [{
            title: 'Auto watch',
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
    let createdWebhook = null;
    try {
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
                title: 'Auto watch registered',
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
    } catch (error) {
        try { await createdWebhook?.delete?.(); } catch { /* keep the original registration failure */ }
        if (error?.code === 'AUTO_WATCH_DONOR_REQUIRED') {
            return await interaction.editReply(errorReply(interaction.locale, localized(interaction.locale,
                '新着自動展開の登録は寄付者のみ利用できます。',
                'New-post automatic expansion registration is available to donors only.')));
        }
        return await interaction.editReply(errorReply(interaction.locale, error?.message || String(error)));
    }
};

module.exports._internal = { errorReply, localized };
