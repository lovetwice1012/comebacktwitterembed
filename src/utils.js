'use strict';

const fs = require('fs');
const path = require('path');

// 動画拡張子。embed の判定で使用。
const videoExtensions = [
    'mp4', 'mov', 'wmv', 'avi', 'avchd', 'flv', 'f4v', 'swf',
    'mkv', 'webm', 'm4v', '3gp', '3g2', 'mxf', 'roq', 'nsv',
    'gifv', 'gif', 'ts', 'm2ts', 'mts', 'vob',
];

// ボタン非表示・無効化テンプレート (デフォルト形)。
const button_disabled_template = {
    user: [], // user id
    channel: [], // channel id
    role: [], // role id
};

const button_invisible_template = {
    showMediaAsAttachments: false,
    showAttachmentsAsEmbedsImage: false,
    translate: false,
    delete: false,
    all: false,
};

// 既に終了予告された旧インスタンス用警告 embed (現状未参照だが保持)。
const warning_this_bot_is_not_main_instance_and_going_to_be_closed_embed = {
    ja: {
        title: '警告',
        description: 'このbotはメインインスタンス(ComebackTwitterEmbed#3134)ではありません。\nメインインスタンスが認証を受けたため、このbotは72時間以内に削除されます。\nこの[リンク](https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877966336&scope=bot%20applications.commands)よりメインインスタンスをサーバーに導入し、このbotをキックしてください。\n移行期限\n<t:1700208003:F>\n期限まで残り\n<t:1700208003:R>',
        color: 0xFF0000,
    },
    en: {
        title: 'Warning',
        description: 'This bot is not the main instance (ComebackTwitterEmbed#3134).\nThis bot will be deleted within 72 hours because the main instance has been verified.\nInstall the main instance on your server from this [link](https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877966336&scope=bot%20applications.commands) and kick this bot.\ndeadline:\n<t:1700208003:F>\nremain:\n<t:1700208003:R>',
        color: 0xFF0000,
    },
};

function antiDirectoryTraversalAttack(userInput) {
    const baseDirectory = path.resolve('saves');
    const invalidPathPattern = /(\.\.(\/|\\|$))/;
    const joinedPath = path.join(baseDirectory, userInput);
    let realPath;
    try {
        realPath = fs.realpathSync(joinedPath);
    } catch (err) {
        throw new Error('不正なパスが検出されました。');
    }
    const relativePath = path.relative(baseDirectory, realPath);
    if (
        userInput.includes('\0') ||
        invalidPathPattern.test(userInput) ||
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath) ||
        relativePath.includes('\0') ||
        !realPath.startsWith(baseDirectory)
    ) {
        throw new Error('不正なパスが検出されました。');
    }
    return realPath;
}

function ifUserHasRole(user, roleidlist) {
    return user.roles.cache.some(role => roleidlist.includes(role.id));
}

function convertBoolToEnableDisable(bool, locale) {
    const labels = { ja: ['無効', '有効'], en: ['Disable', 'Enable'] };
    return (labels[locale] ?? labels.en)[bool ? 1 : 0];
}

function discordErrorCode(err) {
    return err?.code ?? err?.rawError?.code;
}

function isUnknownMessageError(err) {
    return discordErrorCode(err) === 10008;
}

function isUnknownInteractionError(err) {
    return discordErrorCode(err) === 10062;
}

function isInteractionAlreadyAcknowledgedError(err) {
    return discordErrorCode(err) === 40060;
}

function isIgnorableInteractionAckError(err) {
    return isUnknownInteractionError(err) || isInteractionAlreadyAcknowledgedError(err);
}

function isMissingPermissionsError(err) {
    const code = discordErrorCode(err);
    return code === 50001 || code === 50013;
}

async function sendContentPromise(message, content) {
    return new Promise((resolve, reject) => {
        if (content.length == 0) return resolve();
        message.channel.send(content.join('\n')).then(() => resolve()).catch(reject);
    });
}

// commandLocalizations / descriptionLocalizations 用。`en` を `en-US` にリネーム。
function conv_en_to_en_US(obj) {
    return require('./i18n').toDiscordLocalizations(obj);
}

function cleanMessageContent(content) {
    // 後方互換: src/providers/_loader.cleanContent() に委譲。
    // 全プロバイダの cleanPattern を順に適用して `<URL>` / `||URL||` を除去する。
    return require('./providers/_loader').cleanContent(content);
}

function extractTwitterUrls(content) {
    // 後方互換: 全プロバイダから URL を抽出する。
    // 命名は歴史的経緯で twitter のままだが、対象は登録済みの全サイト。
    return require('./providers/_loader').extractAllUrls(content).map(e => e.url);
}

module.exports = {
    videoExtensions,
    button_disabled_template,
    button_invisible_template,
    warning_this_bot_is_not_main_instance_and_going_to_be_closed_embed,
    antiDirectoryTraversalAttack,
    ifUserHasRole,
    convertBoolToEnableDisable,
    discordErrorCode,
    isUnknownMessageError,
    isUnknownInteractionError,
    isInteractionAlreadyAcknowledgedError,
    isIgnorableInteractionAckError,
    isMissingPermissionsError,
    sendContentPromise,
    conv_en_to_en_US,
    cleanMessageContent,
    extractTwitterUrls,
};
