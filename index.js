//discord.js v14
const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel], shards: 'auto' });
const config = require('./config.json');
const fetch = require('node-fetch');
const fs = require('fs');
const { send } = require('process');
const mysql = require('mysql');

const connection = mysql.createConnection({
    host: '192.168.100.22',
    user: 'comebacktwitterembed',
    password: 'bluebird',
    database: 'ComebackTwitterEmbed'
});

// MySQLに接続
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        return;
    }
    console.log('Connected to database');
});

let processed = 0;
let processed_hour = 0;
let processed_day = 0;

const must_be_main_instance = true;

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
        "legacy_mode" : {}
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
        connection.query('INSERT INTO stats (timestamp, joinedServersCount, usersCount, channelsCount, minutes, hours, days) VALUES (?, ?, ?, ?, ?, ?, ?)', [new Date().getTime(), client.guilds.cache.size, client.users.cache.size, client.channels.cache.size, processed_column, processed_hour_column, processed_day_column], (err, results, fields) => {
            if (err) {
                console.error('Error connecting to database:', err);
                return;
            }
        });
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
                }
            ]
        }
    ]);
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
    if (setting === null) setting = settings;
    if (setting.button_invisible[guildId] === undefined || (setting.button_invisible[guildId].showMediaAsAttachments === false && setting.button_invisible[guildId].showAttachmentsAsEmbedsImage === false && setting.button_invisible[guildId].translate === false && setting.button_invisible[guildId].delete === false)) return components;
    for (let i = 0; i < components.length; i++) {
        const element = components[i];
        if (element.components === undefined) continue;
        if (element.components.length === 0) continue;
        for (let j = 0; j < element.components.length; j++) {
            const element2 = element.components[j].data;
            if (element2.custom_id === undefined) continue;
            if (element2.custom_id === 'showMediaAsAttachments' && setting.button_invisible[guildId].showMediaAsAttachments === true) {
                element.components.splice(j, 1);
                j--;

            }
            if (element2.custom_id === 'showAttachmentsAsEmbedsImage' && setting.button_invisible[guildId].showAttachmentsAsEmbedsImage === true) {
                element.components.splice(j, 1);
                j--;

            }
            if (element2.custom_id === 'translate' && setting.button_invisible[guildId].translate === true) {
                element.components.splice(j, 1);
                j--;

            }
            if (element2.custom_id === 'delete' && setting.button_invisible[guildId].delete === true) {
                element.components.splice(j, 1);
                j--;

            }
        }
    }
    for (let i = 0; i < components.length; i++) {
        const element = components[i];
        if (element.components === undefined) continue;
        if (element.components.length === 0) {
            components.splice(i, 1);
            i--;
        }
    }
    return components;
}

async function sendTweetEmbed(message, url, quoted = false, parent = null) {
    return new Promise((resolve, reject) => {
        const element = url;
        //replace twitter.com or x.com with api.vxtwitter.com
        var newUrl = element.replace(/twitter.com|x.com/g, 'api.vxtwitter.com');
        if (newUrl.split("/").length > 6) {
            newUrl = newUrl.split("/").slice(0, 6).join("/");
        }
        //fetch the api
        fetch(newUrl)
            .then(res => {
                return res.json().catch(err => {
                    //返答を記録する
                    //もしerror_responseフォルダがなければ作る
                    if (!fs.existsSync('./error_response')) {
                        fs.mkdirSync('./error_response');
                    }
                    //error_responseフォルダに返答を記録する
                    fs.writeFile('./error_response/' + new Date().getTime() + '.json', newUrl + "\n\n" + JSON.stringify(res.text(), null, 2), (err) => {
                        if (err) {
                            console.error(err);
                            return;
                        }
                    });
                    throw err;
                })
            })
            .then(async json => {
                attachments = [];
                let embeds = [];
                let showMediaAsAttachmentsButton = null;
                const deleteButton = new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(getStringFromObject(deleteButtonLabelLocales, settings.defaultLanguage[message.guild.id] ?? "en")).setCustomId('delete');
                const translateButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(translateButtonLabelLocales, settings.defaultLanguage[message.guild.id] ?? "en")).setCustomId('translate');
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
                if(settings.deletemessageifonlypostedtweetlink[message.guild.id] === undefined) settings.deletemessageifonlypostedtweetlink[message.guild.id] = false;
                if(settings.legacy_mode[message.guild.id] === undefined) settings.legacy_mode[message.guild.id] = false;
                if (settings.legacy_mode[message.guild.id] === false && !quoted && (settings.deletemessageifonlypostedtweetlink[message.guild.id] === false || (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content != url))) {
                    embed = {
                        //title: json.user_name,
                        url: json.tweetURL,
                        description: /*json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n*/':speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: 'request by ' + message.author.username + '(id:' + message.author.id + ')',
                        },
                        //footer: {
                        //    text: 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')',
                        //    icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
                        //},
                        timestamp: new Date(json.date),
                    };
                } else {
                    embed = {
                        title: json.user_name,
                        url: json.tweetURL,
                        description: json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n:speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: 'request by ' + message.author.username + '(id:' + message.author.id + ')',
                        },
                        footer: {
                            text: 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')',
                            icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
                        },
                        timestamp: new Date(json.date),
                    };
                }

                if (json.mediaURLs?.length > 0) {
                    if (json.mediaURLs.length > 4 || settings.sendMediaAsAttachmentsAsDefault[message.guild.id] === true) {
                        if (json.mediaURLs.length > 10) {
                            json.mediaURLs = json.mediaURLs.slice(0, 10);
                        }
                        attachments = json.mediaURLs
                        embeds.push(embed);
                        let videoflag = false;
                        attachments.forEach(element => {
                            if (videoExtensions.some(ext => element.includes(ext))) {
                                videoflag = true;
                            }
                        });
                        if (settings.sendMediaAsAttachmentsAsDefault[message.guild.id] === true && !videoflag) {
                            showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(showAttachmentsAsEmbedsImagebuttonLocales, settings.defaultLanguage[message.guild.id])).setCustomId('showAttachmentsAsEmbedsImage');
                        }
                    } else {
                        json.mediaURLs.forEach(async element => {
                            if (element.includes('video.twimg.com')) {
                                attachments.push(element);
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
                                if ((settings.legacy_mode[message.guild.id] === false && !quoted && (settings.deletemessageifonlypostedtweetlink[message.guild.id] === false || (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content != url)))) {
                                    if((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false))) return await sendTweetEmbed(message, json.qrtURL, true, msg);
                                    showMediaAsAttachmentsButton = null 
                                    return
                                }
                                embed.image = {
                                    url: element
                                }
                                embeds.push(embed);
                            }
                        });
                    }
                }
                if (embeds.length === 0) embeds.push(embed);
                if (attachments.length > 0) messageObject.files = attachments;
                if (showMediaAsAttachmentsButton !== null) messageObject.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
                if (!messageObject.components) messageObject.components = [];
                messageObject.components.push({ type: ComponentType.ActionRow, components: embeds[0].title ? [translateButton,deleteButton] : [deleteButton] });
                messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, message.guildId);
                messageObject.embeds = embeds;
                if (quoted) messageObject.content = "Quoted tweet:"
                let msg = null;
                if (settings.legacy_mode[message.guild.id] === true && message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                    message.suppressEmbeds(true);
                }
                if (settings.alwaysreplyifpostedtweetlink[message.guild.id] === true && parent === null) {
                    msg = await message.reply(messageObject).catch(async err => {
                        if (messageObject.files !== undefined) {
                            await sendContentPromise(message, messageObject.files);
                            delete messageObject.files;
                            msg = await message.channel.send(messageObject).catch(err => {
                                console.log(err);
                            });
                        }
                    });
                } else if (parent === null) {

                    msg = await message.channel.send(messageObject).catch(async err => {
                        if (messageObject.files !== undefined) {
                            await sendContentPromise(message, messageObject.files);
                            delete messageObject.files;
                            msg = await message.channel.send(messageObject).catch(err => {
                                console.log(err);
                            });
                        }
                    });;
                } else {
                    parent.reply(messageObject).catch(async err => {
                        if (messageObject.files !== undefined) {
                            await sendContentPromise(message, messageObject.files);
                            delete messageObject.files;
                            await message.channel.send(messageObject).catch(err => {
                                console.log(err);
                            });
                        }
                    });
                }
                if (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content == url) {
                    message.delete().catch(err => {
                        message.channel.send(getStringFromObject(idonthavedeletemessagepermissionLocales, settings.defaultLanguage[message.guild.id])).then(msg => {
                            setTimeout(() => {
                                msg.delete();
                            }, 3000);
                        });
                    });
                }
                if (json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined || settings.quote_repost_do_not_extract[message.guild.id] === false)) await sendTweetEmbed(message, json.qrtURL, true, msg);
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

client.on(Events.MessageCreate, async (message) => {
    if ((message.author.bot && (settings.extract_bot_message[message.guild.id] === undefined || settings.extract_bot_message[message.guild.id] !== true) && !message.webhookId) || message.author.id == client.user.id) return;
    if ((message.content.includes('://twitter.com') || message.content.includes('://x.com')) && message.content.includes('status')) {
        //if(client.user.id != 1161267455335862282) return message.reply({embeds:[getStringFromObject(warning_this_bot_is_not_main_instance_and_going_to_be_closed_embed, settings.defaultLanguage[message.guild.id], true)]});
        let content = message.content;
        content = content.replace(/<https?:\/\/(twitter\.com|x\.com)[^\s<>|]*>|(\|\|https?:\/\/(twitter\.com|x\.com)[^\s<>|]*\|\|)/g, '');

        //match twitter link
        const url = content.match(/https?:\/\/(twitter\.com|x\.com)\/[^\s<>|]*/g);

        if (url === null) return;
        if (settings.disable.user.includes(message.author.id)) return;
        if (settings.disable.channel.includes(message.channel.id)) return;
        if (settings.disable.role[message.guild.id] !== undefined && ifUserHasRole(message.member, settings.disable.role[message.guild.id])) return;
        for (let i = 0; i < url.length; i++) {
            await sendTweetEmbed(message, url[i]);
        };
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.ApplicationCommand) return;
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
                if (settings.deletemessageifonlypostedtweetlink[interaction.guildId] === true && settings.alwaysreplyifpostedtweetlink[interaction.guildId] === true) {
                    settings.alwaysreplyifpostedtweetlink[interaction.guildId] = false;
                    await interaction.followUp((setalwaysreplyifpostedtweetlinktolocales[interaction.locale] ?? setalwaysreplyifpostedtweetlinktolocales["en"]) + convertBoolToEnableDisable(false, interaction.locale));
                }
            } else if (interaction.options.getSubcommand() === 'alwaysreplyifpostedtweetlink') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const boolean = interaction.options.getBoolean('boolean');
                settings.alwaysreplyifpostedtweetlink[interaction.guildId] = boolean;
                await interaction.reply((setalwaysreplyifpostedtweetlinktolocales[interaction.locale] ?? setalwaysreplyifpostedtweetlinktolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
                if (settings.deletemessageifonlypostedtweetlink[interaction.guildId] === true && settings.alwaysreplyifpostedtweetlink[interaction.guildId] === true) {
                    settings.deletemessageifonlypostedtweetlink[interaction.guildId] = false;
                    await interaction.followUp((setdeleteifonlypostedtweetlinktolocales[interaction.locale] ?? setdeleteifonlypostedtweetlinktolocales["en"]) + convertBoolToEnableDisable(false, interaction.locale));
                }
            } else if (interaction.options.getSubcommandGroup() === 'button') {
                if (interaction.options.getSubcommand() === 'invisible') {
                    if (settings.button_invisible[interaction.guildId] === undefined) settings.button_invisible[interaction.guildId] = button_invisible_template;
                    //options: showMediaAsAttachments, showAttachmentsAsEmbedsImage, translate, delete, all;  all boolean
                    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('all') === null) {
                        return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                    }
                    if (interaction.options.getBoolean('all') !== null) {
                        if (interaction.options.getBoolean('all') === true) {
                            settings.button_invisible[interaction.guildId].showMediaAsAttachments = true;
                            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = true;
                            settings.button_invisible[interaction.guildId].translate = true;
                            settings.button_invisible[interaction.guildId].delete = true;
                            await interaction.reply(addedAllButtonLocales[interaction.locale] ?? addedAllButtonLocales["en"]);
                        } else {
                            settings.button_invisible[interaction.guildId].showMediaAsAttachments = false;
                            settings.button_invisible[interaction.guildId].showAttachmentsAsEmbedsImage = false;
                            settings.button_invisible[interaction.guildId].translate = false;
                            settings.button_invisible[interaction.guildId].delete = false;
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
            } else if (interaction.options.getSubcommand() === 'legacymode') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                if (settings.legacy_mode[interaction.guildId] === undefined) settings.legacy_mode[interaction.guildId] = false;
                const boolean = interaction.options.getBoolean('boolean');
                settings.legacy_mode[interaction.guildId] = boolean;
                await interaction.reply((setlegacymodetolocales[interaction.locale] ?? setlegacymodetolocales["en"]) + convertBoolToEnableDisable(boolean, interaction.locale));
                if(!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) await interaction.followUp("※BOTにメッセージの管理権限を付与するとdiscord純正の埋め込みのみを削除して今まで通りの展開が行われます。\nこのBOTにメッセージの管理権限を付与することを検討してみてください。\n(使用感はdiscordがリンクの展開を修正する前と変わらなくなります。)")
            } else {
                return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
            }
        } else {
            if (interaction.options.getSubcommand() === 'disable') {
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
                } else if (interaction.options.getChannel('channel') !== null) {
                    return await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                } else if (interaction.options.getRole('role') !== null) {
                    return await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                }
            } else if (interaction.options.getSubcommand() === 'bannedwords') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'defaultlanguage') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'editoriginaliftranslate') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'setdefaultmediaasattachments') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'deleteifonlypostedtweetlink') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'alwaysreplyifpostedtweetlink') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'button') {
                if (interaction.options.getSubcommand() === 'invisible') {
                    if (settings.button_invisible[interaction.guildId] === undefined) settings.button_invisible[interaction.guildId] = button_invisible_template;
                    if (interaction.options.getBoolean('showmediaasattachments') === null && interaction.options.getBoolean('showattachmentsasembedsimage') === null && interaction.options.getBoolean('translate') === null && interaction.options.getBoolean('delete') === null && interaction.options.getBoolean('all') === null) {
                        return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                    }
                    await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                } else if (interaction.options.getSubcommand() === 'disabled') {
                    await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
                }
            } else if (interaction.options.getSubcommand() === 'extractbotmessage') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'quoterepostdonotextract') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'legacymode') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else {
                return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
            }
        }
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
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
            messageObject.components.push({ type: ComponentType.ActionRow, components: interaction.message.embeds[0].title ? [translateButton,deleteButton] : [deleteButton] });
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
            messageObject2.components.push({ type: ComponentType.ActionRow, components: interaction.message.embeds[0].title ? [translateButton,deleteButton] : [deleteButton] });
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
                    if(interaction.message.embeds[0].title !== undefined) embed.title = interaction.message.embeds[0].title;
                    embed.description = interaction.message.embeds[0].description;
                    embed.color = interaction.message.embeds[0].color;
                    embed.author = interaction.message.embeds[0].author;
                    if(interaction.message.embeds[0].footer !== undefined)embed.footer = interaction.message.embeds[0].footer;
                    embed.timestamp = interaction.message.embeds[0].timestamp;
                    if(interaction.message.embeds[0].fields !== undefined)embed.fields = interaction.message.embeds[0].fields;
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
    }
});

client.rest.on("rateLimited", (data) => {
    console.log("Rate limited: " + data.timeToReset + "ms");
    console.log(data);
});

client.login(config.token);