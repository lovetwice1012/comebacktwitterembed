'use strict';

const fs = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');
const { TABLES, ensureDatabaseSchema } = require('../../../db_schema');

const TEST_SENT_GUILDS = new Set();
const TEST_WEBUI_USAGE_GUILDS = new Set();
const DEFAULT_DASHBOARD_BASE_URL = 'https://cbte.sprink.cloud';

function isTestMode() {
    return process.env.NODE_ENV === 'test';
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..', '..');
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'config.json'), 'utf8'));
    } catch {
        return {};
    }
}

function dashboardBaseUrl() {
    const config = readConfig();
    const dashboard = config.dashboard || {};
    const mediaDelivery = config.mediaDelivery || config.media_delivery || {};
    return (
        process.env.DASHBOARD_PUBLIC_BASE_URL
        || process.env.DASHBOARD_BASE_URL
        || process.env.NEXTAUTH_URL
        || dashboard.publicBaseUrl
        || dashboard.baseUrl
        || mediaDelivery.publicBaseUrl
        || config.publicBaseUrl
        || DEFAULT_DASHBOARD_BASE_URL
    ).replace(/\/+$/, '');
}

function dashboardSettingsUrl(guildId) {
    return `${dashboardBaseUrl()}/dashboard/${encodeURIComponent(guildId)}/settings`;
}

function localText(locale) {
    const normalized = String(locale || '').toLowerCase();
    if (normalized === 'ja' || normalized.startsWith('ja-')) {
        return {
            title: 'Web UIでもっと細かく設定できます',
            description: [
                '`/settings` で変更できる項目に加えて、Web UIでは高度なカスタマイズや詳細設定をまとめて編集できます。',
                'provider横断検索、出力プレビュー、一括設定、コマンド未対応の表示調整などをブラウザから確認できます。',
                '今後、`/settings` サブコマンドによる設定変更はサポートされなくなる予定があるため、Web UIへの移行をおすすめします。',
            ].join('\n'),
            fields: [
                {
                    name: '開く',
                    value: `[サーバー設定Dashboard](${dashboardSettingsUrlPlaceholder})`,
                    inline: false,
                },
            ],
            footer: 'このお知らせは、Web UIの利用痕跡がないサーバーで初回のみ表示されます。',
        };
    }

    return {
        title: 'Use the Web UI for deeper settings',
            description: [
                'The Web UI lets you edit advanced customization and detailed settings that are not available from `/settings`.',
                'You can use cross-provider search, output preview, bulk settings, and display controls from your browser.',
                '`/settings` subcommand-based configuration may stop being supported in the future, so moving to the Web UI is recommended.',
            ].join('\n'),
        fields: [
            {
                name: 'Open',
                value: `[Server settings dashboard](${dashboardSettingsUrlPlaceholder})`,
                inline: false,
            },
        ],
        footer: 'This notice is shown only once for servers with no Web UI usage yet.',
    };
}

function buildSettingsWebuiNoticeEmbed(guildId, locale = 'en-US') {
    const url = dashboardSettingsUrl(guildId);
    const text = localText(locale);
    return {
        title: text.title,
        url,
        description: text.description,
        color: 0x1DA1F2,
        fields: text.fields.map(field => ({
            ...field,
            value: field.value.replace(dashboardSettingsUrlPlaceholder, url),
        })),
        footer: { text: text.footer },
    };
}

function hasPermission(permissions, flag) {
    if (!permissions) return false;
    if (typeof permissions.has === 'function') return permissions.has(flag);
    try {
        return new PermissionsBitField(BigInt(permissions)).has(flag);
    } catch {
        return false;
    }
}

function hasSettingsPermission(interaction) {
    const permissions = interaction.memberPermissions || interaction.member?.permissions;
    return (
        hasPermission(permissions, PermissionsBitField.Flags.ManageChannels)
        || hasPermission(permissions, PermissionsBitField.Flags.ManageGuild)
        || hasPermission(permissions, PermissionsBitField.Flags.Administrator)
    );
}

async function claimNoticeForTest(guildId) {
    if (TEST_WEBUI_USAGE_GUILDS.has(guildId) || TEST_SENT_GUILDS.has(guildId)) return false;
    TEST_SENT_GUILDS.add(guildId);
    return true;
}

async function claimNoticeForGuild(guildId, userId) {
    if (isTestMode()) return await claimNoticeForTest(guildId);

    const { queryDatabase } = require('../../../db');
    await ensureDatabaseSchema();

    const dashboardRows = await queryDatabase(
        `SELECT audit_log_id
         FROM ${TABLES.dashboardAuditLogs}
         WHERE guild_id = ?
         LIMIT 1`,
        [guildId]
    );
    if (dashboardRows.length > 0) return false;

    await queryDatabase(
        `INSERT INTO ${TABLES.guilds} (guild_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE guild_id = guild_id`,
        [guildId]
    );

    const result = await queryDatabase(
        `INSERT IGNORE INTO ${TABLES.guildSettingsWebuiNoticeState}
         (guild_id, sent_at_ms, command_user_id)
         VALUES (?, ?, ?)`,
        [guildId, Date.now(), userId || null]
    );
    return Number(result?.affectedRows || 0) === 1;
}

async function maybeSendSettingsWebuiNotice(interaction) {
    if (!interaction?.guildId || !hasSettingsPermission(interaction)) return false;
    if (typeof interaction.followUp !== 'function') return false;

    try {
        const claimed = await claimNoticeForGuild(interaction.guildId, interaction.user?.id);
        if (!claimed) return false;
        await interaction.followUp({
            embeds: [buildSettingsWebuiNoticeEmbed(interaction.guildId, interaction.locale)],
            ephemeral: true,
        });
        return true;
    } catch (err) {
        console.warn('[settings.webuiNotice] failed to send notice:', err?.message || err);
        return false;
    }
}

function resetTestState() {
    TEST_SENT_GUILDS.clear();
    TEST_WEBUI_USAGE_GUILDS.clear();
}

function markTestWebuiUsage(guildId) {
    TEST_WEBUI_USAGE_GUILDS.add(guildId);
}

const dashboardSettingsUrlPlaceholder = '__DASHBOARD_SETTINGS_URL__';

module.exports = {
    dashboardBaseUrl,
    dashboardSettingsUrl,
    maybeSendSettingsWebuiNotice,
    _internal: {
        buildSettingsWebuiNoticeEmbed,
        dashboardBaseUrl,
        dashboardSettingsUrl,
        hasSettingsPermission,
        markTestWebuiUsage,
        resetTestState,
        TEST_SENT_GUILDS,
        TEST_WEBUI_USAGE_GUILDS,
    },
};
