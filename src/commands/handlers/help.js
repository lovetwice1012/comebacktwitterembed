'use strict';

const { t, descriptionLocales, commandNameLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
const { dashboardBaseUrl, dashboardSettingsUrl } = require('./settings/webuiNotice');

function isJapanese(locale) {
    const normalized = String(locale || '').toLowerCase();
    return normalized === 'ja' || normalized.startsWith('ja-');
}

function webuiField(interaction) {
    const ja = isJapanese(interaction.locale);
    const url = interaction.guildId ? dashboardSettingsUrl(interaction.guildId) : `${dashboardBaseUrl()}/dashboard`;
    return {
        name: ja ? 'Web UI' : 'Web UI',
        value: ja
            ? [
                `[設定Dashboard](${url}) では、コマンドではできない高度なカスタマイズや詳細設定をブラウザから行えます。`,
                '`/settings` サブコマンドによる設定変更は、今後サポートされなくなる予定があります。',
            ].join('\n')
            : [
                `[Settings dashboard](${url}) lets you configure advanced customization and detailed settings from your browser.`,
                '`/settings` subcommand-based configuration may stop being supported in the future.',
            ].join('\n'),
    };
}

function buildHelpPayload(interaction) {
    return {
        embeds: [
            {
                title: 'Help',
                description: t('helpDiscriptionLocales', interaction.locale),
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'Commands',
                        value: t('helpCommandsLocales', interaction.locale)
                    },
                    webuiField(interaction),
                    {
                        name: isJapanese(interaction.locale) ? 'あとで見る・個人通知' : 'Saved links and personal notifications',
                        value: isJapanese(interaction.locale)
                            ? '展開カードの「あとで見る」「あとで通知」、BOOTHの「再入荷を待つ」から登録できます。`/saved` で保存の検索・編集・削除、`/remind` と `/restock` で通知の一覧・解除ができます。一覧は本人だけに表示され、通知はDMに届きます。'
                            : 'Use Save for later, Remind me, or BOOTH Watch restock on expanded cards. /saved searches and edits saved links; /remind and /restock list or cancel notifications. Lists are private and alerts arrive by DM.',
                    },
                    {
                        name: isJapanese(interaction.locale) ? '展開の確認・再試行' : 'Expansion status and retry',
                        value: isJapanese(interaction.locale)
                            ? 'URLを貼った元の投稿のメニュー →「アプリ」から「展開状況を確認」「展開を再試行」を選べます。再試行は投稿者またはメッセージ管理権限を持つ人が実行できます。'
                            : 'Open the original link post’s menu → Apps → Expansion status or Retry expansion. Only the author or a member with Manage Messages can retry.',
                    },
                ]
            }
        ]
    };
}

module.exports.execute = async function (interaction, client) {
    await interaction.editReply(buildHelpPayload(interaction));

};

module.exports.definition = {
        name: 'help',
        name_localizations: conv_en_to_en_US(commandNameLocales.help),
        description: 'Shows help message.',
        description_localizations: conv_en_to_en_US(descriptionLocales.helpcommand)
    };

module.exports._internal = {
    buildHelpPayload,
    webuiField,
};
