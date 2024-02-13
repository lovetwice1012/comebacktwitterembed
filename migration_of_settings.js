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

    /*
    settingsテーブル
    guildId	bigint(20)	:ギルドID
    bannedWords	text NULL	:禁止ワードをカンマ区切り。禁止ワードがない場合はNULL。カンマが禁止ワードに含まれている場合は{#!comma}に置換されているため復元の必要あり
    defaultLanguage	char(7) [en-US]	:デフォルトの言語
    editOriginalIfTranslate	tinyint(4) [0]	:翻訳ボタンが押されたときに元メッセージを編集するかどうか
    sendMediaAsAttachmentsAsDefault	tinyint(4) [0]	:デフォルトでメディアを添付ファイルとして送信するかどうか
    deleteMessageIfOnlyPostedTweetLink	tinyint(4) [0]	:ツイートリンクのみのメッセージを削除するかどうか
    alwaysReply	tinyint(4) [0]	:常に返信の形で内容を送信するかどうか。しない場合はチャンネルに送信する
    button_invisible_showMediaAsAttachments	tinyint(4) [0]:メディアを添付ファイルとして送信するボタンを表示するかどうか	
    button_invisible_showAttachmentsAsEmbedsImage	tinyint(4) [0]	:画像を埋め込みとして送信するボタンを表示するかどうか
    button_invisible_translate	tinyint(4) [0]	:翻訳ボタンを表示するかどうか
    button_invisible_delete	tinyint(4) [0]	:削除ボタンを表示するかどうか
    button_invisible_reload    tinyint(4) [0]	:再読み込みボタンを表示するかどうか(userのplanが1か2の場合のみ)
    button_disabled_users	text NULL	:ボタンを無効化するユーザーのIDをカンマ区切り。ボタンを無効化しない場合はNULL。
    button_disabled_channels	text NULL	:ボタンを無効化するチャンネルのIDをカンマ区切り。ボタンを無効化しない場合はNULL。
    button_disabled_roles	text NULL	:ボタンを無効化するロールのIDをカンマ区切り。ボタンを無効化しない場合はNULL。
    disable_users	text NULL	:BOTが無視するユーザーのIDをカンマ区切り。無効化しない場合はNULL。
    disable_channels	text NULL	:BOTが無視するチャンネルのIDをカンマ区切り。無効化しない場合はNULL。
    disable_roles	text NULL	:BOTが無視するロールのIDをカンマ区切り。無効化しない場合はNULL。
    extractBotMessage	tinyint(4) [0]	:BOTのメッセージに反応するかどうか
    extractWebhookMessage	tinyint(4) [0]	:Webhookのメッセージに反応するかどうか
    sendMovieAsLink	tinyint(4) [0]	:動画をリンクとして送信するかどうか。しない場合は添付ファイルとして送信するが、もし動画が添付ファイルとして送信できない場合はリンクとして送信する。　リンクとして送信する場合は [動画リンク](<動画のURL>)という形式で送信する
    anonymous_users	text NULL	:匿名モードを有効化するユーザーのIDをカンマ区切り。匿名化しない場合はNULL。
    anonymous_channels	text NULL	:匿名モードを有効化するチャンネルのIDをカンマ区切り。匿名化しない場合はNULL。
    anonymous_roles	text NULL	:匿名モードを有効化するロールのIDをカンマ区切り。匿名化しない場合はNULL。
    maxExtractQuotedTweet int(11) [3]	:引用ツイートを何個まで展開するか
    */
    //settings.jsomの内容をsettingsテーブルに挿入
    /*
    settingss.jsonの内容
        "disable": {
            "user": [],//user id配列
            "channel": [],//channel id配列
            "role": {},//ギルドIDをキーとしたrole id配列
        },
        "bannedWords": {},//ギルドIDをキーとした禁止ワード配列
        "defaultLanguage": {},//ギルドIDをキーとしたデフォルト言語
        "editOriginalIfTranslate": {},//ギルドIDをキーとした翻訳ボタンが押されたときに元メッセージを編集するかどうか
        "sendMediaAsAttachmentsAsDefault": {},//ギルドIDをキーとしたデフォルトでメディアを添付ファイルとして送信するかどうか
        "deletemessageifonlypostedtweetlink": {},//ギルドIDをキーとしたツイートリンクのみのメッセージを削除するかどうか
        "alwaysreplyifpostedtweetlink": {},//ギルドIDをキーとしたツイートリンクのみのメッセージを削除するかどうか
        "button_invisible": {},//ギルドIDをキーとしたボタン非表示設定
        "button_disabled": {},//ギルドIDをキーとしたボタン無効化設定
        "extract_bot_message": {},//ギルドIDをキーとしたBOTのメッセージに反応するかどうか
        "quote_repost_do_not_extract": {},//ギルドIDをキーとした引用ツイートを展開しない設定

        
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
button_invisibleとbutton_disabledはギルドIDをキーとしてそれぞれのテンプレートが入っている
    */
    //settings.jsonを読み込んでギルド事にデータを変換する
    const settings = require('./settings.json');
    const disable_role = settings.disable.role;
    const bannedWords = settings.bannedWords;
    const defaultLanguage = settings.defaultLanguage;
    const editOriginalIfTranslate = settings.editOriginalIfTranslate;
    const sendMediaAsAttachmentsAsDefault = settings.sendMediaAsAttachmentsAsDefault;
    const deletemessageifonlypostedtweetlink = settings.deletemessageifonlypostedtweetlink;
    const alwaysreplyifpostedtweetlink = settings.alwaysreplyifpostedtweetlink;
    const button_invisible = settings.button_invisible;
    const button_disabled = settings.button_disabled;
    const extract_bot_message = settings.extract_bot_message;
    const quote_repost_do_not_extract = settings.quote_repost_do_not_extract;
    function boolToInt(bool){
        if(bool){
            return 1;
        }else{
            return 0;
        }
    }
    //各設定をギルドIDをキーとしてまとめる
    let new_settings = {};
    for (let guildId in disable_role) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['disable_roles'] = disable_role[guildId].join(',');
    }
    for (let guildId in bannedWords) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['bannedWords'] = bannedWords[guildId].join(',');
    }
    for (let guildId in defaultLanguage) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['defaultLanguage'] = defaultLanguage[guildId];
        if(defaultLanguage[guildId] == 'en'){
            new_settings[guildId]['defaultLanguage'] = 'en-US';
        }
    }
    for (let guildId in editOriginalIfTranslate) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['editOriginalIfTranslate'] = boolToInt(editOriginalIfTranslate[guildId]);
    }
    for (let guildId in sendMediaAsAttachmentsAsDefault) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['sendMediaAsAttachmentsAsDefault'] = boolToInt(sendMediaAsAttachmentsAsDefault[guildId]);
    }
    for (let guildId in deletemessageifonlypostedtweetlink) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['deleteMessageIfOnlyPostedTweetLink'] = boolToInt(deletemessageifonlypostedtweetlink[guildId]);
    }
    for (let guildId in alwaysreplyifpostedtweetlink) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['alwaysReply'] = boolToInt(alwaysreplyifpostedtweetlink[guildId]);
    }
    for (let guildId in button_invisible) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['button_invisible_showMediaAsAttachments'] = boolToInt(button_invisible[guildId].showMediaAsAttachments);
        new_settings[guildId]['button_invisible_showAttachmentsAsEmbedsImage'] = boolToInt(button_invisible[guildId].showAttachmentsAsEmbedsImage);
        new_settings[guildId]['button_invisible_translate'] = boolToInt(button_invisible[guildId].translate);
        new_settings[guildId]['button_invisible_delete'] = boolToInt(button_invisible[guildId].delete);
        new_settings[guildId]['button_invisible_reload'] = boolToInt(button_invisible[guildId].reload);
    }
    for (let guildId in button_disabled) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['button_disabled_users'] = button_disabled[guildId].user.join(',');
        new_settings[guildId]['button_disabled_channels'] = button_disabled[guildId].channel.join(',');
        new_settings[guildId]['button_disabled_roles'] = button_disabled[guildId].role.join(',');
    }
    for (let guildId in extract_bot_message) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        new_settings[guildId]['extractBotMessage'] = boolToInt(extract_bot_message[guildId]);
    }
    for (let guildId in quote_repost_do_not_extract) {
        if(new_settings[guildId] == undefined){
            new_settings[guildId] = {};
        }
        if(quote_repost_do_not_extract[guildId]){
            new_settings[guildId]['maxExtractQuotedTweet'] = 0;
        }
    }
    //データベースに挿入
    for (let guildId in new_settings) {
        connection.query(
            'INSERT INTO settings (guildId, bannedWords, defaultLanguage, editOriginalIfTranslate, sendMediaAsAttachmentsAsDefault, deleteMessageIfOnlyPostedTweetLink, alwaysReply, button_invisible_showMediaAsAttachments, button_invisible_showAttachmentsAsEmbedsImage, button_invisible_translate, button_invisible_delete, button_invisible_reload, button_disabled_users, button_disabled_channels, button_disabled_roles, extractBotMessage, maxExtractQuotedTweet, extractWebhookMessage) VALUES ( ?, ? ,? ,? ,? ,? ,? ,? ,? ,? ,? ,? ,? ,? ,? ,? ,?, ? )  ON DUPLICATE KEY UPDATE guildId = VALUES(guildId), bannedWords = VALUES(bannedWords), defaultLanguage = VALUES(defaultLanguage), editOriginalIfTranslate = VALUES(editOriginalIfTranslate), sendMediaAsAttachmentsAsDefault = VALUES(sendMediaAsAttachmentsAsDefault), deleteMessageIfOnlyPostedTweetLink = VALUES(deleteMessageIfOnlyPostedTweetLink), alwaysReply = VALUES(alwaysReply), button_invisible_showMediaAsAttachments = VALUES(button_invisible_showMediaAsAttachments), button_invisible_showAttachmentsAsEmbedsImage = VALUES(button_invisible_showAttachmentsAsEmbedsImage), button_invisible_translate = VALUES(button_invisible_translate), button_invisible_delete = VALUES(button_invisible_delete), button_invisible_reload = VALUES(button_invisible_reload), button_disabled_users = VALUES(button_disabled_users), button_disabled_channels = VALUES(button_disabled_channels), button_disabled_roles = VALUES(button_disabled_roles), extractBotMessage = VALUES(extractBotMessage), maxExtractQuotedTweet = VALUES(maxExtractQuotedTweet), extractWebhookMessage = VALUES(extractWebhookMessage)',
            [guildId, new_settings[guildId]['bannedWords'], new_settings[guildId]['defaultLanguage'] ?? "en-US", new_settings[guildId]['editOriginalIfTranslate'] ?? 0, new_settings[guildId]['sendMediaAsAttachmentsAsDefault'] ?? 0, new_settings[guildId]['deleteMessageIfOnlyPostedTweetLink'] ?? 0, new_settings[guildId]['alwaysReply'] ?? 0, new_settings[guildId]['button_invisible_showMediaAsAttachments'] ?? 0, new_settings[guildId]['button_invisible_showAttachmentsAsEmbedsImage'] ?? 0, new_settings[guildId]['button_invisible_translate'] ?? 0, new_settings[guildId]['button_invisible_delete'] ?? 0, new_settings[guildId]['button_invisible_reload'] ?? 0, new_settings[guildId]['button_disabled_users'] ?? 0, new_settings[guildId]['button_disabled_channels'] ?? 0, new_settings[guildId]['button_disabled_roles']  ?? 0, new_settings[guildId]['extractBotMessage'] ?? 0, new_settings[guildId]['maxExtractQuotedTweet'] ?? 3, 1],
            (error, results) => {
                if (error) {
                    console.error(error);
                    return;
                }
                console.log('Inserted into settings table:'+ guildId);
            }
        );
    }

    
});