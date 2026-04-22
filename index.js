//discord.js v14
const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel], shards: 'auto' });
const config = require('./config.json');
const fetch = require('node-fetch');
const fs = require('fs');
const { send } = require('process');
const mysql = require('mysql');
const https = require('https');
const e = require('express');
const path = require('path');
const URL = config.URL
const { WebhookClient } = require('discord.js');
const webhookClient = new WebhookClient({ url: URL });

let text = '';
process.stdout.write = (write => function (string, encoding, fd) {
    text += string;
    write.apply(process.stdout, arguments);
})(process.stdout.write);

process.stderr.write = (write => function (string, encoding, fd) {
    text += string;
    write.apply(process.stderr, arguments);
})(process.stderr.write);

const connection = mysql.createConnection({
    host: '192.168.100.22',
    user: 'comebacktwitterembed',
    password: 'bluebird',
    database: 'ComebackTwitterEmbed'
});
/*
// MySQLに接続
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        return;
    }
    console.log('Connected to database');
});
*/

let processed = 0;
let processed_hour = 0;
let processed_day = 0;

const must_be_main_instance = true;

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

if (!fs.existsSync('./settings.json')) {
    fs.writeFileSync('./settings.json', JSON.stringify({
        "disable": {
            "user": [],
            "channel": [],
            "role": {},
        },
        "bannedWords": {},
        "defaultLanguage": {},
        "editOriginalIfTranslate": {},
        "sendMediaAsAttachmentsAsDefault": {},
        "deletemessageifonlypostedtweetlink": {},
        "alwaysreplyifpostedtweetlink": {},
        "button_invisible": {},
        "button_disabled": {},
        "extract_bot_message": {},
        "quote_repost_do_not_extract": {},
        "legacy_mode": {},
        "passive_mode": {},
        "secondary_extract_mode": {},
        "secondary_extract_mode_multiple_images": {},
        "secondary_extract_mode_video": {},
        "save_tweet_quota_override": {},
        "deletemessageifonlypostedtweetlink_secoundaryextractmode": {},
    }, null, 4));
}
const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));

if (settings.disable.role === undefined) {
    settings.disable.role = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.defaultLanguage === undefined) {
    settings.defaultLanguage = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.editOriginalIfTranslate === undefined) {
    settings.editOriginalIfTranslate = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.sendMediaAsAttachmentsAsDefault === undefined) {
    settings.sendMediaAsAttachmentsAsDefault = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.deletemessageifonlypostedtweetlink === undefined) {
    settings.deletemessageifonlypostedtweetlink = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.alwaysreplyifpostedtweetlink === undefined) {
    settings.alwaysreplyifpostedtweetlink = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.button_invisible === undefined) {
    settings.button_invisible = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.button_disabled === undefined) {
    settings.button_disabled = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.extract_bot_message === undefined) {
    settings.extract_bot_message = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.quote_repost_do_not_extract === undefined) {
    settings.quote_repost_do_not_extract = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.legacy_mode === undefined) {
    settings.legacy_mode = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.passive_mode === undefined) {
    settings.passive_mode = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.secondary_extract_mode === undefined) {
    settings.secondary_extract_mode = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.secondary_extract_mode_multiple_images === undefined) {
    settings.secondary_extract_mode_multiple_images = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.secondary_extract_mode_video === undefined) {
    settings.secondary_extract_mode_video = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.save_tweet_quota_override === undefined) {
    settings.save_tweet_quota_override = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.deletemessageifonlypostedtweetlink_secoundaryextractmode === undefined) {
    settings.deletemessageifonlypostedtweetlink_secoundaryextractmode = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.quote_repost_max_depth === undefined) {
    settings.quote_repost_max_depth = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

const button_disabled_template = {
    user: [], //user id
    channel: [], //channel id
    role: [] //role id
}

const button_invisible_template = {
    showMediaAsAttachments: false,
    showAttachmentsAsEmbedsImage: false,
    translate: false,
    delete: false,
    all: false
}

const showAttachmentsAsEmbedsImagebuttonLocales = {
    ja: '画像を埋め込み画像として表示する',
    en: 'Show media in embeds image'
}

const showMediaAsAttachmentsButtonLocales = {
    ja: 'メディアを添付ファイルとして表示する',
    en: 'Show media as attachments'
}

const finishActionLocales = {
    ja: '操作を完了しました。',
    en: 'Finished action.'
}

const helpTitleLocales = {
    ja: 'ヘルプ',
    en: 'Help'
}

const helpcommandDiscriptionLocales = {
    ja: 'ヘルプメッセージを表示します。',
    en: 'Shows help message.'
}

const helpDiscriptionLocales = {
    ja: '特別な設定は必要なく、ツイートリンクを投稿するだけで使用することができます。\n\nこのbotは、あなたが送信したメッセージの内容を確認することができます。\nあなたが送信したメッセージにtwitterのリンクが含まれているかどうかを確認するためだけに使用され、それ以外の目的で使用されることはありません。\nまた、あなたが送信したメッセージを記録することもありません。\n私たちを信頼できない場合は、このbotからチャンネルの閲覧権限を削除することで安全を確保することができます。',
    en: 'No special setup is required, just post the tweet link.\n\nThis bot can check the contents of messages you have sent.\nIt will only be used to check if the message you sent contains a twitter link, and will not be used for any other purpose.\nIt will not be used for any other purpose, nor will it record the messages you send.\nIf you do not trust us, you can secure your safety by removing your channel permissions from this bot.'
}

const helpCommandsLocales = {
    ja: '`/ping` - Pong!\n`/help` - ヘルプメッセージを表示します。\n`/invite` - このbotをあなたのサーバーに招待するためのリンクを表示します\n`/support` - サポートサーバーに参加するためのリンクを表示します\n`/settings` - 設定を変更します',
    en: '`/ping` - Pong!\n`/help` - Shows help message.\n`/invite` - Invite me to your server!\n`/support` - Join support server!\n`/settings` - chenge Settings'
}

const settingsDisableDiscriptionLocales = {
    ja: 'ユーザーまたはチャンネルを指定して無効化します。',
    en: 'Disable by user or channel.'
}

const settingsBannedWordsDiscriptionLocales = {
    ja: '禁止ワードを追加または削除します。',
    en: 'Add or remove banned words.'
}

const settingsDisableUserDiscriptionLocales = {
    ja: '無効化するユーザーを指定します。',
    en: 'Specify the user to disable.'
}

const settingsDisableChannelDiscriptionLocales = {
    ja: '無効化するチャンネルを指定します。',
    en: 'Specify the channel to disable.'
}

const settingsBannedWordsWordDiscriptionLocales = {
    ja: '禁止ワードを指定します。',
    en: 'Specify the banned word.'
}

const userDonthavePermissionLocales = {
    ja: 'このコマンドを使用する権限がありません。',
    en: 'You don\'t have permission to use this command.'
}

const userCantUseThisCommandForOtherUsersLocales = {
    ja: 'ユーザーにあなた以外のユーザーを指定することはできません。',
    en: 'You can\'t use this command for other users.'
}

const userCantDeleteThisMessageLocales = {
    ja: 'このメッセージを削除することはできません。',
    en: 'You can\'t delete this message.'
}

const userMustSpecifyAUserOrChannelLocales = {
    ja: 'ユーザーまたはチャンネル、ロールのうち一つを指定する必要があります。',
    en: 'You must specify a user or channel or role.'
}

const userCantSpecifyBothAUserAndAChannelLocales = {
    ja: '複数のオプションを指定することはできません。',
    en: 'You can\'t specify multiple options.'
}

const iDonthavePermissionToManageMessagesLocales = {
    ja: 'BOTにメッセージを管理する権限がありません。',
    en: 'I don\'t have permission to manage messages.'
}

const iDonthavePermissionToDeleteMessagesLocales = {
    ja: 'BOTにメッセージを削除する権限がありません。',
    en: 'I don\'t have permission to delete messages.'
}

const addedUserToDisableUserLocales = {
    ja: '無効化するユーザーに追加しました。',
    en: 'Added user to disable.user.'
}

const removedUserFromDisableUserLocales = {
    ja: '無効化するユーザーから削除しました。',
    en: 'Removed user from disable.user.'
}

const addedChannelToDisableChannelLocales = {
    ja: '無効化するチャンネルに追加しました。',
    en: 'Added channel to disable.channel.'
}

const removedChannelFromDisableChannelLocales = {
    ja: '無効化するチャンネルから削除しました。',
    en: 'Removed channel from disable.channel.'
}

const addedRoleToDisableRoleLocales = {
    ja: '無効化するロールに追加しました。',
    en: 'Added role to disable.role.'
}

const removedRoleFromDisableRoleLocales = {
    ja: '無効化するロールから削除しました。',
    en: 'Removed role from disable.role.'
}

const addedWordToBannedWordsLocales = {
    ja: '禁止ワードに追加しました。',
    en: 'Added word to bannedWords.'
}

const removedWordFromBannedWordsLocales = {
    ja: '禁止ワードから削除しました。',
    en: 'Removed word from bannedWords.'
}

const deleteButtonLabelLocales = {
    ja: '削除',
    en: 'Delete'
}

const userMustSpecifyAnyWordLocales = {
    ja: 'オプションを正確に指定する必要があります。',
    en: 'You must specify a option.'
}

const defaultLanguageDiscriptionLocales = {
    ja: '翻訳するときのデフォルトの言語を設定します。',
    en: 'Sets the default language when translating.'
}

const editoriginaliftranslateDiscriptionLocales = {
    ja: '翻訳するときにオリジナルのメッセージを編集するかどうかを設定します。',
    en: 'Sets whether to edit the original message when translating.'
}

const translateButtonLabelLocales = {
    ja: '翻訳',
    en: 'Translate'
}

const helpcommandDescriptionLocalizations = {
    ja: helpcommandDiscriptionLocales["ja"],
    en: helpcommandDiscriptionLocales["en"]
}

const pingcommandDescriptionLocalizations = {
    ja: 'Pong!',
    en: 'Pong!'
}

const invitecommandDescriptionLocalizations = {
    ja: 'このbotをあなたのサーバーに招待するためのリンクを表示します',
    en: 'Invite me to your server!'
}

const supportcommandDescriptionLocalizations = {
    ja: 'サポートサーバーに参加するためのリンクを表示します',
    en: 'Join support server!'
}

const settingscommandDescriptionLocalizations = {
    ja: '設定を変更します',
    en: 'chenge Settings'
}

const settingsDisableDescriptionLocalizations = {
    ja: settingsDisableDiscriptionLocales["ja"],
    en: settingsDisableDiscriptionLocales["en"]
}

const settingsBannedWordsDescriptionLocalizations = {
    ja: settingsBannedWordsDiscriptionLocales["ja"],
    en: settingsBannedWordsDiscriptionLocales["en"]
}

const settingsDisableUserDescriptionLocalizations = {
    ja: settingsDisableUserDiscriptionLocales["ja"],
    en: settingsDisableUserDiscriptionLocales["en"]
}

const settingsDisableChannelDescriptionLocalizations = {
    ja: settingsDisableChannelDiscriptionLocales["ja"],
    en: settingsDisableChannelDiscriptionLocales["en"]
}

const settingsBannedWordsWordDescriptionLocalizations = {
    ja: settingsBannedWordsWordDiscriptionLocales["ja"],
    en: settingsBannedWordsWordDiscriptionLocales["en"]
}

const defaultLanguageDescriptionLocalizations = {
    ja: defaultLanguageDiscriptionLocales["ja"],
    en: defaultLanguageDiscriptionLocales["en"]
}

const defaultLanguageLanguageDescriptionLocalizations = {
    ja: '言語',
    en: 'Language'
}

const editoriginaliftranslateDescriptionLocalizations = {
    ja: editoriginaliftranslateDiscriptionLocales["ja"],
    en: editoriginaliftranslateDiscriptionLocales["en"]
}

const yourcontentsisconteinbannedwordLocales = {
    ja: 'あなたのメッセージには禁止ワードが含まれています。',
    en: 'Your message contains a banned word.'
}

const idonthavedeletemessagepermissionLocales = {
    ja: 'メッセージを削除する権限がありません。',
    en: 'I don\'t have permission to delete messages.',
}

const setdefaultlanguagetolocales = {
    ja: 'デフォルトの言語を設定しました。 :',
    en: 'Set default language to '
}

const seteditoriginaliftranslatetolocales = {
    ja: 'editOriginalIfTranslateを設定しました。 :',
    en: 'Set editOriginalIfTranslate to '
}

const youcantdeleteotherusersmessagesLocales = {
    ja: 'あなたは他のユーザーのメッセージを削除することはできません。',
    en: 'You can\'t delete other users\' messages.'
}

const settingsSendMediaAsAttachmentsAsDefaultDescriptionLocalizations = {
    ja: 'メディアを添付ファイルとして表示するかどうかを設定します。',
    en: 'Sets whether to show media as attachments.'
}

const settingsDeleteMessageIfOnlyPostedTweetLinkDescriptionLocalizations = {
    ja: 'ツイートのリンクのみを投稿した場合にメッセージを削除するかどうかを設定します。',
    en: 'Sets whether to delete the message if only the tweet link is posted.'
}

const settingsAlwaysReplyIfPostedTweetLinkDescriptionLocalizations = {
    ja: 'ツイートのリンクを投稿した場合に常に返信するかどうかを設定します。',
    en: 'Sets whether to always reply if the tweet link is posted.'
}

const setdefaultmediaasattachmentstolocales = {
    ja: 'メディアを添付ファイルとして表示するかどうかを設定しました。 :',
    en: 'Set sendMediaAsAttachmentsAsDefault to '
}

const setdeleteifonlypostedtweetlinktolocales = {
    ja: 'ツイートのリンクのみを投稿した場合にメッセージを削除するかどうかを設定しました。 :',
    en: 'Set deleteIfOnlyPostedTweetLink to '
}

const setalwaysreplyifpostedtweetlinktolocales = {
    ja: 'ツイートのリンクを投稿した場合に常に返信するかどうかを設定しました。 :',
    en: 'Set alwaysReplyIfPostedTweetLink to '
}

const addedAllButtonLocales = {
    ja: 'すべてのボタンを無効化しました。',
    en: 'Disabled all buttons.'
}

const removedAllButtonLocales = {
    ja: 'すべてのボタンを有効化しました。',
    en: 'Enabled all buttons.'
}

const setshowmediaasattachmentsbuttonLocales = {
    ja: 'メディアを添付ファイルとして表示するボタンを設定しました。 :',
    en: 'Set showMediaAsAttachments button to '
}

const setshowattachmentsasembedsimagebuttonLocales = {
    ja: '画像を埋め込み画像として表示するボタンを設定しました。 :',
    en: 'Set showAttachmentsAsEmbedsImage button to '
}

const settranslatebuttonLocales = {
    ja: '翻訳ボタンを設定しました。 :',
    en: 'Set translate button to '
}

const setdeletebuttonLocales = {
    ja: '削除ボタンを設定しました。 :',
    en: 'Set delete button to '
}

const addedShowMediaAsAttachmentsButtonLocales = {
    ja: 'メディアを添付ファイルとして表示するボタンを無効化しました。',
    en: 'Disabled showMediaAsAttachments button.'
}

const removedShowMediaAsAttachmentsButtonLocales = {
    ja: 'メディアを添付ファイルとして表示するボタンを有効化しました。',
    en: 'Enabled showMediaAsAttachments button.'
}

const addedShowAttachmentsAsEmbedsImageButtonLocales = {
    ja: '画像を埋め込み画像として表示するボタンを無効化しました。',
    en: 'Disabled showAttachmentsAsEmbedsImage button.'
}

const removedShowAttachmentsAsEmbedsImageButtonLocales = {
    ja: '画像を埋め込み画像として表示するボタンを有効化しました。',
    en: 'Enabled showAttachmentsAsEmbedsImage button.'
}

const addedTranslateButtonLocales = {
    ja: '翻訳ボタンを無効化しました。',
    en: 'Disabled translate button.'
}

const removedTranslateButtonLocales = {
    ja: '翻訳ボタンを有効化しました。',
    en: 'Enabled translate button.'
}

const addedDeleteButtonLocales = {
    ja: '削除ボタンを無効化しました。',
    en: 'Disabled delete button.'
}

const removedDeleteButtonLocales = {
    ja: '削除ボタンを有効化しました。',
    en: 'Enabled delete button.'
}

const addedUserToButtonDisabledUserLocales = {
    ja: 'ボタンを無効化するユーザーに追加しました。',
    en: 'Added user to button_disabled.user.'
}

const removedUserFromButtonDisabledUserLocales = {
    ja: 'ボタンを無効化するユーザーから削除しました。',
    en: 'Removed user from button_disabled.user.'
}

const addedChannelToButtonDisabledChannelLocales = {
    ja: 'ボタンを無効化するチャンネルに追加しました。',
    en: 'Added channel to button_disabled.channel.'
}

const removedChannelFromButtonDisabledChannelLocales = {
    ja: 'ボタンを無効化するチャンネルから削除しました。',
    en: 'Removed channel from button_disabled.channel.'
}

const addedRoleToButtonDisabledRoleLocales = {
    ja: 'ボタンを無効化するロールに追加しました。',
    en: 'Added role to button_disabled.role.'
}

const removedRoleFromButtonDisabledRoleLocales = {

    ja: 'ボタンを無効化するロールから削除しました。',
    en: 'Removed role from button_disabled.role.'
}

const settingsextractBotMessageDescriptionLocalizations = {
    ja: 'BOTのメッセージを展開するかどうかを設定します。',
    en: 'Sets whether to extract bot messages.'
}

const setextractbotmessagetolocales = {
    ja: 'BOTのメッセージを展開するかどうかを設定しました。 :',
    en: 'Set extractBotMessage to '
}

const command_name_help_Locales = {
    ja: 'ヘルプ',
    en: 'help'
}

const command_name_ping_Locales = {
    ja: '遅延確認',
    en: 'ping'
}

const command_name_invite_Locales = {
    ja: '招待',
    en: 'invite'
}

const command_name_support_Locales = {
    ja: 'サポート',
    en: 'support'
}

const command_name_settings_Locales = {
    ja: '設定',
    en: 'settings'
}

const command_name_disable_Locales = {
    ja: '無効化',
    en: 'disable'
}

const command_name_bannedwords_Locales = {
    ja: '禁止ワード',
    en: 'bannedwords'
}

const command_name_user_Locales = {
    ja: 'ユーザー',
    en: 'user'
}

const command_name_channel_Locales = {
    ja: 'チャンネル',
    en: 'channel'
}

const command_name_role_Locales = {
    ja: 'ロール',
    en: 'role'
}

const command_name_word_Locales = {
    ja: '単語',
    en: 'word'
}

const command_name_defaultlanguage_Locales = {
    ja: 'デフォルト言語',
    en: 'defaultlanguage'
}

const command_name_language_Locales = {
    ja: '言語',
    en: 'language'
}

const command_name_editoriginaliftranslate_Locales = {
    ja: '翻訳時にオリジナルのメッセージを編集',
    en: 'editoriginaliftranslate'
}

const command_name_boolean_Locales = {
    ja: 'はいかいいえ',
    en: 'boolean'
}

const command_name_setdefaultmediaasattachments_Locales = {
    ja: 'メディアを添付ファイルとして表示',
    en: 'setdefaultmediaasattachments'
}

const command_name_deleteifonlypostedtweetlink_Locales = {
    ja: 'ツイートのリンクのみを投稿した場合にメッセージを削除',
    en: 'deleteifonlypostedtweetlink'
}

const command_name_alwaysreplyifpostedtweetlink_Locales = {
    ja: 'ツイートのリンクを投稿した場合に常に返信',
    en: 'alwaysreplyifpostedtweetlink'
}

const command_name_secondaryextracttarget_Locales = {
    ja: 'セカンダリー展開対象',
    en: 'secondary_extract_target'
}

const command_name_multipleimages_Locales = {
    ja: '複数枚画像',
    en: 'multipleimages'
}

const command_name_video_Locales = {
    ja: '動画',
    en: 'video'
}

const command_name_button_Locales = {
    ja: 'ボタン',
    en: 'button'
}

const command_name_invisible_Locales = {
    ja: '非表示',
    en: 'invisible'
}

const command_name_disabled_Locales = {
    ja: '無効化',
    en: 'disabled'
}

const command_name_extractbotmessage_Locales = {
    ja: 'ボットのメッセージを展開',
    en: 'extractbotmessage'
}

const command_name_showmediaasattachments_Locales = {
    ja: 'メディアを添付ファイルとして表示',
    en: 'showmediaasattachments'
}

const command_name_showattachmentsasembedsimage_Locales = {
    ja: '画像を埋め込み画像として表示',
    en: 'showattachmentsasembedsimage'
}

const command_name_translate_Locales = {
    ja: '翻訳',
    en: 'translate'
}

const command_name_delete_Locales = {
    ja: '削除',
    en: 'delete'
}

const command_name_all_Locales = {
    ja: 'すべて',
    en: 'all'
}


const command_name_quote_repost_do_not_extract_Locales = {
    ja: '引用リツイートを展開しない',
    en: 'quote_repost_do_not_extract'
}

const settingsQuoteRepostDoNotExtractDescriptionLocalizations = {
    ja: '引用リツイートを展開しないかどうかを設定します。',
    en: 'Sets whether to expand quote retweets.'
}

const setquoterepostdonotextracttolocales = {
    ja: '引用リツイートを展開しないかどうかを設定しました。 :',
    en: 'Set quote_repost_do_not_extract to '
}

const command_name_quote_repost_max_depth_Locales = {
    ja: '引用リツイート最大展開数',
    en: 'quote_repost_max_depth'
}

const settingsQuoteRepostMaxDepthDescriptionLocalizations = {
    ja: '引用リツイートの最大展開数を設定します。(0で無制限、デフォルト:無制限)',
    en: 'Sets the maximum depth of quote retweet expansion. (0 for unlimited, default: unlimited)'
}

const setquoterepostmaxdepthtolocales = {
    ja: '引用リツイートの最大展開数を設定しました: ',
    en: 'Set quote_repost_max_depth to '
}

const command_name_legacy_mode_Locales = {
    ja: 'レガシーモード',
    en: 'legacy_mode'
}

const settingsLegacyModeDescriptionLocalizations = {
    ja: 'レガシーモードを設定します。',
    en: 'Sets legacy mode.'
}

const setlegacymodetolocales = {
    ja: 'レガシーモードを設定しました。 :',
    en: 'Set legacy_mode to '
}

const command_name_passive_mode_Locales = {
    ja: 'パッシブモード',
    en: 'passive_mode'
}

const settingsPassiveModeDescriptionLocalizations = {
    ja: 'パッシブモード(画像表示用のボタンのみを送信するモード)を設定します。',
    en: 'Sets passive mode.'
}

const setpassivemodetolocales = {
    ja: 'パッシブモードを設定しました。 :',
    en: 'Set passive_mode to '
}

const command_name_secondary_extract_mode_Locales = {
    ja: 'セカンダリー展開モード',
    en: 'secondary_extract_mode'
}

const settingsSecondaryExtractModeDescriptionLocalizations = {
    ja: 'セカンダリー展開モード(設定した展開対象に一致する場合のみ送信するモード)を設定します。',
    en: 'Sets secondary extract mode.'
}

const setsecondaryextractmodetolocales = {
    ja: 'セカンダリー展開モードを設定しました。 :',
    en: 'Set secondary_extract_mode to '
}

const settingsSecondaryExtractTargetDescriptionLocalizations = {
    ja: 'セカンダリー展開モードで展開対象(複数枚画像/動画)を設定します。',
    en: 'Sets extraction targets for secondary extract mode.'
}

const setsecondaryextracttargetmultipleimagestolocales = {
    ja: 'セカンダリー展開対象(複数枚画像)を設定しました。 :',
    en: 'Set secondary_extract_target multiple images to '
}

const setsecondaryextracttargetvideotolocales = {
    ja: 'セカンダリー展開対象(動画)を設定しました。 :',
    en: 'Set secondary_extract_target video to '
}

const savetweetButtonLabelLocales = {
    ja: 'ツイートを保存',
    en: 'savetweet'
}

const command_name_showSaveTweet_Locales = {
    ja: '保存したツイートを表示',
    en: 'showsavedtweet'
}

const showSaveTweetcommandDescriptionLocalizations = {
    ja: '保存したツイートを表示します。',
    en: 'Shows saved tweet.'
}

const command_name_showSaveTweetButtonLabelLocales = {
    ja: '保存したツイートを表示',
    en: 'Show saved tweet'
}

const userDonthaveSavedTweetLocales = {
    ja: '保存したツイートがありません。',
    en: 'You don\'t have saved tweet.'
}

const command_name_id_Locales = {
    ja: 'id',
    en: 'id'
}

const command_name_save_tweet_quota_override_Locales = {
    ja: 'ツイート保存クオータオーバーライド',
    en: 'save_tweet_quota_override'
}

const settingsSaveTweetQuotaOverrideDescriptionLocalizations = {
    ja: '管理者用コマンド',
    en: 'Admin only command'
}

const setSaveTweetQuotaOverridetolocales = {
    ja: 'ツイート保存クオータオーバーライドを設定しました。 :',
    en: 'Set save_tweet_quota_override to '
}

const command_name_quota_Locales = {
    ja: 'クオータ',
    en: 'quota'
}

const setsavetweetquotaoverridetolocales = {
    ja: 'ツイート保存クオータを設定しました。 :',
    en: 'Set save_tweet_quota to '
}

const command_name_showSaveTweetQuota_Locales = {
    ja: 'ツイート保存クオータを表示',
    en: 'showSaveTweetQuota'
}

const showSaveTweetQuotacommandDescriptionLocalizations = {
    ja: 'ツイート保存クオータを表示します。',
    en: 'Shows save tweet quota.'
}

const deletedSavedTweetLocales = {
    ja: 'ツイートを削除しました。',
    en: 'Deleted saved tweet.'
}

const quotastatsCommandNameLocales = {
    ja: 'クオータ統計',
    en: 'quotastats'
}

const quotastatsCommandDescriptionLocales = {
    ja: 'クオータの統計を表示します。',
    en: 'Shows quota stats.'
}

const myGuildSettingsCommandNameLocales = {
    ja: 'サーバー設定の確認',
    en: 'myguildsettings'
}

const command_name_doitwhensecondaryextractmodeisenabled_Locales = {
    ja: 'セカンダリー展開と連携',
    en: 'secoundaryextractmode'
}

const settingsDoItWhenSecondaryExtractModeIsEnabledDescriptionLocalizations = {
    ja: 'セカンダリー展開モードが実行されたときのみに実行するかどうかを設定します。',
    en: 'Sets whether to execute when secondary extract mode is enabled.'
}

const setdoitwhensecoundaryextractmodeisenabledtolocales = {
    ja: 'セカンダリー展開モードが実行されたときのみに実行するを設定しました。 :',
    en: 'Set doitwhensecondaryextractmodeisenabled to '
}

const showSaveTweetButtonLabelLocales = {
    ja: '保存したツイートを表示',
    en: 'Show saved tweet'
}

const setsavetweetbuttonLocales = {
    ja: '保存したツイートを表示ボタンを設定しました。 :',
    en: 'Set showSaveTweet button to '
}

const command_name_autoextract_Locales = {
    ja: '自動展開',
    en: 'autoextract'
}

const settingsAutoExtractDescriptionLocalizations = {
    ja: '自動展開を設定します。',
    en: 'Sets auto extract.'
}

const command_name_autoextract_list_Locales = {
    ja: '自動展開リスト',
    en: 'autoextract_list'
}

const settingsAutoExtractListDescriptionLocalizations = {
    ja: '自動展開リストを表示します',
    en: 'Shows auto extract list.'
}

const command_name_autoextract_add_Locales = {
    ja: '自動展開追加',
    en: 'autoextract_add'
}

const settingsAutoExtractAddDescriptionLocalizations = {
    ja: '自動展開リストに追加します',
    en: 'Adds to auto extract list.'
}

const command_name_autoextract_delete_Locales = {
    ja: '自動展開削除',
    en: 'autoextract_delete'
}

const settingsAutoExtractDeleteDescriptionLocalizations = {
    ja: '自動展開リストから削除します',
    en: 'Deletes from auto extract list.'
}

const command_name_autoextract_username_Locales = {
    ja: 'twitterユーザー名',
    en: 'autoextract_username'
}

const command_name_autoextract_webhook_Locales = {
    ja: '自動展開するwebhook',
    en: 'autoextract_webhook'
}

const command_name_autoextract_id_Locales = {
    ja: '自動展開id',
    en: 'autoextract_id'
}

const command_name_additionalautoextractslot_Locales = {
    ja: '追加自動展開スロット',
    en: 'additionalautoextractslot'
}

const settingsAdditionalAutoExtractSlotDescriptionLocalizations = {
    ja: '追加自動展開スロットを設定します。',
    en: 'Sets additional auto extract slot.'
}

const setadditionalautoextractslottolocales = {
    ja: '追加自動展開スロットを設定しました。 :',
    en: 'Set additionalautoextractslot to '
}

const command_name_slot_Locales = {
    ja: 'スロット',
    en: 'slot'
}

const command_name_checkfreeslot_Locales = {
    ja: '空きスロット数を確認',
    en: 'checkfreeslot'
}

const settingsAdditionalAutoExtractCheckFreeSlotDescriptionLocalizations = {
    ja: '空きスロット数を確認します。',
    en: 'Checks free slot.'
}


function conv_en_to_en_US(obj) {
    if (obj === undefined) return undefined;
    obj = [obj]
    const obj_deep = obj.map(obj => ({ ...obj }))[0]
    if (obj_deep["en"] !== undefined) {
        obj_deep["en-US"] = obj_deep["en"];
        delete obj_deep["en"];
    } else {
        return undefined;
    }
    return obj_deep;
}

const videoExtensions = [
    'mp4',
    'mov',
    'wmv',
    'avi',
    'avchd',
    'flv',
    'f4v',
    'swf',
    'mkv',
    'webm',
    'm4v',
    '3gp',
    '3g2',
    'mxf',
    'roq',
    'nsv',
    'gifv',
    'gif',
    'ts',
    'm2ts',
    'mts',
    'vob'
];

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

client.on('ready', () => {
    console.log(`${client.user.tag} is ready!`);
    setInterval(() => {
        client.user.setPresence({
            status: 'online',
            activities: [{
                name: client.guilds.cache.size + 'servers | No special setup is required, just post the tweet link.',
                type: ActivityType.Watching
            }]
        });
    }, 60000);

    setInterval(() => {
         return;
        /*
テーブル: deregister_notification

列	型	コメント
index	int(11) 連番	
userid	bigint(20)	
reasonId	int(11)	
timestamp	bigint(20) [round(unix_timestamp(current_timestamp(4)) * 1000,0)]	
sendedDirectMessage	tinyint(4) [0]	

外部キー
ソース	ターゲット	ON DELETE	ON UPDATE	
reasonId	deregister_reason(reasonId)	RESTRICT	RESTRICT	

テーブル: deregister_reason
列	型	コメント
reasonId	int(11)	
reason	varchar(80)	
hint	text NULL	
*/
        connection.query('SELECT * FROM deregister_notification NATURAL LEFT OUTER JOIN deregister_reason WHERE timestamp > ? AND sendedDirectMessage = 0', [new Date().getTime() - 86400000], (err, results, fields) => {
            if (err) {
                console.error('Error connecting to database:', err);
                return;
            }
            results.forEach(result => {
                client.users.fetch(result.userid).then(async user => {
                    user.send({
                        embeds: [{
                            title: '新着自動展開機能の登録が自動解除されました',
                            description: `あなたが登録した新着自動展開機能の登録(ID:${result.rssId})は、以下の理由により自動解除されました。\n\n理由: ${result.reason}\n\n詳細: \n${result.hint}`,
                            color: 0x1DA1F2
                        }]
                    }).then(() => {
                        connection.query('UPDATE deregister_notification as T1 SET sendedDirectMessage = 1 WHERE T1.index = ?', [result.index], (err, results, fields) => {
                            if (err) {
                                console.error('Error connecting to database:', err);
                                return;
                            }
                        })
                    }).catch((e) => {
                        console.error(e);
                    });
                }).catch((e) => {
                    console.error(e);
                });
            });
        });
    }, 10000);

    setInterval(async () => {
        let guild = await client.guilds.cache.get('1175729394782851123')
        let channel = await guild.channels.cache.get('1189083636574724167')
        channel.send({
            embeds: [{
                title: '🌐サーバー数',
                description: client.guilds.cache.size + 'servers',
                color: 0x1DA1F2,
                fields: [
                    {
                        name: 'ユーザー数',
                        value: client.users.cache.size + 'users'
                    },
                    {
                        name: 'チャンネル数',
                        value: client.channels.cache.size + 'channels'
                    },
                    {
                        name: '一分間に処理したメッセージ数',
                        value: processed + 'messages'
                    },
                    {
                        name: '一時間に処理したメッセージ数',
                        value: processed_hour + 'messages'
                    },
                    {
                        name: '一日に処理したメッセージ数',
                        value: processed_day + 'messages'
                    }
                ]
            }]
        })
        processed_column = processed;
        processed = 0;

        if (new Date().getMinutes() === 0) {
            processed_hour_column = processed_hour;
            processed_hour = 0;
        } else {
            processed_hour_column = null;
        }
        if (new Date().getHours() === 0 && new Date().getMinutes() === 0) {
            processed_day_column = processed_day;
            processed_day = 0;
        } else {
            processed_day_column = null;
        }
        /*
        connection.query('INSERT INTO stats (timestamp, joinedServersCount, usersCount, channelsCount, minutes, hours, days) VALUES (?, ?, ?, ?, ?, ?, ?)', [new Date().getTime(), client.guilds.cache.size, client.users.cache.size, client.channels.cache.size, processed_column, processed_hour_column, processed_day_column], (err, results, fields) => {
            if (err) {
                console.error('Error connecting to database:', err);
                return;
            }
        });
        */
    }, 60000);

    client.application.commands.set([
        {
            name: 'help',
            name_localizations: conv_en_to_en_US(command_name_help_Locales),
            description: 'Shows help message.',
            description_localizations: conv_en_to_en_US(helpcommandDescriptionLocalizations)
        },
        {
            name: 'ping',
            name_localizations: conv_en_to_en_US(command_name_ping_Locales),
            description: 'Pong!',
            description_localizations: conv_en_to_en_US(pingcommandDescriptionLocalizations)
        },
        {
            name: 'invite',
            name_localizations: conv_en_to_en_US(command_name_invite_Locales),
            description: 'Invite me to your server!',
            description_localizations: conv_en_to_en_US(invitecommandDescriptionLocalizations)
        },
        {
            name: 'support',
            name_localizations: conv_en_to_en_US(command_name_support_Locales),
            description: 'Join support server!',
            description_localizations: conv_en_to_en_US(supportcommandDescriptionLocalizations)
        },
        {
            name: 'settings',
            name_localizations: conv_en_to_en_US(command_name_settings_Locales),
            description: 'chenge Settings',
            description_localizations: conv_en_to_en_US(settingscommandDescriptionLocalizations),
            options: [
                {
                    name: 'disable',
                    name_localizations: conv_en_to_en_US(command_name_disable_Locales),
                    description: 'disable',
                    description_localizations: conv_en_to_en_US(settingsDisableDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            name_localizations: conv_en_to_en_US(command_name_user_Locales),
                            description: 'user',
                            description_localizations: conv_en_to_en_US(settingsDisableUserDescriptionLocalizations),
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: 'channel',
                            name_localizations: conv_en_to_en_US(command_name_channel_Locales),
                            description: 'channel',
                            description_localizations: conv_en_to_en_US(settingsDisableChannelDescriptionLocalizations),
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: 'role',
                            name_localizations: conv_en_to_en_US(command_name_role_Locales),
                            description: 'role',
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: 'bannedwords',
                    name_localizations: conv_en_to_en_US(command_name_bannedwords_Locales),
                    description: 'bannedWords',
                    description_localizations: conv_en_to_en_US(settingsBannedWordsDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'word',
                            name_localizations: conv_en_to_en_US(command_name_word_Locales),
                            description: 'word',
                            description_localizations: conv_en_to_en_US(settingsBannedWordsWordDescriptionLocalizations),
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'defaultlanguage',
                    name_localizations: conv_en_to_en_US(command_name_defaultlanguage_Locales),
                    description: 'defaultLanguage',
                    description_localizations: conv_en_to_en_US(defaultLanguageDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'language',
                            name_localizations: conv_en_to_en_US(command_name_language_Locales),
                            description: 'language',
                            description_localizations: conv_en_to_en_US(defaultLanguageLanguageDescriptionLocalizations),
                            type: ApplicationCommandOptionType.String,
                            required: true,
                            choices: [
                                {
                                    name: 'English',
                                    value: 'en'
                                },
                                {
                                    name: 'Japanese',
                                    value: 'ja'
                                }
                            ]
                        }
                    ]
                },
                {
                    name: 'editoriginaliftranslate',
                    name_localizations: conv_en_to_en_US(command_name_editoriginaliftranslate_Locales),
                    description: 'editOriginalIfTranslate',
                    description_localizations: conv_en_to_en_US(editoriginaliftranslateDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'setdefaultmediaasattachments',
                    name_localizations: conv_en_to_en_US(command_name_setdefaultmediaasattachments_Locales),
                    description: 'setSendMediaAsAttachmentsAsDefault',
                    description_localizations: conv_en_to_en_US(settingsSendMediaAsAttachmentsAsDefaultDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'deleteifonlypostedtweetlink',
                    name_localizations: conv_en_to_en_US(command_name_deleteifonlypostedtweetlink_Locales),
                    description: 'deleteIfOnlyPostedTweetLink',
                    description_localizations: conv_en_to_en_US(settingsDeleteMessageIfOnlyPostedTweetLinkDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        },
                        {
                            name: 'secoundaryextractmode',
                            name_localizations: conv_en_to_en_US(command_name_doitwhensecondaryextractmodeisenabled_Locales),
                            description: 'doItWhenSecondaryExtractModeIsEnabled',
                            description_localizations: conv_en_to_en_US(settingsDoItWhenSecondaryExtractModeIsEnabledDescriptionLocalizations),
                            type: ApplicationCommandOptionType.Boolean,
                            required: false
                        }
                    ]
                },
                {
                    name: 'alwaysreplyifpostedtweetlink',
                    name_localizations: conv_en_to_en_US(command_name_alwaysreplyifpostedtweetlink_Locales),
                    description: 'alwaysReplyIfPostedTweetLink',
                    description_localizations: conv_en_to_en_US(settingsAlwaysReplyIfPostedTweetLinkDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'button',
                    name_localizations: conv_en_to_en_US(command_name_button_Locales),
                    description: 'button',
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: 'invisible',
                            name_localizations: conv_en_to_en_US(command_name_invisible_Locales),
                            description: 'invisible',
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: 'showmediaasattachments',
                                    name_localizations: conv_en_to_en_US(command_name_showmediaasattachments_Locales),
                                    description: 'showMediaAsAttachments',
                                    description_localizations: conv_en_to_en_US(showMediaAsAttachmentsButtonLocales),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'showattachmentsasembedsimage',
                                    name_localizations: conv_en_to_en_US(command_name_showattachmentsasembedsimage_Locales),
                                    description: 'showAttachmentsAsEmbedsImage',
                                    description_localizations: conv_en_to_en_US(showAttachmentsAsEmbedsImagebuttonLocales),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'translate',
                                    name_localizations: conv_en_to_en_US(command_name_translate_Locales),
                                    description: 'translate',
                                    description_localizations: conv_en_to_en_US(translateButtonLabelLocales),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'delete',
                                    name_localizations: conv_en_to_en_US(command_name_delete_Locales),
                                    description: 'delete',
                                    description_localizations: conv_en_to_en_US(deleteButtonLabelLocales),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'savetweet',
                                    name_localizations: conv_en_to_en_US(savetweetButtonLabelLocales),
                                    description: 'showSaveTweet',
                                    description_localizations: conv_en_to_en_US(showSaveTweetButtonLabelLocales),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'all',
                                    name_localizations: conv_en_to_en_US(command_name_all_Locales),
                                    description: 'all',
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: 'disabled',
                            name_localizations: conv_en_to_en_US(command_name_disabled_Locales),
                            description: 'disabled',
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: 'user',
                                    name_localizations: conv_en_to_en_US(command_name_user_Locales),
                                    description: 'user',
                                    description_localizations: conv_en_to_en_US(settingsDisableUserDescriptionLocalizations),
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: 'channel',
                                    name_localizations: conv_en_to_en_US(command_name_channel_Locales),
                                    description: 'channel',
                                    description_localizations: conv_en_to_en_US(settingsDisableChannelDescriptionLocalizations),
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: 'role',
                                    name_localizations: conv_en_to_en_US(command_name_role_Locales),
                                    description: 'role',
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                }, {
                    name: 'extractbotmessage',
                    name_localizations: conv_en_to_en_US(command_name_extractbotmessage_Locales),
                    description: 'extractBotMessage',
                    description_localizations: conv_en_to_en_US(settingsextractBotMessageDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'quoterepostdonotextract',
                    name_localizations: conv_en_to_en_US(command_name_quote_repost_do_not_extract_Locales),
                    description: 'quote repost do not extract',
                    description_localizations: conv_en_to_en_US(settingsQuoteRepostDoNotExtractDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'quoterepostmaxdepth',
                    name_localizations: conv_en_to_en_US(command_name_quote_repost_max_depth_Locales),
                    description: 'quote repost max depth',
                    description_localizations: conv_en_to_en_US(settingsQuoteRepostMaxDepthDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'depth',
                            name_localizations: conv_en_to_en_US({ ja: '深さ', en: 'depth' }),
                            description: 'max depth (0 for unlimited)',
                            description_localizations: conv_en_to_en_US({ ja: '最大深さ (0で無制限)', en: 'max depth (0 for unlimited)' }),
                            type: ApplicationCommandOptionType.Integer,
                            required: true,
                            min_value: 0,
                            max_value: 10
                        }
                    ]
                },
                {
                    name: 'legacymode',
                    name_localizations: conv_en_to_en_US(command_name_legacy_mode_Locales),
                    description: 'legacy mode',
                    description_localizations: conv_en_to_en_US(settingsLegacyModeDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                /*
                {
                    name: 'passivemode',
                    name_localizations: conv_en_to_en_US(command_name_passive_mode_Locales),
                    description: 'passive mode',
                    description_localizations: conv_en_to_en_US(settingsPassiveModeDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                */
                {
                    name: 'secondaryextractmode',
                    name_localizations: conv_en_to_en_US(command_name_secondary_extract_mode_Locales),
                    description: 'secondary extract mode',
                    description_localizations: conv_en_to_en_US(settingsSecondaryExtractModeDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(command_name_boolean_Locales),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'secondaryextracttarget',
                    name_localizations: conv_en_to_en_US(command_name_secondaryextracttarget_Locales),
                    description: 'secondary extract target',
                    description_localizations: conv_en_to_en_US(settingsSecondaryExtractTargetDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'multipleimages',
                            name_localizations: conv_en_to_en_US(command_name_multipleimages_Locales),
                            description: 'multiple images',
                            type: ApplicationCommandOptionType.Boolean,
                            required: false
                        },
                        {
                            name: 'video',
                            name_localizations: conv_en_to_en_US(command_name_video_Locales),
                            description: 'video',
                            type: ApplicationCommandOptionType.Boolean,
                            required: false
                        }
                    ]
                }
            ]
        },
        {
            name: 'showsavetweet',
            name_localizations: conv_en_to_en_US(command_name_showSaveTweet_Locales),
            description: 'Shows save tweet.',
            description_localizations: conv_en_to_en_US(showSaveTweetcommandDescriptionLocalizations),
            options: [
                {
                    name: 'id',
                    name_localizations: conv_en_to_en_US(command_name_id_Locales),
                    description: 'string',
                    type: ApplicationCommandOptionType.String,
                    required: false
                }
            ]
        },
        {
            name: 'savetweetquotaoverride',
            name_localizations: conv_en_to_en_US(command_name_save_tweet_quota_override_Locales),
            description: 'save tweet quota override',
            description_localizations: conv_en_to_en_US(settingsSaveTweetQuotaOverrideDescriptionLocalizations),
            options: [
                {
                    name: 'newquota',
                    name_localizations: conv_en_to_en_US(command_name_quota_Locales),
                    description: 'new quota',
                    type: ApplicationCommandOptionType.Integer,
                    required: true
                },
                {
                    name: 'user',
                    name_localizations: conv_en_to_en_US(command_name_user_Locales),
                    description: 'user',
                    description_localizations: conv_en_to_en_US(settingsDisableUserDescriptionLocalizations),
                    type: ApplicationCommandOptionType.User,
                    required: false
                }
            ]
        },
        {
            name: 'deletesavetweet',
            name_localizations: conv_en_to_en_US(command_name_delete_Locales),
            description: 'delete save tweet.',
            description_localizations: conv_en_to_en_US(settingsSaveTweetQuotaOverrideDescriptionLocalizations),
            options: [
                {
                    name: 'id',
                    name_localizations: conv_en_to_en_US(command_name_id_Locales),
                    description: 'string',
                    type: ApplicationCommandOptionType.String,
                    required: true
                }
            ]
        },
        {
            name: 'quotastats',
            name_localizations: conv_en_to_en_US(quotastatsCommandNameLocales),
            description: 'quota stats',
            description_localizations: conv_en_to_en_US(settingsSaveTweetQuotaOverrideDescriptionLocalizations),
            options: [
                {
                    name: 'user',
                    name_localizations: conv_en_to_en_US(command_name_user_Locales),
                    description: 'user',
                    description_localizations: conv_en_to_en_US(settingsDisableUserDescriptionLocalizations),
                    type: ApplicationCommandOptionType.User,
                    required: false
                }
            ]
        },
        {
            name: 'checkmyguildsettings',
            name_localizations: conv_en_to_en_US(myGuildSettingsCommandNameLocales),
            description: 'check my guild settings',
            description_localizations: conv_en_to_en_US(settingsSaveTweetQuotaOverrideDescriptionLocalizations),
            options: [
                {
                    name: 'guild',
                    name_localizations: conv_en_to_en_US(command_name_user_Locales),
                    description: 'guild',
                    type: ApplicationCommandOptionType.String,
                    required: false
                }
            ]
        },
        {
            name: 'autoextract',
            name_localizations: conv_en_to_en_US(command_name_autoextract_Locales),
            description: 'auto extract',
            description_localizations: conv_en_to_en_US(settingsAutoExtractDescriptionLocalizations),
            options: [
                {
                    name: 'list',
                    name_localizations: conv_en_to_en_US(command_name_autoextract_list_Locales),
                    description: 'list',
                    description_localizations: conv_en_to_en_US(settingsAutoExtractListDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                },
                {
                    name: 'add',
                    name_localizations: conv_en_to_en_US(command_name_autoextract_add_Locales),
                    description: 'add',
                    description_localizations: conv_en_to_en_US(settingsAutoExtractAddDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'username',
                            name_localizations: conv_en_to_en_US(command_name_autoextract_username_Locales),
                            description: 'username',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        },
                        {
                            name: 'webhook',
                            name_localizations: conv_en_to_en_US(command_name_autoextract_webhook_Locales),
                            description: 'webhook',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'delete',
                    name_localizations: conv_en_to_en_US(command_name_autoextract_delete_Locales),
                    description: 'delete',
                    description_localizations: conv_en_to_en_US(settingsAutoExtractDeleteDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'id',
                            name_localizations: conv_en_to_en_US(command_name_autoextract_id_Locales),
                            description: 'id',
                            type: ApplicationCommandOptionType.Integer,
                            required: true
                        }
                    ]
                },
                {
                    name: 'additionalautoextractslot',
                    name_localizations: conv_en_to_en_US(command_name_additionalautoextractslot_Locales),
                    description: 'ADMIN ONLY',
                    description_localizations: conv_en_to_en_US(settingsAdditionalAutoExtractSlotDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            name_localizations: conv_en_to_en_US(command_name_user_Locales),
                            description: 'user',
                            type: ApplicationCommandOptionType.User,
                            required: true
                        },
                        {
                            name: 'slot',
                            name_localizations: conv_en_to_en_US(command_name_slot_Locales),
                            description: 'slot',
                            type: ApplicationCommandOptionType.Integer,
                            required: true
                        }
                    ]
                },
                {
                    name: 'checkfreeslot',
                    name_localizations: conv_en_to_en_US(command_name_checkfreeslot_Locales),
                    description: 'check free slot',
                    description_localizations: conv_en_to_en_US(settingsAdditionalAutoExtractCheckFreeSlotDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand
                }
            ]
        }
    ]);
    setInterval(() => {
        if (text !== '') {
            const chunks = text.match(/[\s\S]{1,1900}/g);
            let i = 0;
            for (const chunk of chunks) {
                i++
                webhookClient.sendSlackMessage({
                    text: `\`\`\`${chunk}\`\`\``,
                    username: `[console]${client.user.tag}(${i}/${chunks.length})`,
                    icon_url: client.user.displayAvatarURL()
                })
            }
            text = '';
        }
    }, 10000);
});

const warning_this_bot_is_not_main_instance_and_going_to_be_closed_embed = {
    ja: {
        title: '警告',
        description: 'このbotはメインインスタンス(ComebackTwitterEmbed#3134)ではありません。\nメインインスタンスが認証を受けたため、このbotは72時間以内に削除されます。\nこの[リンク](https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877966336&scope=bot%20applications.commands)よりメインインスタンスをサーバーに導入し、このbotをキックしてください。\n移行期限\n<t:1700208003:F>\n期限まで残り\n<t:1700208003:R>',
        color: 0xFF0000
    },
    en: {
        title: 'Warning',
        description: 'This bot is not the main instance (ComebackTwitterEmbed#3134).\nThis bot will be deleted within 72 hours because the main instance has been verified.\nInstall the main instance on your server from this [link](https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877966336&scope=bot%20applications.commands) and kick this bot.\ndeadline:\n<t:1700208003:F>\nremain:\n<t:1700208003:R>',
        color: 0xFF0000
    }
}



function getStringFromObject(object, locale, default_ja = false) {
    //if specified locale is not found, return en
    //if default_ja is true, locale priority: ja > en
    if (object[locale] !== undefined) {
        return object[locale];
    }
    if (default_ja) {
        if (object["ja"] !== undefined) {
            return object["ja"];
        }
    }
    return object["en"];
}

function ifUserHasRole(user, roleidlist) {
    if (user.roles.cache.some(role => roleidlist.includes(role.id))) {
        return true;
    } else {
        return false;
    }
}


function convertBoolToEnableDisable(bool, locale) {
    if (bool == true) {
        if (locale === 'ja') {
            return '有効';
        } else {
            return 'Enable';
        }
    } else {
        if (locale === 'ja') {
            return '無効';
        } else {
            return 'Disable';
        }
    }
}

async function sendContentPromise(message, content) {
    return new Promise((resolve, reject) => {
        if (content.length == 0) return resolve();
        message.channel.send(content.join('\n')).then(msg => {
            resolve();
        }).catch(err => {
            reject(err);
        });
    });
}

function checkComponentIncludesDisabledButtonAndIfFindDeleteIt(components, guildId, setting = null) {
    setting = setting || settings; // 簡素化された設定の確認
    const invisibleSettings = setting.button_invisible[guildId] || {};

    // 全ての条件がfalseの場合、早期リターン
    if (Object.values(invisibleSettings).every(value => value === false)) {
        return components;
    }

    // 条件に一致する子コンポーネントをフィルタリングし、空のコンポーネントを除外
    return components.reduce((acc, component) => {
        if (!component.components || component.components.length === 0) return acc;

        // 条件に一致しない子コンポーネントのみを保持
        const filteredComponents = component.components.filter(subComponent => {
            const id = subComponent.data && subComponent.data.custom_id;
            return id ? !(id in invisibleSettings && invisibleSettings[id] === true) : true;
        });

        // フィルタリング後に子コンポーネントが残っている場合のみ、親コンポーネントを保持
        if (filteredComponents.length > 0) {
            component.components = filteredComponents;
            acc.push(component);
        }
        return acc;
    }, []);
}


async function sendTweetEmbed(message, url, quoted = false, parent = null, saved = false, depth = 0) {
    return new Promise((resolve, reject) => {
        const element = url;
        //replace twitter.com or x.com with api.vxtwitter.com
        var newUrl = element.replace(/twitter.com|x.com/g, 'api.vxtwitter.com');
        if (newUrl.split("/").length > 6 && !newUrl.includes("twidata.sprink.cloud")) {
            newUrl = newUrl.split("/").slice(0, 6).join("/");
        }

        //fetch the api
        fetch(newUrl)
            .then(async res => {
                let result = await res.text();
                if (result.startsWith("T")) {
                    console.log("<<RATE LIMIT>>:" + result + new Date().toLocaleString());
                }
                if (result.startsWith("<")) {
                    result = await fetch(newUrl.replace("api.vxtwitter.com", "api.fxtwitter.com"))
                        .then(async res => {
                            let result = await res.text();
                            return new Response(result)
                        }).then(async res => {
                            return await res.text()
                        })
                }
                return new Response(result)
            }).then(async res => {
                return await res.json()
            })
            .then(async json => {
                const tweetURL_altter = json.tweetURL.replace(/twitter.com/g, 'altterx.sprink.cloud');
                fetch(tweetURL_altter).then(async res => {
                    const result = await res.text();
                    return new Response(result)
                }).then(async res => {
                    return await res.text()
                })

                attachments = [];
                let embeds = [];
                let showMediaAsAttachmentsButton = null;
                const deleteButton = new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(getStringFromObject(deleteButtonLabelLocales, settings.defaultLanguage[message.guild.id] ?? "en")).setCustomId('delete');
                const translateButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(translateButtonLabelLocales, settings.defaultLanguage[message.guild.id] ?? "en")).setCustomId('translate');
                const savetweetButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(savetweetButtonLabelLocales, settings.defaultLanguage[message.guild.id] ?? "en")).setCustomId('savetweet');
                let messageObject = {
                    allowedMentions: {
                        repliedUser: false
                    }
                };
                let detected_bannedword = false;
                if (settings.bannedWords[message.guildId] !== undefined) {
                    for (let i = 0; i < settings.bannedWords[message.guildId].length; i++) {
                        const element = settings.bannedWords[message.guildId][i];
                        if (json.text.includes(element)) {
                            detected_bannedword = true;
                            break;
                        }
                    }

                    if (detected_bannedword) return message.reply(getStringFromObject(yourcontentsisconteinbannedwordLocales, settings.defaultLanguage[message.guild.id])).then(msg => {
                        setTimeout(() => {
                            msg.delete();
                            message.delete().catch(err => {
                                message.channel.send(getStringFromObject(idonthavedeletemessagepermissionLocales, settings.defaultLanguage[message.guild.id])).then(msg2 => {
                                    setTimeout(() => {
                                        msg2.delete();
                                    }
                                        , 3000);
                                });
                            });
                        }, 3000);
                    });
                }
                if (json.text.length > 1500) {
                    json.text = json.text.slice(0, 1500) + '...';
                }
                content = [];
                let embed = {}
                if (settings.deletemessageifonlypostedtweetlink[message.guild.id] === undefined) settings.deletemessageifonlypostedtweetlink[message.guild.id] = false;
                if (settings.passive_mode[message.guild.id] === undefined) settings.passive_mode[message.guild.id] = false;
                if (settings.secondary_extract_mode[message.guild.id] === undefined) settings.secondary_extract_mode[message.guild.id] = false;
                if (settings.secondary_extract_mode_multiple_images[message.guild.id] === undefined) settings.secondary_extract_mode_multiple_images[message.guild.id] = true;
                if (settings.secondary_extract_mode_video[message.guild.id] === undefined) settings.secondary_extract_mode_video[message.guild.id] = true;
                if (settings.legacy_mode[message.guild.id] === undefined) {
                    if (message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                        settings.legacy_mode[message.guild.id] = true;
                    } else {
                        settings.legacy_mode[message.guild.id] = false;
                    }

                }

                if (settings.legacy_mode[message.guild.id] === false && !quoted && (settings.deletemessageifonlypostedtweetlink[message.guild.id] === false || (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content != url)) && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                    embed = {
                        //title: json.user_name,
                        url: json.tweetURL,
                        description: /*json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n*/':speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: 'request by ' + (message.author?.username ?? message.user.username) + '(id:' + (message.author?.id ?? message.user.id) + ')',
                        },
                        //footer: {
                        //    text: 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')',
                        //    icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
                        //},
                        timestamp: new Date(json.date),
                    };
                    if (settings.passive_mode[message.guild.id] === true) {
                        delete embed.description
                    }
                } else {
                    embed = {
                        title: json.user_name,
                        url: json.tweetURL,
                        description: json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n:speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: 'request by ' + (message.author?.username ?? message.user.username) + '(id:' + (message.author?.id ?? message.user.id) + ')',
                        },
                        footer: {
                            text: 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')',
                            icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
                        },
                        timestamp: new Date(json.date),
                    };
                }
                if (url.includes("twidata.sprink.cloud") || url.includes("localhost:3088")) {
                    embed.title = "<SAVED TWEET> " + embed.title;
                    embed.color = 0x00FF00;
                }

                // articleの処理（記事リンクがある場合）
                if (json.article) {
                    let articleText = '';
                    if (json.article.title) {
                        articleText += '📰 **' + json.article.title + '**\n';
                    }
                    if (json.article.preview_text) {
                        // Discord embed descriptionの制限は4096文字
                        // 現在のdescription長を計算して残り文字数を算出
                        const currentDescLength = embed.description ? embed.description.length : 0;
                        const titleLength = json.article.title ? json.article.title.length + 10 : 0; // 📰 ** ** \n の分
                        const availableLength = 4096 - currentDescLength - titleLength - 10; // 改行等のマージン
                        
                        let previewText = json.article.preview_text;
                        if (previewText.length > availableLength && availableLength > 0) {
                            previewText = previewText.slice(0, availableLength) + '...';
                        }
                        articleText += previewText;
                    }
                    if (articleText) {
                        // 既存のdescriptionにarticle情報を追加
                        if (embed.description) {
                            embed.description = embed.description.replace(json.text, json.text + '\n\n' + articleText);
                            // 最終的にdescriptionが4096文字を超えないようにする
                            if (embed.description.length > 4096) {
                                embed.description = embed.description.slice(0, 4093) + '...';
                            }
                        }
                    }
                    // articleに画像があり、mediaURLsが空の場合は記事画像を使用
                    if (json.article.image && (!json.mediaURLs || json.mediaURLs.length === 0)) {
                        embed.image = {
                            url: json.article.image
                        };
                    }
                }

                const mediaURLs = json.mediaURLs ?? [];
                const containsVideoMedia = mediaURLs.some(element => {
                    return element.includes('video.twimg.com') || videoExtensions.some(ext => element.includes(ext));
                });
                const imageMediaCount = mediaURLs.filter(element => {
                    return !(element.includes('video.twimg.com') || videoExtensions.some(ext => element.includes(ext)));
                }).length;
                const containsMultipleImages = imageMediaCount > 1;
                const shouldExtractInSecondaryMode = !settings.secondary_extract_mode[message.guild.id]
                    || ((settings.secondary_extract_mode_multiple_images[message.guild.id] ?? true) && containsMultipleImages)
                    || ((settings.secondary_extract_mode_video[message.guild.id] ?? true) && containsVideoMedia);

                let videoflag = false;
                if (json.mediaURLs?.length > 0) {
                    if (json.mediaURLs.length > 4 || settings.sendMediaAsAttachmentsAsDefault[message.guild.id] === true) {
                        if (json.mediaURLs.length > 10) {
                            json.mediaURLs = json.mediaURLs.slice(0, 10);
                        }
                        attachments = json.mediaURLs
                        embeds.push(embed);

                        attachments.forEach(element => {
                            if (videoExtensions.some(ext => element.includes(ext))) {
                                videoflag = true;
                            }
                        });
                        if (settings.sendMediaAsAttachmentsAsDefault[message.guild.id] === true && !videoflag) {
                            showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(showAttachmentsAsEmbedsImagebuttonLocales, settings.defaultLanguage[message.guild.id])).setCustomId('showAttachmentsAsEmbedsImage');
                        }
                        if (settings.secondary_extract_mode[message.guild.id] === true && !shouldExtractInSecondaryMode && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                            const maxDepth = settings.quote_repost_max_depth[message.guild.id] ?? 0;
                            if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false) && (maxDepth === 0 || depth < maxDepth))) return await sendTweetEmbed(message, json.qrtURL, true, message, false, depth + 1);
                            return resolve();
                        }
                    } else {
                        json.mediaURLs.forEach(async element => {
                            if (element.includes('video.twimg.com')) {
                                attachments.push(element);
                                videoflag = true;
                                return;
                            }
                            showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(showMediaAsAttachmentsButtonLocales, settings.defaultLanguage[message.guild.id])).setCustomId('showMediaAsAttachments');
                            if (json.mediaURLs.length > 1) {
                                if (embeds.length == 0) embeds.push(embed);
                                embeds.push({
                                    url: json.tweetURL,
                                    image: {
                                        url: element
                                    }
                                })
                            } else {
                                if ((settings.legacy_mode[message.guild.id] === false && !quoted && (settings.deletemessageifonlypostedtweetlink[message.guild.id] === false || (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content != url)) && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088"))) {
                                    const maxDepth = settings.quote_repost_max_depth[message.guild.id] ?? 0;
                                    if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false) && (maxDepth === 0 || depth < maxDepth))) return await sendTweetEmbed(message, json.qrtURL, true, message, false, depth + 1);
                                    showMediaAsAttachmentsButton = null
                                    return
                                }
                                embed.image = {
                                    url: element
                                }
                                embeds.push(embed);
                            }
                        });
                        if (settings.secondary_extract_mode[message.guild.id] === true && !shouldExtractInSecondaryMode && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                            const maxDepth = settings.quote_repost_max_depth[message.guild.id] ?? 0;
                            if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false) && (maxDepth === 0 || depth < maxDepth))) return await sendTweetEmbed(message, json.qrtURL, true, message, false, depth + 1);
                            return resolve();
                        }
                    }
                } else if (settings.secondary_extract_mode[message.guild.id] === true && !shouldExtractInSecondaryMode && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088") && !json.article) {
                    const maxDepth = settings.quote_repost_max_depth[message.guild.id] ?? 0;
                    if (json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false) && (maxDepth === 0 || depth < maxDepth)) await sendTweetEmbed(message, json.qrtURL, true, msg, false, depth + 1);
                    return resolve();
                }
                if (embeds.length === 0) embeds.push(embed);
                if (attachments.length > 0) messageObject.files = attachments;
                if (showMediaAsAttachmentsButton !== null) messageObject.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
                if (!messageObject.components) messageObject.components = [];
                messageObject.components.push({ type: ComponentType.ActionRow, components: embeds[0].title ? [translateButton, deleteButton, savetweetButton] : [deleteButton] });
                messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, message.guildId);
                messageObject.embeds = embeds;
                if (quoted) messageObject.content = "Quoted tweet:"
                let msg = null;
                if (settings.legacy_mode[message.guild.id] === true && message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                    try {
                        await message.suppressEmbeds(true)
                    } catch (err) {
                        //console.log(err);
                    }

                }
                if (settings.alwaysreplyifpostedtweetlink[message.guild.id] === true && parent === null) {
                    await new Promise(async (resolve, reject) => {
                        msg = await message.reply(messageObject).catch(async err => {
                            if (messageObject.files !== undefined) {
                                await sendContentPromise(message, messageObject.files);
                                delete messageObject.files;
                                msg = await message.channel.send(messageObject).catch(err => {
                                    console.log(err);
                                }).then(msg => {
                                    resolve();
                                });
                            }
                        }).then(msg => {
                            resolve();
                        });
                    });
                } else if (parent === null) {
                    await new Promise(async (resolve, reject) => {
                        msg = await message.channel.send(messageObject).catch(async err => {
                            if (messageObject.files !== undefined) {
                                await sendContentPromise(message, messageObject.files);
                                delete messageObject.files;
                                msg = await message.channel.send(messageObject).catch(err => {
                                    console.log(err);
                                }).then(msg => {
                                    resolve();
                                });
                            }
                        }).then(msg => {
                            resolve();
                        });
                    });
                } else {
                    await new Promise(async (resolve, reject) => {

                        await parent.reply(messageObject).catch(async err => {
                            if (messageObject.files !== undefined) {
                                await sendContentPromise(message, messageObject.files);
                                delete messageObject.files;
                                await message.channel.send(messageObject).catch(err => {
                                    console.log(err);
                                }).then(msg => {
                                    resolve();
                                });
                            }
                        }).then(msg => {
                            resolve();
                        })
                    });
                }
                if (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content == url) {
                    if (settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[message.guild.id] === undefined) settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[message.guild.id] = false;
                    if (settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[message.guild.id] === true && settings.secondary_extract_mode[message.guild.id] === true) {
                        await message.suppressEmbeds(true);
                    } else {
                        await message.delete().catch(async err => {
                            await message.channel.send(getStringFromObject(idonthavedeletemessagepermissionLocales, settings.defaultLanguage[message.guild.id])).then(msg => {
                                setTimeout(async () => {
                                    await msg.delete();
                                }, 3000);
                            });
                        });
                    }
                }
                const maxDepth = settings.quote_repost_max_depth[message.guild.id] ?? 0;
                if (json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false) && (maxDepth === 0 || depth < maxDepth)) await sendTweetEmbed(message, json.qrtURL, true, msg, false, depth + 1);
                processed++;
                processed_hour++;
                processed_day++;
                resolve();
            })
            .catch(err => {
                console.log(err);
                reject(err);
            });
    });
}
client.on(Events.MessageCreate, async message => {
   if (message.guild.id != 1132814274734067772 || message.channel.id != 1279100351034953738) return;
   
     if (message.crosspostable) {
       message.crosspost()
       .then(() => message.react("✅"))
       .catch(console.error);
     } else {
       message.react("❌")
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (shouldIgnoreMessage(message)) return;

    const content = cleanMessageContent(message.content);
    const urls = extractTwitterUrls(content);

    if (urls.length === 0) return;
    if (isMessageDisabledForUserOrChannel(message)) return;

    //await ensureUserExistsInDatabase(message.author.id);

    for (const url of urls) {
        await sendTweetEmbed(message, url);
    }
});

function shouldIgnoreMessage(message) {
    const isBotMessageNotExtracted = message.author.bot && settings.extract_bot_message[message.guild.id] !== true && !message.webhookId;
    const isMessageFromClient = message.author.id === client.user.id;
    return isBotMessageNotExtracted || isMessageFromClient;
}

function cleanMessageContent(content) {
    return content.replace(/<https?:\/\/(twitter\.com|x\.com)[^\s<>|]*>|(\|\|https?:\/\/(twitter\.com|x\.com)[^\s<>|]*\|\|)/g, '');
}

function extractTwitterUrls(content) {
    return content.match(/https?:\/\/(twitter\.com|x\.com)\/[^\s<>|]*/g) || [];
}

function isMessageDisabledForUserOrChannel(message) {
    const isUserDisabled = settings.disable.user.includes(message.author.id);
    const isChannelDisabled = settings.disable.channel.includes(message.channel.id);
    const isRoleDisabled = !message.webhookId && settings.disable.role[message.guild.id] !== undefined && ifUserHasRole(message.member, settings.disable.role[message.guild.id]);

    return isUserDisabled || isChannelDisabled || isRoleDisabled;
}

async function ensureUserExistsInDatabase(userId) {
    const userExists = await queryDatabase('SELECT EXISTS (SELECT * FROM users WHERE userid = ? LIMIT 1)', [userId]);
    if (userExists[0][Object.keys(userExists[0])[0]] === 0) {
        await queryDatabase('INSERT INTO users (userid, register_date) VALUES (?, ?)', [userId, new Date().getTime()]);
    }
}

async function queryDatabase(query, params) {
    return new Promise((resolve, reject) => {
        connection.query(query, params, (err, results) => {
            if (err) {
                console.error(err);
                reject(err);
                return;
            }
            resolve(results);
        });
    });
}


client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.ApplicationCommand) return;
    //もしuserが登録されていなかったら登録する
    //await ensureUserExistsInDatabase(interaction.user.id);
    if (interaction.commandName === 'ping') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Pong!',
                    description: 'Ping: ' + client.ws.ping + 'ms',
                    color: 0x1DA1F2
                }
            ]
        });
    } else if (interaction.commandName === 'help') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Help',
                    description: helpDiscriptionLocales[interaction.locale] ?? helpDiscriptionLocales["en"],
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Commands',
                            value: helpCommandsLocales[interaction.locale] ?? helpCommandsLocales["en"]
                        }
                    ]
                }
            ]
        });
    } else if (interaction.commandName === 'invite') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Invite',
                    description: invitecommandDescriptionLocalizations[interaction.locale] ?? invitecommandDescriptionLocalizations["en"],
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Invite link',
                            value: 'https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877958144&scope=bot%20applications.commands'
                        }
                    ]
                }
            ]
        });
    } else if (interaction.commandName === 'support') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Support',
                    description: supportcommandDescriptionLocalizations[interaction.locale] ?? supportcommandDescriptionLocalizations["en"],
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Support server link',
                            value: 'https://discord.gg/V5VUtS83SG'
                        }
                    ]
                }
            ]
        });
    } else if (interaction.commandName === 'settings') {
        if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels) || interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if (interaction.options.getSubcommand() === 'disable') {
                if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
                    return await interaction.reply(userMustSpecifyAUserOrChannelLocales[interaction.locale] ?? userMustSpecifyAUserOrChannelLocales["en"]);
                }

                if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
                    return await interaction.reply(userCantSpecifyBothAUserAndAChannelLocales[interaction.locale] ?? userCantSpecifyBothAUserAndAChannelLocales["en"]);
                }

                if (interaction.options.getUser('user') !== null) {
                    const user = interaction.options.getUser('user');
                    if (settings.disable.user.includes(user.id)) {
                        settings.disable.user.splice(settings.disable.user.indexOf(user.id), 1);
                        await interaction.reply(removedUserFromDisableUserLocales[interaction.locale] ?? removedUserFromDisableUserLocales["en"]);
                    } else {
                        settings.disable.user.push(user.id);
                        await interaction.reply(addedUserToDisableUserLocales[interaction.locale] ?? addedUserToDisableUserLocales["en"]);
                    }
                } else if (interaction.options.getChannel('channel') !== null) {
                    const channel = interaction.options.getChannel('channel');
                    if (settings.disable.channel.includes(channel.id)) {
                        settings.disable.channel.splice(settings.disable.channel.indexOf(channel.id), 1);
                        await interaction.reply(removedChannelFromDisableChannelLocales[interaction.locale] ?? removedChannelFromDisableChannelLocales["en"]);
                    } else {
                        settings.disable.channel.push(channel.id);
                        await interaction.reply(addedChannelToDisableChannelLocales[interaction.locale] ?? addedChannelToDisableChannelLocales["en"]);
                    }
                } else if (interaction.options.getRole('role') !== null) {
                    const role = interaction.options.getRole('role');
                    if (settings.disable.role[interaction.guildId] === undefined) {
                        settings.disable.role[interaction.guildId] = [];
                    }
                    if (settings.disable.role[interaction.guildId].includes(role.id)) {
                        settings.disable.role[interaction.guildId].splice(settings.disable.role[interaction.guildId].indexOf(role.id), 1);
                        await interaction.reply(removedRoleFromDisableRoleLocales[interaction.locale] ?? removedRoleFromDisableRoleLocales["en"]);
                    } else {
                        settings.disable.role[interaction.guildId].push(role.id);
                        await interaction.reply(addedRoleToDisableRoleLocales[interaction.locale] ?? addedRoleToDisableRoleLocales["en"]);
                    }
                }
            } else if (interaction.options.getSubcommand() === 'bannedwords') {
                if (interaction.options.getString('word') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                    return await interaction.reply(iDonthavePermissionToManageMessagesLocales[interaction.locale] ?? iDonthavePermissionToManageMessagesLocales["en"]);
                }
                const word = interaction.options.getString('word');
                if (settings.bannedWords[interaction.guildId] === undefined) {
                    settings.bannedWords[interaction.guildId] = [];
                }
                if (settings.bannedWords[interaction.guildId].includes(word)) {
                    settings.bannedWords[interaction.guildId].splice(settings.bannedWords[interaction.guildId].indexOf(word), 1);
                    await interaction.reply(removedWordFromBannedWordsLocales[interaction.locale] ?? removedWordFromBannedWordsLocales["en"]);
                } else {
                    settings.bannedWords[interaction.guildId].push(word);
                    await interaction.reply(addedWordToBannedWordsLocales[interaction.locale] ?? addedWordToBannedWordsLocales["en"]);
                }
            } else if (interaction.options.getSubcommand() === 'defaultlanguage') {
                if (interaction.options.getString('language') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const language = interaction.options.getString('language');
                if (language === 'en' || language === 'ja') {
                    settings.defaultLanguage[interaction.guildId] = language;
                    await interaction.reply((setdefaultlanguagetolocales[interaction.locale] ?? setdefaultlanguagetolocales["en"]) + language.toString());
                } else {
                    await interaction.reply('You must specify either en or ja.');
                }
            } else if (interaction.options.getSubcommand() === 'editoriginaliftranslate') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const boolean = interaction.options.getBoolean('boolean');
                settings.editoriginaliftranslate[interaction.guildId] = boolean;
                await interaction.reply((seteditoriginaliftranslatetolocales[interaction.locale] ?? seteditoriginaliftranslatetolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommand() === 'setdefaultmediaasattachments') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const boolean = interaction.options.getBoolean('boolean');
                settings.sendMediaAsAttachmentsAsDefault[interaction.guildId] = boolean;
                await interaction.reply((setdefaultmediaasattachmentstolocales[interaction.locale] ?? setdefaultmediaasattachmentstolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommand() === 'deleteifonlypostedtweetlink') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const boolean = interaction.options.getBoolean('boolean');
                settings.deletemessageifonlypostedtweetlink[interaction.guildId] = boolean;
                await interaction.reply((setdeleteifonlypostedtweetlinktolocales[interaction.locale] ?? setdeleteifonlypostedtweetlinktolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
                if (interaction.options.getBoolean('secoundaryextractmode') !== null) {
                    settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[interaction.guild.id] = interaction.options.getBoolean('secoundaryextractmode');
                    await interaction.followUp((setdoitwhensecoundaryextractmodeisenabledtolocales[interaction.locale] ?? setdoitwhensecoundaryextractmodeisenabledtolocales["en"]) + convertBoolToEnableDisable(interaction.options.getBoolean('secoundaryextractmode'), interaction.locale));
                }
            } else if (interaction.options.getSubcommand() === 'alwaysreplyifpostedtweetlink') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const boolean = interaction.options.getBoolean('boolean');
                settings.alwaysreplyifpostedtweetlink[interaction.guildId] = boolean;
                await interaction.reply((setalwaysreplyifpostedtweetlinktolocales[interaction.locale] ?? setalwaysreplyifpostedtweetlinktolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommandGroup() === 'button') {
                if (interaction.options.getSubcommand() === 'invisible') {
                    if (settings.button_invisible[interaction.guildId] === undefined) settings.button_invisible[interaction.guildId] = button_invisible_template;
                    if (settings.button_invisible[interaction.guildId].savetweet === undefined) settings.button_invisible[interaction.guildId].savetweet = false;
                    //options: showMediaAsAttachments, showAttachmentsAsEmbedsImage, translate, delete, all;  all boolean
                    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('savetweet') === null && interaction.options.getBoolean('all') === null) {
                        return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                    }
                    if (interaction.options.getBoolean('all') !== null) {
                        if (interaction.options.getBoolean('all') === true) {
                            settings.button_invisible[interaction.guildId].showMediaAsAttachments = true;
                            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = true;
                            settings.button_invisible[interaction.guildId].translate = true;
                            settings.button_invisible[interaction.guildId].delete = true;
                            settings.button_invisible[interaction.guildId].savetweet = true;
                            await interaction.reply(addedAllButtonLocales[interaction.locale] ?? addedAllButtonLocales["en"]);
                        } else {
                            settings.button_invisible[interaction.guildId].showMediaAsAttachments = false;
                            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = false;
                            settings.button_invisible[interaction.guildId].translate = false;
                            settings.button_invisible[interaction.guildId].delete = false;
                            settings.button_invisible[interaction.guildId].savetweet = false;
                            await interaction.reply(removedAllButtonLocales[interaction.locale] ?? removedAllButtonLocales["en"]);
                        }
                    } else {
                        if (interaction.options.getBoolean('showmediaasattachments') !== null) {
                            settings.button_invisible[interaction.guildId].showMediaAsAttachments = interaction.options.getBoolean('showmediaasattachments');
                            await interaction.reply((setshowmediaasattachmentsbuttonLocales[interaction.locale] ?? setshowmediaasattachmentsbuttonLocales["en"]) + convertBoolToEnableDisable(!interaction.options.getBoolean('showmediaasattachments'), interaction.locale));
                        }
                        if (interaction.options.getBoolean('showattachmentsasembedsimage') !== null) {
                            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = interaction.options.getBoolean('showattachmentsasembedsimage');
                            await interaction.reply((setshowattachmentsasembedsimagebuttonLocales[interaction.locale] ?? setshowattachmentsasembedsimagebuttonLocales["en"]) + convertBoolToEnableDisable(!interaction.options.getBoolean('showattachmentsasembedsimage'), interaction.locale));
                        }
                        if (interaction.options.getBoolean('translate') !== null) {
                            settings.button_invisible[interaction.guildId].translate = interaction.options.getBoolean('translate');
                            await interaction.reply((settranslatebuttonLocales[interaction.locale] ?? settranslatebuttonLocales["en"]) + convertBoolToEnableDisable(!interaction.options.getBoolean('translate'), interaction.locale));
                        }
                        if (interaction.options.getBoolean('delete') !== null) {
                            settings.button_invisible[interaction.guildId].delete = interaction.options.getBoolean('delete');
                            await interaction.reply((setdeletebuttonLocales[interaction.locale] ?? setdeletebuttonLocales["en"]) + convertBoolToEnableDisable(!interaction.options.getBoolean('delete'), interaction.locale));
                        }
                        if (interaction.options.getBoolean('savetweet') !== null) {
                            settings.button_invisible[interaction.guildId].savetweet = interaction.options.getBoolean('savetweet');
                            await interaction.reply((setsavetweetbuttonLocales[interaction.locale] ?? setsavetweetbuttonLocales["en"]) + convertBoolToEnableDisable(!interaction.options.getBoolean('savetweet'), interaction.locale));
                        }
                    }
                } else if (interaction.options.getSubcommand() === 'disabled') {
                    if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
                        return await interaction.reply(userMustSpecifyAUserOrChannelLocales[interaction.locale] ?? userMustSpecifyAUserOrChannelLocales["en"]);
                    }

                    if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
                        return await interaction.reply(userCantSpecifyBothAUserAndAChannelLocales[interaction.locale] ?? userCantSpecifyBothAUserAndAChannelLocales["en"]);
                    }
                    if (settings.button_disabled[interaction.guildId] === undefined) settings.button_disabled[interaction.guildId] = button_disabled_template;
                    if (interaction.options.getUser('user') !== null) {
                        const user = interaction.options.getUser('user');
                        if (settings.button_disabled[interaction.guildId].user.includes(user.id)) {
                            settings.button_disabled[interaction.guildId].user.splice(settings.button_disabled[interaction.guildId].user.indexOf(user.id), 1);
                            await interaction.reply(removedUserFromDisableUserLocales[interaction.locale] ?? removedUserFromDisableUserLocales["en"]);
                        } else {
                            settings.button_disabled[interaction.guildId].user.push(user.id);
                            await interaction.reply(addedUserToDisableUserLocales[interaction.locale] ?? addedUserToDisableUserLocales["en"]);
                        }
                    } else if (interaction.options.getChannel('channel') !== null) {
                        const channel = interaction.options.getChannel('channel');
                        if (settings.button_disabled[interaction.guildId].channel.includes(channel.id)) {
                            settings.button_disabled[interaction.guildId].channel.splice(settings.button_disabled[interaction.guildId].channel.indexOf(channel.id), 1);
                            await interaction.reply(removedChannelFromDisableChannelLocales[interaction.locale] ?? removedChannelFromDisableChannelLocales["en"]);
                        } else {
                            settings.button_disabled[interaction.guildId].channel.push(channel.id);
                            await interaction.reply(addedChannelToDisableChannelLocales[interaction.locale] ?? addedChannelToDisableChannelLocales["en"]);
                        }
                    } else if (interaction.options.getRole('role') !== null) {
                        const role = interaction.options.getRole('role');
                        if (settings.button_disabled[interaction.guildId].role.includes(role.id)) {
                            settings.button_disabled[interaction.guildId].role.splice(settings.button_disabled[interaction.guildId].role.indexOf(role.id), 1);
                            await interaction.reply(removedRoleFromDisableRoleLocales[interaction.locale] ?? removedRoleFromDisableRoleLocales["en"]);
                        } else {
                            settings.button_disabled[interaction.guildId].role.push(role.id);
                            await interaction.reply(addedRoleToDisableRoleLocales[interaction.locale] ?? addedRoleToDisableRoleLocales["en"]);
                        }
                    }
                }
            } else if (interaction.options.getSubcommand() === 'extractbotmessage') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (settings.extract_bot_message[interaction.guildId] === undefined) settings.extract_bot_message[interaction.guildId] = false;
                const boolean = interaction.options.getBoolean('boolean');
                settings.extract_bot_message[interaction.guildId] = boolean;
                await interaction.reply((setextractbotmessagetolocales[interaction.locale] ?? setextractbotmessagetolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommand() === 'quoterepostdonotextract') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (settings.quote_repost_do_not_extract[interaction.guildId] === undefined) settings.quote_repost_do_not_extract[interaction.guildId] = false;
                const boolean = interaction.options.getBoolean('boolean');
                settings.quote_repost_do_not_extract[interaction.guildId] = boolean;
                await interaction.reply((setquoterepostdonotextracttolocales[interaction.locale] ?? setquoterepostdonotextracttolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommand() === 'quoterepostmaxdepth') {
                const depth = interaction.options.getInteger('depth');
                if (depth === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                settings.quote_repost_max_depth[interaction.guildId] = depth;
                const depthText = depth === 0 ? (interaction.locale === 'ja' ? '無制限' : 'unlimited') : depth.toString();
                await interaction.reply((setquoterepostmaxdepthtolocales[interaction.locale] ?? setquoterepostmaxdepthtolocales["en"]) + depthText);
            } else if (interaction.options.getSubcommand() === 'legacymode') {
                if (settings.secondary_extract_mode[interaction.guildId] === true) settings.secondary_extract_mode[interaction.guildId] = false;
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (settings.legacy_mode[interaction.guildId] === undefined) settings.legacy_mode[interaction.guildId] = false;
                const boolean = interaction.options.getBoolean('boolean');
                settings.legacy_mode[interaction.guildId] = boolean;
                await interaction.reply((setlegacymodetolocales[interaction.locale] ?? setlegacymodetolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
                if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) await interaction.followUp("※BOTにメッセージの管理権限を付与するとdiscord純正の埋め込みのみを削除して今まで通りの展開が行われます。\nこのBOTにメッセージの管理権限を付与することを検討してみてください。\n(使用感はdiscordがリンクの展開を修正する前と変わらなくなります。)")
            } else if (interaction.options.getSubcommand() === 'passivemode') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (settings.passive_mode[interaction.guildId] === undefined) settings.passive_mode[interaction.guildId] = false;
                const boolean = interaction.options.getBoolean('boolean');
                settings.passive_mode[interaction.guildId] = boolean;
                await interaction.reply((setpassivemodetolocales[interaction.locale] ?? setpassivemodetolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommand() === 'secondaryextractmode') {
                if (settings.legacy_mode[interaction.guildId] === true) settings.legacy_mode[interaction.guildId] = false; 
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (settings.secondary_extract_mode[interaction.guildId] === undefined) settings.secondary_extract_mode[interaction.guildId] = false;
                const boolean = interaction.options.getBoolean('boolean');
                settings.secondary_extract_mode[interaction.guildId] = boolean;
                await interaction.reply((setsecondaryextractmodetolocales[interaction.locale] ?? setsecondaryextractmodetolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
            } else if (interaction.options.getSubcommand() === 'secondaryextracttarget') {
                if (interaction.options.getBoolean('multipleimages') === null && interaction.options.getBoolean('video') === null) {
                    return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                }
                if (settings.secondary_extract_mode_multiple_images[interaction.guildId] === undefined) settings.secondary_extract_mode_multiple_images[interaction.guildId] = true;
                if (settings.secondary_extract_mode_video[interaction.guildId] === undefined) settings.secondary_extract_mode_video[interaction.guildId] = true;

                const response = [];
                if (interaction.options.getBoolean('multipleimages') !== null) {
                    const multipleImages = interaction.options.getBoolean('multipleimages');
                    settings.secondary_extract_mode_multiple_images[interaction.guildId] = multipleImages;
                    response.push((setsecondaryextracttargetmultipleimagestolocales[interaction.locale] ?? setsecondaryextracttargetmultipleimagestolocales["en"]) + convertBoolToEnableDisable(multipleImages, interaction.locale));
                }
                if (interaction.options.getBoolean('video') !== null) {
                    const video = interaction.options.getBoolean('video');
                    settings.secondary_extract_mode_video[interaction.guildId] = video;
                    response.push((setsecondaryextracttargetvideotolocales[interaction.locale] ?? setsecondaryextracttargetvideotolocales["en"]) + convertBoolToEnableDisable(video, interaction.locale));
                }
                await interaction.reply(response.join('\n'));
            } else {
                return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
            }
        } else {
            switch (interaction.options.getSubcommand()) {
                case 'disable':
                    if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null && interaction.options.getRole('role') === null) {
                        return await interaction.reply(userMustSpecifyAUserOrChannelLocales[interaction.locale] ?? userMustSpecifyAUserOrChannelLocales["en"]);
                    }
                    if ((interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) || (interaction.options.getUser('user') !== null && interaction.options.getRole('role') !== null) || (interaction.options.getChannel('channel') !== null && interaction.options.getRole('role') !== null)) {
                        return await interaction.reply(userCantSpecifyBothAUserAndAChannelLocales[interaction.locale] ?? userCantSpecifyBothAUserAndAChannelLocales["en"]);
                    }
                    if (interaction.options.getUser('user') !== null) {
                        const user = interaction.options.getUser('user');
                        if (user.id !== interaction.user.id) return await interaction.reply(userCantUseThisCommandForOtherUsersLocales[interaction.locale] ?? userCantUseThisCommandForOtherUsersLocales["en"]);
                        if (settings.disable.user.includes(user.id)) {
                            settings.disable.user.splice(settings.disable.user.indexOf(user.id), 1);
                            await interaction.reply(removedUserFromDisableUserLocales[interaction.locale] ?? removedUserFromDisableUserLocales["en"]);
                        } else {
                            settings.disable.user.push(user.id);
                            await interaction.reply(addedUserToDisableUserLocales[interaction.locale] ?? addedUserToDisableUserLocales["en"]);
                        }
                    } else if (interaction.options.getChannel('channel') !== null || interaction.options.getRole('role') !== null) {
                        return await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                    }
                    break;
                case 'bannedwords':
                case 'defaultlanguage':
                case 'editoriginaliftranslate':
                case 'setdefaultmediaasattachments':
                case 'deleteifonlypostedtweetlink':
                case 'alwaysreplyifpostedtweetlink':
                case 'button':
                case 'extractbotmessage':
                case 'quoterepostdonotextract':
                case 'quoterepostmaxdepth':
                case 'legacymode':
                case 'passivemode':
                case 'secondaryextractmode':
                case 'secondaryextracttarget':
                    await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                    break;
                default:
                    return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
            }

        }
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
    } else if (interaction.commandName === 'showsavetweet') {
        //saves/{userid}があるか確認する
        const userid = interaction.user.id;
        if (!fs.existsSync('./saves/' + userid)) return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
        const dirs = fs.readdirSync('./saves/' + userid);
        if (dirs.length === 0) return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
        //options: idが指定されているか確認する。設定されているならそのツイートを表示する。設定されていないなら一覧を表示する。
        if (interaction.options.getString('id') === null) {
            let content = '';
            dirs.forEach(element => {
                //./saves/{userid}/{element}/data.jsonを読み込み、textの先頭10文字を取得する
                const data = fs.readFileSync('./saves/' + userid + '/' + element + '/data.json', 'utf-8');
                const json = JSON.parse(data);
                content += json.text.substring(0, 9) + '... Posted By ' + json.user_name + '(tweetid:' + element + ')\n';
            });
            await interaction.reply({
                embeds: [
                    {
                        title: 'Saved tweets',
                        description: content,
                        color: 0x1DA1F2
                    }
                ]
            });
        } else {
            await interaction.deferReply({ ephemeral: true });
            //./saves/{userid}/{id}があるか確認する
            let filePath = userid + '/' + interaction.options.getString('id')
            try{
                antiDirectoryTraversalAttack(filePath)
            }catch (e){
                return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
            }
            if (!fs.existsSync("./saves/" + filePath)) return await interaction.editReply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
            await interaction.editReply({ content: '処理中です...' });;
            await sendTweetEmbed(interaction, "https://twidata.sprink.cloud/data/" + filePath + "/data.json", false);
            //await sendTweetEmbed(interaction, "http://localhost:3088/data/" + filePath+ "/data.json", false);
            await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
        }
    } else if (interaction.commandName === 'deletesavetweet') {
        //saves/{userid}があるか確認する
        const userid = interaction.user.id;
        if (!fs.existsSync('./saves/' + userid)) return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
        const dirs = fs.readdirSync('./saves/' + userid);
        if (dirs.length === 0) return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
        //options: idが指定されているか確認する。設定されているならそのツイートを削除する。設定されていないなら一覧を表示する。
        if (interaction.options.getString('id') === null) {
            let content = '';
            dirs.forEach(element => {
                content += element + '\n';
            });
            await interaction.reply({
                embeds: [
                    {
                        title: 'Saved tweets',
                        description: content,
                        color: 0x1DA1F2
                    }
                ]
            });
        } else {
            const id = interaction.options.getString('id');
            let filePath = userid + '/' + id;
            try{
                filePath = antiDirectoryTraversalAttack(filePath)
            }catch (e){
                return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
            }
            if (!fs.existsSync(filePath)) return await interaction.reply(userDonthaveSavedTweetLocales[interaction.locale] ?? userDonthaveSavedTweetLocales["en"]);
            fs.rmdirSync(filePath, { recursive: true });
            await interaction.reply(deletedSavedTweetLocales[interaction.locale] ?? deletedSavedTweetLocales["en"]);
        }
    } else if (interaction.commandName === 'savetweetquotaoverride') {
        if (interaction.user.id === '796972193287503913') {
            if (interaction.options.getInteger('newquota') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
            const quota = interaction.options.getInteger('newquota');
            let user = interaction.options.getUser('user');
            if (user === null) user = interaction.user;
            const userid = user.id;
            settings.save_tweet_quota_override[userid] = quota;
            await interaction.reply((setsavetweetquotaoverridetolocales[interaction.locale] ?? setsavetweetquotaoverridetolocales["en"]) + quota.toString());
        } else {
            await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
        }
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
    } else if (interaction.commandName === 'quotastats') {
        let user = interaction.options.getUser('user');
        if (user === null) user = interaction.user;
        const userid = user.id;
        let quota = 100 * 1024 * 1024;
        if (settings.save_tweet_quota_override[userid] !== undefined) quota = settings.save_tweet_quota_override[userid];
        const dirs = fs.readdirSync('./saves/' + userid);
        let used = 0;
        for (let i = 0; i < dirs.length; i++) {
            const element = dirs[i];
            const dir2 = fs.readdirSync('./saves/' + userid + '/' + element);
            for (let j = 0; j < dir2.length; j++) {
                const element2 = dir2[j];
                const stats = fs.statSync('./saves/' + userid + '/' + element + '/' + element2);
                used += stats.size;
            }
        }
        used = used / 1024 / 1024;
        quota = quota / 1024 / 1024;
        if (used >= 1024) used = (used / 1024).toFixed(2) + 'GB';
        else used = used.toFixed(2) + 'MB';
        if (quota >= 1024) quota = (quota / 1024).toFixed(2) + 'GB';
        else quota = quota.toFixed(2) + 'MB';
        await interaction.reply({
            embeds: [
                {
                    title: 'Quota stats',
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Used',
                            value: used.toString()
                        },
                        {
                            name: 'Quota',
                            value: quota.toString()
                        }
                    ]
                }
            ]
        });
    } else if (interaction.commandName === 'checkmyguildsettings') {
        const embeds = [];
        if (interaction.options.getString('guildid') !== null && interaction.user.id !== '796972193287503913') return await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
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
    } else if (interaction.commandName === 'autoextract') {
        return interaction.reply("現在データベースサーバー障害によりこの機能はご利用いただけません");
        /*
        列	型	コメント
        id	int(20) 連番	
        userid	bigint(20)	
        username	text NULL	
        lastextracted	bigint(20) [0]	
        webhook	text NULL	
        created_at	bigint(20)	
        premium_flag	int(10) [0]	
        premium_code	text NULL
 
        索引
        PRIMARY	id
        INDEX	userid
 
        外部キー
        ソース	ターゲット	ON DELETE	ON UPDATE
        userid	users(userid)	RESTRICT	RESTRICT
        */
        switch (interaction.options.getSubcommand()) {
            case "list":
                connection.query('SELECT * FROM rss WHERE userid = ?', [interaction.user.id], async function (error, results, fields) {
                    if (error) throw error;
                    if (results.length === 0) return await interaction.reply({ embeds: [{ title: 'Auto extract list', description: 'データが登録されていません。', color: 0x1DA1F2 }] });
                    let content = '';
                    results.forEach(element => {
                        if (element.webhook === null) return;
                        content += element.id + ': [' + element.username + '](https://twitter.com/' + element.username + ') [WEBHOOK](' + element.webhook + ')\n';
                    });
                    await interaction.reply({
                        embeds: [
                            {
                                title: 'Auto extract list',
                                description: content,
                                color: 0x1DA1F2
                            }
                        ],
                        flags: 64
                    });
                }
                );
                break;
            case "add":
                let premium_flag = 0;
                //premiun_flagが0でuseridが一致するレコードが5件以上あるか確認する
                let additional_autoextraction_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM users WHERE userid = ?', [interaction.user.id], async function (error, results, fields) {
                        if (error) throw error;
                        if (results.length === 0) {
                            connection.query('INSERT INTO users (userid, register_date) VALUES (?, ?)', [interaction.user.id, new Date().getTime()], async function (error, results, fields) {
                                if (error) throw error;
                            });
                            return resolve(0);
                        }
                        return resolve(results[0].additional_autoextraction_slot);
                    });
                });
                const limit_free_check = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE premium_flag = 0', [], async function (error, results, fields) {
                        if (error) throw error;
                        if (results.length < 175) return resolve(true);
                        resolve(false);
                    });
                });
                if (!limit_free_check && additional_autoextraction_slot === 0) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '無料枠の登録は上限に達しているため追加できません。', color: 0x1DA1F2 }] });
                const over_5_check = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 0', [interaction.user.id], async function (error, results, fields) {
                        if (error) throw error;
                        if (results.length >= 5) return resolve(false);
                        resolve(true);
                    });
                });
                if (!over_5_check && additional_autoextraction_slot === 0) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '5件以上の登録はできません。', color: 0x1DA1F2 }] });
                const now_using_additional_autoextraction_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 1', [interaction.user.id], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results.length);
                    });
                });
                if (additional_autoextraction_slot != 0 && (now_using_additional_autoextraction_slot >= additional_autoextraction_slot) && (!over_5_check || !limit_free_check)) {
                    return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '支援者優先枠の登録上限に達しているため追加できません。', color: 0x1DA1F2 }] });
                } else if (additional_autoextraction_slot != 0 && (now_using_additional_autoextraction_slot < additional_autoextraction_slot) && (over_5_check || limit_free_check)) {
                    premium_flag = 1;
                }

                const username = interaction.options.getString('username');
                const webhooks = interaction.options.getString('webhook');
                const webhooks_array = webhooks.split(',');
                for (let i = 0; i < webhooks_array.length; i++) {
                    const webhook = webhooks_array[i];
                    if (username === null || webhook === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                    //usernameが存在するか確認する(数字とアルファベットと_のみで構成されているか確認する)
                    if (!username.match(/^[0-9a-zA-Z_]+$/)) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたユーザーは無効です。\n[入力されたユーザー](https://twitter.com/' + username + ')', color: 0x1DA1F2 }] });
                    //webhookが正しい形式か確認する
                    if (!webhook.match(/^https:\/\/discord.com\/api\/webhooks\/[0-9]+\/[a-zA-Z0-9_-]+$/)) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたWEBHOOKは正しい形式ではないか、無効です。', color: 0x1DA1F2 }] });
                    //webhookにテストメッセージを送信する
                    const webhookResponse = await fetch(webhook, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ embeds: [{ title: 'このチャンネルにツイートを送信します', description: 'これはComebackTwitterEmbedの新着自動展開機能の登録確認メッセージです。\n今後はこのチャンネルに[' + username + '](https://twitter.com/' + username + ')のツイートが更新されるたびに通知を行います。' }] })
                    });
                    if (webhookResponse.status !== 204) return await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '指定されたWEBHOOKは正しい形式ではないか、無効です。', color: 0x1DA1F2 }] });
                    connection.query('INSERT INTO rss (userid, username, lastextracted, webhook, created_at, premium_flag) VALUES (?, ?, ?, ?, ?, ?)', [interaction.user.id, username, new Date().getTime(), webhook, new Date().getTime(), premium_flag], async function (error, results, fields) {
                        if (error) throw error;
                        await interaction.reply({ embeds: [{ title: 'Auto extract add', description: '登録が完了しました。\n[登録されたユーザー](https://twitter.com/' + username + ')', color: 0x1DA1F2 }] });
                    });
                }
                break;
            case "delete":
                const id = interaction.options.getInteger('id');
                if (id === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                //idが数字か確認する
                if (isNaN(id)) return await interaction.reply("指定されたIDは数字ではありません。");
                connection.query('DELETE FROM rss WHERE userid = ? AND id = ?', [interaction.user.id, id], async function (error, results, fields) {
                    if (error) throw error;
                    if (results.affectedRows === 0) return await interaction.reply("指定されたIDの登録は存在しません。");
                    await interaction.reply({ embeds: [{ title: 'Auto extract delete', description: '削除が完了しました。', color: 0x1DA1F2 }] });
                });
                break;
            case "additionalautoextractslot":
                /*
                列	型	コメント
                userid	bigint(20)	
                plan	int(11) [0]	
                paid_plan_expired_at	bigint(20) [0]	
                register_date	bigint(20)	
                additional_autoextraction_slot	int(11) [0]	
                save_tweet_quota_override	bigint(20) NULL	
                enabled	tinyint(4) [1]	
                */
                //796972193287503913以外は実行を拒否
                if (interaction.user.id !== '796972193287503913') return await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                const slot = interaction.options.getInteger('slot');
                const user = interaction.options.getUser('user');
                //データベースにuseridが存在するか確認する  
                let additional_autoextraction_slot_data = await new Promise(resolve => {
                    connection.query('SELECT * FROM users WHERE userid = ?', [user.id], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results.length)
                    });
                });
                //存在しない場合は登録する
                //存在する場合はadditional_autoextraction_slotをoption(slot)する

                if (slot === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (slot < 1) return await interaction.reply("追加スロットは1以上で指定してください。");
                if (additional_autoextraction_slot_data === 0) {
                    connection.query('INSERT INTO users (userid, register_date, additional_autoextraction_slot) VALUES (?, ?, ?)', [user.id, new Date().getTime(), slot], async function (error, results, fields) {
                        if (error) throw error;
                        await interaction.reply({ embeds: [{ title: 'Auto extract additional slot', description: '追加スロットの登録が完了しました。', color: 0x1DA1F2 }] });
                    });
                } else {
                    connection.query('UPDATE users SET additional_autoextraction_slot = ? WHERE userid = ?', [slot, user.id], async function (error, results, fields) {
                        if (error) throw error;
                        await interaction.reply({ embeds: [{ title: 'Auto extract additional slot', description: '追加スロットの変更が完了しました。', color: 0x1DA1F2 }] });
                    });
                }
                break;
            case "checkfreeslot":
                const free_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE premium_flag = 0', [], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results.length);
                    });
                });
                //無料枠の空き数と支援者優先枠の空き数を表示する。また、支援者優先枠の空き数が0の場合はその旨を表示する。さらに、全体の空き数と使用数、使用率を表示する。
                const premium_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE premium_flag = 1', [], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results.length);
                    });
                });
                const user_using_free_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 0', [interaction.user.id], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results.length);
                    });
                });
                const user_using_premium_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM rss WHERE userid = ? AND premium_flag = 1', [interaction.user.id], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results.length);
                    });
                });
                const user_have_additional_autoextraction_slot = await new Promise(resolve => {
                    connection.query('SELECT * FROM users WHERE userid = ?', [interaction.user.id], async function (error, results, fields) {
                        if (error) throw error;
                        return resolve(results[0].additional_autoextraction_slot);
                    });
                });
                const all_using_slot = free_slot + premium_slot;
                const all_free_slot = 175;
                const all_donater_slot = 150;
                const all_slot = all_free_slot + all_donater_slot;
                const free_slot_percent = Math.floor((free_slot / all_free_slot) * 100);
                const premium_slot_percent = Math.floor((premium_slot / all_donater_slot) * 100);
                const all_using_slot_percent = Math.floor((all_using_slot / all_slot) * 100);
                let content = '';
                content += '無料枠の空き数: ' + (all_free_slot - free_slot) + '/' + all_free_slot + ' (' + free_slot_percent + '%)\n';
                content += '支援者優先枠の空き数: ' + (all_donater_slot - premium_slot) + '/' + all_donater_slot + ' (' + premium_slot_percent + '%)\n';
                content += 'あなたの無料枠の使用数: ' + user_using_free_slot + '/' + free_slot + '\n';
                content += 'あなたの支援者優先枠の使用数: ' + user_using_premium_slot + '/' + premium_slot + '\n';
                content += 'あなたの追加スロットの使用数: ' + user_using_premium_slot + '/' + user_have_additional_autoextraction_slot + '\n';
                content += '全体の使用数: ' + all_using_slot + '/' + all_slot + ' (' + all_using_slot_percent + '%)\n';
                await interaction.reply({ embeds: [{ title: 'Auto extract check free slot', description: content, color: 0x1DA1F2 }] });
                break;


        }
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.MessageComponent || interaction.type === InteractionType.ApplicationCommand) return;
    await interaction.deferReply({ ephemeral: true });
    if (settings.button_disabled[interaction.guildId] !== undefined) {
        if (settings.button_disabled[interaction.guildId].user.includes(interaction.user.id)) {
            await interaction.editReply({ content: userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            return;
        }
        if (settings.button_disabled[interaction.guildId].channel.includes(interaction.channel.id)) {
            await interaction.editReply({ content: userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            return;
        }
        let role = false;
        settings.button_disabled[interaction.guildId].role.forEach(element => {
            if (ifUserHasRole(interaction.member, element)) {
                role = true;
            }
        });
        if (role) {
            await interaction.editReply({ content: userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            return;
        }
    }
    const deleteButton = new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel('Delete').setCustomId('delete');
    const translateButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Translate').setCustomId('translate');
    const showAttachmentsAsMediaButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showAttachmentsAsEmbedsImagebuttonLocales[interaction.locale] ?? showAttachmentsAsEmbedsImagebuttonLocales["en"]).setCustomId('showAttachmentsAsEmbedsImage');
    const showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showMediaAsAttachmentsButtonLocales[interaction.locale] ?? showMediaAsAttachmentsButtonLocales["en"]).setCustomId('showMediaAsAttachments');

    switch (interaction.customId) {
        case 'showMediaAsAttachments':
            const messageObject = {};
            messageObject.components = [{ type: ComponentType.ActionRow, components: [showAttachmentsAsMediaButton] }];
            messageObject.components.push({ type: ComponentType.ActionRow, components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton] });
            messageObject.files = [];
            messageObject.embeds = [];
            interaction.message.embeds.forEach(element => {
                if (element.image) {
                    messageObject.files.push(element.image.url);
                }
            });
            let deepCopyEmbed0 = JSON.parse(JSON.stringify(interaction.message.embeds[0]));
            delete deepCopyEmbed0.image;
            messageObject.embeds.push(deepCopyEmbed0);
            if (messageObject.embeds[0].image) delete messageObject.embeds.image;
            messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId);
            await interaction.message.edit(messageObject);
            await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            break;

        case 'showAttachmentsAsEmbedsImage':
            const messageObject2 = {};
            if (interaction.message.attachments === undefined || interaction.message.attachments === null) return interaction.reply('There are no attachments to show.');
            const attachments = interaction.message.attachments.map(attachment => attachment.url);
            if (attachments.length > 4) return interaction.reply('You can\'t show more than 4 attachments as embeds image.');
            messageObject2.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
            messageObject2.components.push({ type: ComponentType.ActionRow, components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton] });
            messageObject2.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject2.components, interaction.guildId);
            messageObject2.embeds = [];
            attachments.forEach(element => {
                const extension = element.split("?").pop().split('.').pop();
                if (videoExtensions.includes(extension)) {
                    messageObject2.files.push(element);
                    return;
                }
                if (messageObject2.embeds.length === 0) {
                    let embed = {};
                    embed.url = interaction.message.embeds[0].url;
                    if (interaction.message.embeds[0].title !== undefined) embed.title = interaction.message.embeds[0].title;
                    embed.description = interaction.message.embeds[0].description;
                    embed.color = interaction.message.embeds[0].color;
                    embed.author = interaction.message.embeds[0].author;
                    if (interaction.message.embeds[0].footer !== undefined) embed.footer = interaction.message.embeds[0].footer;
                    embed.timestamp = interaction.message.embeds[0].timestamp;
                    if (interaction.message.embeds[0].fields !== undefined) embed.fields = interaction.message.embeds[0].fields;
                    embed.image = {
                        url: element
                    };
                    messageObject2.embeds.push(embed);
                    return
                }
                messageObject2.embeds.push({
                    url: messageObject2.embeds[0].url,
                    image: {
                        url: element
                    }
                });
            });
            messageObject2.files = [];
            await interaction.message.edit(messageObject2);
            await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            break;

        case 'delete':
            if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                await interaction.message.delete();
                await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
            } else {
                if (interaction.message.embeds[0].author.name.split(":")[1].split(")")[0] != interaction.user.id) {
                    await interaction.editReply({ content: youcantdeleteotherusersmessagesLocales[interaction.locale] ?? youcantdeleteotherusersmessagesLocales["en"], ephemeral: true });
                    setTimeout(() => {
                        interaction.deleteReply();
                    }, 3000);
                    return;
                }
                await interaction.message.delete();
                await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
            }
            break;

        case 'translate':
            const messageObject3 = {};
            messageObject3.components = [];
            messageObject3.embeds = [];
            const copyEmbedObject = {};
            copyEmbedObject.title = interaction.message.embeds[0].title;
            copyEmbedObject.url = interaction.message.embeds[0].url;
            copyEmbedObject.color = interaction.message.embeds[0].color;
            copyEmbedObject.author = interaction.message.embeds[0].author;
            copyEmbedObject.footer = interaction.message.embeds[0].footer;
            copyEmbedObject.timestamp = interaction.message.embeds[0].timestamp;
            copyEmbedObject.fields = interaction.message.embeds[0].fields;
            if (interaction.message.embeds[0].images) {
                copyEmbedObject.image = interaction.message.embeds[0].image;
            }
            if (interaction.message.embeds[0].thumbnail) copyEmbedObject.thumbnail = interaction.message.embeds[0].thumbnail;
            messageObject3.embeds.push(copyEmbedObject);
            if (interaction.message.embeds.length > 1) {
                for (let i = 1; i < interaction.message.embeds.length; i++) {
                    messageObject3.embeds.push(interaction.message.embeds[i]);
                }
            }
            let target = interaction.locale;
            if (target.startsWith("en-")) target = 'en';
            if (target === 'jp') target = 'ja';
            const responce = await fetch("https://script.google.com/macros/s/AKfycbwmofa3n_K15ze_-4KrpH-B-eBHiKXmmgLeqsJInS3dJUDM0IJ-627h8Xu-w8PIc2f-ug/exec?target=" + target + "&text=" + encodeURIComponent(interaction.message.embeds[0].description.split('\n').splice(0, interaction.message.embeds[0].description.split('\n').length - 3).join('\n')));
            let text = await responce.text();
            text = text + interaction.message.embeds[0].description.split('\n').splice(interaction.message.embeds[0].description.split('\n').length - 4, interaction.message.embeds[0].description.split('\n').length).join('\n')
            messageObject3.embeds[0].description = text;
            messageObject3.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject3.components, interaction.guildId);
            await interaction.editReply(messageObject3);
            if (settings.editOriginalIfTranslate[interaction.guildId] === true) {
                if (interaction.message.attachments.length > 0) {
                    messageObject3.files = [];
                    interaction.message.attachments.forEach(element => {
                        messageObject3.files.push(element.url);
                    });
                }
                messageObject3.components = interaction.message.components;
                await interaction.message.edit(messageObject3);
            }
        case 'savetweet':
            //save tweet data to local
            //store tweet data to ./saves/{userid}/{tweetid}/data.json
            //store tweet media to ./saves/{userid}/{tweetid}/{mediaid}.{extension}
            //if ./saves/{userid} folder is over 100MB, tell user to delete some tweet data
            if (!fs.existsSync('./saves')) fs.mkdirSync('./saves');
            if (!fs.existsSync('./saves/' + interaction.user.id)) fs.mkdirSync('./saves/' + interaction.user.id);

            //tweet url may has query string, so remove it
            let tweetUrl = interaction.message.embeds[0].url.split('?')[0];
            tweetUrl = tweetUrl.replace('twitter.com', 'api.vxtwitter.com').replace('x.com', 'api.vxtwitter.com')
            const tweetId = tweetUrl.split('/').pop();
            if (!fs.existsSync('./saves/' + interaction.user.id + '/' + tweetId)) fs.mkdirSync('./saves/' + interaction.user.id + '/' + tweetId);
            const fetchdata = await fetch(tweetUrl);
            let tweetData = await fetchdata.json();
            tweetData = tweetData;

            for (let i = 0; i < tweetData.mediaURLs.length; i++) {
                let element = tweetData.mediaURLs[i];
                //remove query string
                element = element.split('?')[0];
                //download tweet media
                await new Promise(resolve => {
                    element = element.split('?')[0];
                    const downloadStream = https.get(element, (res) => {
                        const path = './saves/' + interaction.user.id + '/' + tweetId + '/' + element.split('/').pop();
                        const filePath = fs.createWriteStream(path);
                        res.pipe(filePath);
                        filePath.on('finish', () => {
                            filePath.close();
                            resolve();
                        });
                    });
                });
            }
            //download tweet profile image
            await new Promise(resolve => {
                //remove query string
                tweetData.user_profile_image_url = tweetData.user_profile_image_url.split('?')[0];
                const downloadStream = https.get(tweetData.user_profile_image_url, (res) => {
                    const path = './saves/' + interaction.user.id + '/' + tweetId + '/' + tweetData.user_profile_image_url.split('/').pop();
                    const filePath = fs.createWriteStream(path);
                    res.pipe(filePath);
                    filePath.on('finish', () => {
                        filePath.close();
                        resolve();
                    });
                });
            });
            tweetData.user_profile_image_url = "https://twidata.sprink.cloud/data/" + interaction.user.id + "/" + tweetId + "/" + tweetData.user_profile_image_url.split('/').pop();
            if (tweetData.mediaURLs.length !== 0) {
                for (let i = 0; i < tweetData.mediaURLs.length; i++) {
                    let element = tweetData.mediaURLs[i];
                    tweetData.mediaURLs[i] = "https://twidata.sprink.cloud/data/" + interaction.user.id + "/" + tweetId + "/" + element.split('/').pop();
                }
            }
            fs.writeFileSync('./saves/' + interaction.user.id + '/' + tweetId + '/data.json', JSON.stringify(tweetData, null, 4));

            //check if ./saves/{userid} folder is over 20MB
            let totalSize = 0;
            const dirs = fs.readdirSync('./saves/' + interaction.user.id);
            dirs.forEach(element => {
                const dir = fs.readdirSync('./saves/' + interaction.user.id + '/' + element);
                dir.forEach(element2 => {
                    totalSize += fs.statSync('./saves/' + interaction.user.id + '/' + element + '/' + element2).size;
                });
            });
            //1MB
            if (totalSize > (settings.save_tweet_quota_override[interaction.user.id] ?? 100 * 1024 * 1024)) {
                //delete tweet data
                fs.rmSync('./saves/' + interaction.user.id + '/' + tweetId, { recursive: true });
                await interaction.editReply({ content: "あなたが保存したツイートのデータ量が許可された保存容量を超えています。新しくツイートを保存する前に既存のものを削除してください", ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
                return;
            }

            await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });

    }
});

client.rest.on("rateLimited", (data) => {
    console.log("Rate limited: " + data.timeToReset + "ms");
    console.log(data);
});

client.login(config.token);
