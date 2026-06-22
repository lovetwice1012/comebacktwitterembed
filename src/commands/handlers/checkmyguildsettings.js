'use strict';

const { ApplicationCommandOptionType, PermissionsBitField } = require('discord.js');
const { t, messageLocales, descriptionLocales, commandNameLocales } = require('../../locales');
const { settings } = require('../../settings');
const { convertBoolToEnableDisable, conv_en_to_en_US } = require('../../utils');
module.exports.execute = async function (interaction, client) {

    if (interaction.options.getString('guildid') !== null && interaction.user.id !== '796972193287503913') return await interaction.reply(t('userDonthavePermissionLocales', interaction.locale));
    let guildid = interaction.guildId;
    if (interaction.options.getString('guildid') !== null) guildid = interaction.options.getString('guildid');
    let embed = {};
    embed.title = 'ギルド設定';
    embed.color = 0x1DA1F2;
    embed.fields = [];
    //無効化されているチャンネル
    if (settings.disable.channel[guildid] !== undefined) {
        let value = '';
        settings.disable.channel[guildid].forEach(element => {
            value += '<#' + element + '>\n';
        });
        embed.fields.push({
            name: '無効化されているチャンネル',
            value: value
        });
    }
    //無効化されているロール    
    if (settings.disable.role[guildid] !== undefined) {
        let value = '';
        settings.disable.role[guildid].forEach(element => {
            value += '<@&' + element + '>\n';
        });
        embed.fields.push({
            name: '無効化されているロール',
            value: value
        });
    }
    //動作モード
    if (settings.secondary_extract_mode[guildid] === true) {
        if (settings.secondary_extract_mode_multiple_images[guildid] === undefined) settings.secondary_extract_mode_multiple_images[guildid] = true;
        if (settings.secondary_extract_mode_video[guildid] === undefined) settings.secondary_extract_mode_video[guildid] = true;
        embed.fields.push({
            name: '動作モード',
            value: 'セカンダリ展開モード\n(設定した展開対象に一致するときにのみ動作)'
        });
        embed.fields.push({
            name: 'セカンダリー展開対象',
            value: '複数枚画像: ' + convertBoolToEnableDisable(settings.secondary_extract_mode_multiple_images[guildid], 'ja') + '\n動画: ' + convertBoolToEnableDisable(settings.secondary_extract_mode_video[guildid], 'ja')
        });
    } else if (settings.legacy_mode[guildid] === true) {
        embed.fields.push({
            name: '動作モード',
            value: 'レガシーモード\n(適切な権限設定がされていればdiscord純正の埋め込みが削除され、今まで通りの展開が行われる)'
        });
        //もし権限がない場合は注意を表示する
        if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            embed.fields.push({
                name: 'レガシーモードに関する注意',
                value: 'BOTにメッセージの管理権限を付与するとdiscord純正の埋め込みのみを削除して今まで通りの展開が行われます。\nこのBOTにメッセージの管理権限を付与することを検討してみてください。\n(使用感はdiscordがリンクの展開を修正する前と変わらなくなります。)'
            });
        }
    } else {
        embed.fields.push({
            name: '動作モード',
            value: '通常モード\n(常にリプライやりポスト、ライク数を表示し、複数枚の画像や動画も展開する)'
        });
    }
    //ツイートの展開
    if (settings.extract_bot_message[guildid] === true) {
        embed.fields.push({
            name: 'ツイートの展開',
            value: 'BOTの投稿も展開する'
        });
    } else {
        embed.fields.push({
            name: 'ツイートの展開',
            value: 'BOTの投稿は展開しない'
        });
    }
    //引用リツイートの展開
    if (settings.quote_repost_do_not_extract[guildid] === true) {
        embed.fields.push({
            name: '引用リツイートの展開',
            value: '引用リツイートは展開しない'
        });
    } else {
        embed.fields.push({
            name: '引用リツイートの展開',
            value: '引用リツイートも展開する'
        });
    }
    if (settings.anonymous_expand[guildid] === true) {
        embed.fields.push({
            name: '匿名展開',
            value: '有効'
        });
    } else {
        embed.fields.push({
            name: '匿名展開',
            value: '無効'
        });
    }
    //ボタンの非表示
    if (settings.button_invisible[guildid] !== undefined) {
        let value = '';
        if (settings.button_invisible[guildid].showMediaAsAttachments === true) value += '画像を添付ファイルとして表示するボタン\n';
        if (settings.button_invisible[guildid].showAttachmentsAsEmbedsImage === true) value += '埋め込みとして表示するボタン\n';
        if (settings.button_invisible[guildid].translate === true) value += '翻訳ボタン\n';
        if (settings.button_invisible[guildid].delete === true) value += '削除ボタン\n';
        if (value === '') value = 'なし';
        embed.fields.push({
            name: 'ボタンの非表示',
            value: value
        });
    }
    //ボタンの無効化
    if (settings.button_disabled[guildid] !== undefined) {
        let value = '';
        if (settings.button_disabled[guildid].user.length !== 0) {
            value += 'ユーザー\n';
            settings.button_disabled[guildid].user.forEach(element => {
                value += '<@' + element + '>\n';
            });
        }
        if (settings.button_disabled[guildid].channel.length !== 0) {
            value += 'チャンネル\n';
            settings.button_disabled[guildid].channel.forEach(element => {
                value += '<#' + element + '>\n';
            });
        }
        if (settings.button_disabled[guildid].role.length !== 0) {
            value += 'ロール\n';
            settings.button_disabled[guildid].role.forEach(element => {
                value += '<@&' + element + '>\n';
            });
        }
        if (value === '') value = 'なし';
        embed.fields.push({
            name: 'ボタンの無効化',
            value: value
        });
    }
    interaction.reply({ embeds: [embed] });

};

module.exports.definition = {
        name: 'checkmyguildsettings',
        name_localizations: conv_en_to_en_US(messageLocales.myGuildSettingsCommandNameLocales),
        description: 'check my guild settings',
        description_localizations: conv_en_to_en_US(descriptionLocales.settingsSaveTweetQuotaOverride),
        options: [
            {
                name: 'guild',
                name_localizations: conv_en_to_en_US(commandNameLocales.user),
                description: 'guild',
                type: ApplicationCommandOptionType.String,
                required: false
            }
        ]
    };
