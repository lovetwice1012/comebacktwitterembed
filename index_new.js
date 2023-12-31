const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const config = require('./config.json');
const fs = require('fs');
const mysql = require('mysql');
const { Translate } = require('./src/resxParser');
const fetchWorkerService = require('./src/workers/fetchWorkerService');
const queueManager = require('./src/queue/queueManager');
const queueManagerInstance = new queueManager();
const fetchWorkersServiceInstance = new fetchWorkerService(queueManagerInstance);
const commandConfig = require('./src/command/commandConfig');

// MySQL接続情報
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

async function processNextQueue() {
    const queue = queueManagerInstance.get_next();
    if (queue == null) {
        setTimeout(() => {
            processNextQueue();
        }, 100);
        return;
    }
    /*
    queue.settingsの中身
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

    匿名モード：
    twitterのユーザー名やアイコン、誰が送信したかを表示しないモード。
    ツイートリンクも表示されない。
    削除ボタンは表示されない。
    */
    const settings = queue.settings;
    const message = queue.message;
    const plan = queue.plan;
    const url = queue.url;
    const tweetData = queue.result;

    //embedsを作成開始
    /*
    embedsの作成のワークフロー
    1.ツイートの内容に禁止ワードが含まれていないかを確認する
    2.埋め込みを作成する
    3.もし匿名モードが有効化されている場合は、ユーザー名やアイコンを上書きして匿名化する
    4.非表示化されてるボタンを除いてボタンを作成する
    5.ボタンを埋め込みに追加する
    6.送信する
    */
    
    //1.ツイートの内容に禁止ワードが含まれていないかを確認する
    let isBanned = false;
    if(settings.bannedWords != null) {
        const bannedWords = settings.bannedWords.split(',');
        for(let i = 0; i < bannedWords.length; i++) {
            if(tweetData.text.includes(bannedWords[i].replace("{#!comma}", ","))) {
                isBanned = true;
                break;
            }
        }
    }
    if(isBanned) {
        //禁止ワードが含まれていた場合はそれを送信する
        return message.reply({content: Translate.bannedWords[settings.defaultLanguage], allowedMentions: {repliedUser: false}});
    }

    //2.埋め込みを作成する
    /*
    埋め込みのひな型(画像や動画がある場合はこれに追加される。また、匿名モード有効化時はユーザー名やアイコンが上書きされる)
    title: user_name,
                        url: tweetURL,
                        description: tweettext + '\n\n[View on Twitter](' + tweetURL + ')\n\n:speech_balloon:' + replies + ' replies • :recycle:' + retweets + ' retweets • :heart:' + likes + ' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: 'request by ' + message.author.username + '(id:' + message.author.id + ')',
                        },
                        footer: {
                            text: 'Posted by ' + {user_name} + ' (@' + {user_screen_name} + ')',
                            icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
                        },
                        timestamp: new Date(json.date),

    */
    let message_object = {};
    let embeds = [];
    let embed = {}
    const tweettext = tweetData.tweet.text;
    const replies = tweetData.tweet.reply;
    const retweets = tweetData.tweet.retweet;
    const view = tweetData.tweet.view;
    const likes = tweetData.tweet.like;
    const user_name = tweetData.tweet.author.name;
    const user_screen_name = tweetData.tweet.author.screen_name;

    embed.title = user_name;
    embed.url = url;
    embed.description = tweettext + '\n\n[View on Twitter](' + url + ')\n\n:speech_balloon:' + replies + ' replies • :recycle:' + retweets + ' retweets • :heart:' + likes + ' likes';
    embed.color = 0x1DA1F2;
    embed.author = {
        name: 'request by ' + message.author.username + '(id:' + message.author.id + ')',
    };
    embed.footer = {
        text: 'Posted by ' + user_name + ' (@' + user_screen_name + ')',
        icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
    };
    embed.timestamp = new Date(tweetData.tweet.date);

    let imagesEmbeds = [];
    //画像や動画を追加する(画像や動画がない場合は何もしない。まだembedsには追加しない)
    //動画はリンクとして送信するか添付ファイルとして送信するかを設定で変更できる
    //もしsendMediaAsAttachmentsAsDefaultが有効化されている場合は画像も添付ファイルとして送信する
    //リンクとして送信する場合は[動画リンク](<動画のURL>)という形式で送信する
    //画像はリンクとして送信しない
    //追加先
    //埋め込みの場合はembed.image(もし2枚以上あるのであれば一枚目はembed.image、それ以降はimageEmbedsに追加)
    //添付ファイルの場合はmessage_object.files
    //リンクの場合はmessage_object.contentに追加
    /*
    画像の例imageEmbedsに追加する奴のひな型
    {
        url: {tweetURL},
        image: {
            url: {media.photos[i].url}
        }
    }
    */
    const media = tweetData.tweet.media;
    //画像:media.photos
    /*
    photosの例
    "photos": [
				{
					"type": "photo",
					"url": "https://pbs.twimg.com/media/F-4UCe1a0AAEnYP.jpg",
					"width": 946,
					"height": 2048,
					"altText": ""
				}
			]
            */
    //動画:media.videos
    /*
    videosの例
"videos": [
				{
					"url": "https://video.twimg.com/ext_tw_video/1738122125154893824/pu/vid/avc1/1328x720/aMfPTXSsUb4-Hm9z.mp4?tag=12",
					"thumbnail_url": "https://pbs.twimg.com/ext_tw_video_thumb/1738122125154893824/pu/img/wI6WYzaGo5MFKUEJ.jpg",
					"duration": 21.234,
					"width": 1920,
					"height": 1040,
					"format": "video/mp4",
					"type": "video"
				}
			]
    */
    //無い場合はundefined
    //photos
    if(media.photos != undefined) {
        for(let i = 0; i < media.photos.length; i++) {
            if(i == 0) {
                embed.image = {
                    url: media.photos[i].url
                }
            } else {
                imagesEmbeds.push({
                    url: url,
                    image: {
                        url: media.photos[i].url
                    }
                });
            }
        }
    }
    //videos
    if(media.videos != undefined) {
        for(let i = 0; i < media.videos.length; i++) {
            if(settings.sendMovieAsLink == 1) {
                //リンクとして送信する
                message_object.content = message_object.content + "\n\n[動画リンク](" + media.videos[i].url + ")";
            } else {
                //添付ファイルとして送信する
                message_object.files.push(media.videos[i].url);
            }
        }
    }

    //3.もし匿名モードが有効化されている場合は、ユーザー名やアイコンを上書きして匿名化する
    //匿名モードが有効化されているかどうか
    let isAnonymous = false;
    if(settings.anonymous_users != null) {
        const anonymous_users = settings.anonymous_users.split(',');
        for(let i = 0; i < anonymous_users.length; i++) {
            if(message.author.id == anonymous_users[i]) {
                isAnonymous = true;
                break;
            }
        }
    }
    if(settings.anonymous_channels != null) {
        const anonymous_channels = settings.anonymous_channels.split(',');
        for(let i = 0; i < anonymous_channels.length; i++) {
            if(message.channel.id == anonymous_channels[i]) {
                isAnonymous = true;
                break;
            }
        }
    }
    if(settings.anonymous_roles != null) {
        const anonymous_roles = settings.anonymous_roles.split(',');
        for(let i = 0; i < anonymous_roles.length; i++) {
            if(message.member.roles.cache.has(anonymous_roles[i])) {
                isAnonymous = true;
                break;
            }
        }
    }

    if(isAnonymous) {
        //匿名モードが有効化されている場合は、ユーザー名やアイコンを上書きして匿名化する
        embed.author.name = 'request by Anonymous(id: Unknown)';
        embed.footer.text = 'Posted by Anonymous';
        embed.footer.icon_url = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
        embed.author.icon_url = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
    }

    //4.非表示化されてるボタンを除いてボタンを作成する
    
    //翻訳ボタン
    let translateButton = null;
    if(settings.button_invisible_translate == 0) {
        translateButton = new ButtonBuilder()
            .setCustomId('translate')
            .setLabel(Translate.translate[settings.defaultLanguage])
            .setStyle(ButtonStyle.PRIMARY)
            .setEmoji('🌐')
            .build();
    }
    //削除ボタン
    let deleteButton = null;
    if(settings.button_invisible_delete == 0) {
        deleteButton = new ButtonBuilder()
            .setCustomId('delete')
            .setLabel(Translate.delete[settings.defaultLanguage])
            .setStyle(ButtonStyle.DANGER)
            .setEmoji('🗑️')
            .build();
    }
    //再読み込みボタン
    let reloadButton = null;
    if(plan == 1 || plan == 2) {
        if(settings.button_invisible_reload == 0) {
            reloadButton = new ButtonBuilder()
                .setCustomId('reload')
                .setLabel(Translate.reload[settings.defaultLanguage])
                .setStyle(ButtonStyle.SECONDARY)
                .setEmoji('🔄')
                .build();
        }
    }
    //メディアを添付ファイルとして送信するボタン
    let showMediaAsAttachmentsButton = null;
    if(settings.button_invisible_showMediaAsAttachments == 0) {
        showMediaAsAttachmentsButton = new ButtonBuilder()
            .setCustomId('showMediaAsAttachments')
            .setLabel(Translate.showMediaAsAttachments[settings.defaultLanguage])
            .setStyle(ButtonStyle.SECONDARY)
            .setEmoji('📎')
            .build();
    }
    
    //画像を埋め込みとして送信するボタンはここでは作成しない

    //5.ボタンをmessage_objectのcomponentsに追加する
    //new Discord.MessageActionRow().addComponents
    let components = [];
    let actionRow = new discord.MessageActionRow();
    if(translateButton != null) actionRow.addComponents(translateButton);
    if(deleteButton != null) actionRow.addComponents(deleteButton);
    if(reloadButton != null) actionRow.addComponents(reloadButton);
    if(showMediaAsAttachmentsButton != null) actionRow.addComponents(showMediaAsAttachmentsButton);
    //actionRowが空の場合はcomponentsに追加しない
    if(actionRow.components.length != 0)components.push(actionRow);
    
    //6.送信する
    //embedとimageEmbedsを結合する
    embeds.push(embed);
    embeds.push(...imagesEmbeds);
    message_object.embeds = embeds;
    message_object.components = components;
    
    //メッセージを送信する
    //alwaysReplyが有効化されている場合は返信の形で送信する
    if(settings.alwaysReply == 1) {
        message.reply(message_object);
    } else {
        message.channel.send(message_object);
    }
    //0.1秒待って次のキューを処理する
    setTimeout(() => {
        processNextQueue();
    }, 100);
}

client.on(Events.ClientReady, () => {
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

    client.application.commands.set(commandConfig);

    fetchWorkersServiceInstance.set_FetchTotalWorkers(64);

    fetchWorkersServiceInstance.initialize();

});

