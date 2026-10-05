'use strict';

const { queryDatabase } = require('../../../db');
const { TABLES } = require('../../../db_schema');
const { sendEmbedPages } = require('../../../interactionResponse');
const { listTargets } = require('../../../providers/autoWatch/store');

function timestamp(value, fallback) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? `<t:${Math.floor(ms / 1000)}:R>` : fallback;
}

function watchLine(item, ja) {
    const active = item.enabled !== false;
    const failed = Number(item.failureCount) > 0;
    const state = !active ? (ja ? '停止中' : 'Paused')
        : failed ? (/RATE_LIMIT/i.test(item.lastErrorCode || '') ? (ja ? '取得制限で待機中' : 'Waiting for rate limit')
            : (ja ? '取得失敗・再試行待ち' : 'Fetch failed; retry scheduled'))
            : !item.lastCheckedAtMs ? (ja ? '初回確認待ち' : 'Waiting for first check') : (ja ? '稼働中' : 'Active');
    const destination = item.destinationType === 'dm' ? 'DM' : `Webhook #${item.webhookEndpointId}`;
    return `**${item.providerId} / ${item.id} — ${state}**\n${item.sourceUrl}\n`
        + `${ja ? '通知先' : 'Destination'}: ${destination} · ${ja ? '最終確認' : 'Last check'}: ${timestamp(item.lastCheckedAtMs, ja ? '未確認' : 'Not yet checked')}`
        + ` · ${ja ? '次回確認' : 'Next check'}: ${active ? timestamp(item.nextCheckAtMs, ja ? '調整中' : 'Pending') : '—'}\n`;
}

module.exports = async function (interaction, client) {
    const ja = String(interaction.locale || '').startsWith('ja');
    const [legacy, watches] = await Promise.all([
        queryDatabase(
            `SELECT t.id, t.twitter_username, t.webhook_endpoint_id
         FROM ${TABLES.autoExtractTargets} t
         INNER JOIN ${TABLES.webhookEndpoints} w ON w.id = t.webhook_endpoint_id
         WHERE t.user_id = ? AND t.enabled = 1
         ORDER BY t.id`,
            [interaction.user.id]
        ),
        listTargets(interaction.user.id),
    ]);

    if (legacy.length === 0 && watches.length === 0) {
        return await interaction.editReply({ embeds: [{ title: ja ? '自動監視一覧' : 'Auto watch list', description: ja ? '自動監視はまだ登録されていません。/autoextract watch から追加できます。' : 'No auto watch entries are registered. Use /autoextract watch to add one.', color: 0x1DA1F2 }] });
    }

    const lines = [
        ...watches.map(item => watchLine(item, ja)),
        ...legacy.map(item => `Twitter ${item.id}: [@${item.twitter_username}](https://twitter.com/${item.twitter_username}) (${ja ? '新規登録は停止中・既存登録' : 'existing registration; new registrations paused'}; Webhook #${item.webhook_endpoint_id})`),
    ];
    await sendEmbedPages(interaction, {
        title: ja ? '自動監視一覧' : 'Auto watch list',
        lines,
        emptyDescription: 'No auto watch entries are registered.',
        color: 0x1DA1F2,
        ephemeralFollowUps: true,
    });
};

module.exports._internal = { watchLine, timestamp };
