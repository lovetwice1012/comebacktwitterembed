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
