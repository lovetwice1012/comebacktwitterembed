const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions], partials: [Partials.Channel] });
const config = require('./config.json');
const fs = require('fs');
const mysql = require('mysql');
const Translate = require('./src/resxParser');
const fetchWorkersService = require('./src/workers/fetch/fetchWorkersService');
const queueManager = require('./src/queue/queueManager');
const queueManagerInstance = new queueManager();
const fetchWorkersServiceInstance = new fetchWorkersService(queueManagerInstance);
const commandConfig = require('./src/command/commandConfig');

process.on('uncaughtException', function (err) {
    console.log(err);
});

process.on('unhandledRejection', function (err) {
    console.log(err);
});

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
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🌐')
    }
    //削除ボタン
    let deleteButton = null;
    if(settings.button_invisible_delete == 0) {
        deleteButton = new ButtonBuilder()
            .setCustomId('delete')
            .setLabel(Translate.delete[settings.defaultLanguage])
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
    }
    //再読み込みボタン
    let reloadButton = null;
    if(plan == 1 || plan == 2) {
        if(settings.button_invisible_reload == 0) {
            reloadButton = new ButtonBuilder()
                .setCustomId('reload')
                .setLabel(Translate.reload[settings.defaultLanguage])
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄')
        }
    }
    //メディアを添付ファイルとして送信するボタン
    let showMediaAsAttachmentsButton = null;
    if(settings.button_invisible_showMediaAsAttachments == 0) {
        showMediaAsAttachmentsButton = new ButtonBuilder()
            .setCustomId('showMediaAsAttachments')
            .setLabel(Translate.show_media[settings.defaultLanguage])
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📎')
    }
    
    //画像を埋め込みとして送信するボタンはここでは作成しない

    //5.ボタンをmessage_objectのcomponentsに追加する
    //new Discord.ActionRowBuilder().addComponents
    let components = [];
    let actionRow = new discord.ActionRowBuilder();
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
    console.log(message)
    if(settings.alwaysReply == 1) {
        message.reply(message_object);
    } else {
        const channel = await client.channels.fetch(message.channelId);
        channel.send(message_object);
    }
    //messageのリアクションを取る
    message.reactions.cache.get("🔁").remove();
    message.react("✅")
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

    fetchWorkersServiceInstance.set_total_workers(64);

    fetchWorkersServiceInstance.initialize();

    processNextQueue();

});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
    }
});

client.on(Events.MessageCreate, async (message) => {
    //twitter.comかx.comが含まれているか
    if (!message.content.includes('twitter.com') && !message.content.includes('x.com')) return;
    //https://twitter.comかhttps://x.comから始まるリンクのみを抽出する
    const urlRegex = /https:\/\/(twitter|x)\.com\/[a-zA-Z0-9_]{1,15}\/status\/[0-9]{1,20}/g;
    const urls = message.content.match(urlRegex);
    if (urls == null) return;
    //settingsの取得
    const sql = 'SELECT * FROM settings WHERE guildId = ?';
    const params = [message.guild.id];

    connection.query(sql, params, (error, results, fields) => {
        if (error) {
            console.error('Error connecting to database:', error);
            return;
        }
        if (results.length == 0) {
            //設定がない場合はデフォルトの設定を使用する
            const defaultSettings = {
                guildId: message.guild.id,
                bannedWords: null,
                defaultLanguage: 'en-US',
                editOriginalIfTranslate: 0,
                sendMediaAsAttachmentsAsDefault: 0,
                deleteMessageIfOnlyPostedTweetLink: 0,
                alwaysReply: 0,
                button_invisible_showMediaAsAttachments: 0,
                button_invisible_showAttachmentsAsEmbedsImage: 0,
                button_invisible_translate: 0,
                button_invisible_delete: 0,
                button_invisible_reload: 0,
                button_disabled_users: null,
                button_disabled_channels: null,
                button_disabled_roles: null,
                disable_users: null,
                disable_channels: null,
                disable_roles: null,
                extractBotMessage: 0,
                extractWebhookMessage: 0,
                sendMovieAsLink: 0,
                anonymous_users: null,
                anonymous_channels: null,
                anonymous_roles: null,
                maxExtractQuotedTweet: 3,
            };
            const sql = 'INSERT INTO settings SET ?';
            const params = [defaultSettings];
            connection.query(sql, params, (error, results, fields) => {
                if (error) {
                    console.error('Error connecting to database:', error);
                    return;
                }
                console.log('Inserted default settings');
            });
            settings = defaultSettings;
        } else {
            //設定がある場合はそれを使用する
            settings = results[0];
        }

        //DBよりuserのデータを取得
        /*
        usersテーブル
        userid	bigint(20)	:ユーザーID
        plan	int(11) [0]	:プラン(0:無料,1:有料(ベーシック),2:有料(プレミアム))
        paid_plan_expired_at	bigint(20) [0]	:有料プランの有効期限(unixtime)
        register_date	bigint(20)	:登録日(unixtime)
        enabled	tinyint(4) [1]	:有効化されているかどうか(利用禁止になった場合は0になる)
        */

        //botのメッセージに反応するかどうか
        if(settings.extractBotMessage == 0 && message.author.bot) return;
        //webhookのメッセージに反応するかどうか
        if(settings.extractWebhookMessage == 0 && message.webhookId != null) return;
        //ユーザーが無効化されているかどうか
        if(settings.disable_users != null) {
            const disable_users = settings.disable_users.split(',');
            for(let i = 0; i < disable_users.length; i++) {
                if(message.author.id == disable_users[i]) return;
            }
        }
        //チャンネルが無効化されているかどうか
        if(settings.disable_channels != null) {
            const disable_channels = settings.disable_channels.split(',');
            for(let i = 0; i < disable_channels.length; i++) {
                if(message.channel.id == disable_channels[i]) return;
            }
        }
        //ロールが無効化されているかどうか
        if(settings.disable_roles != null) {
            const disable_roles = settings.disable_roles.split(',');
            for(let i = 0; i < disable_roles.length; i++) {
                if(message.member.roles.cache.has(disable_roles[i])) return;
            }
        }

        //ユーザーのデータを取得
        const sql = 'SELECT * FROM users WHERE userid = ?';
        const params = [message.author.id];
        connection.query(sql, params, (error, results, fields) => {
            if (error) {
                console.error('Error connecting to database:', error);
                return;
            }
            if (results.length == 0) {
                //ユーザーが存在しない場合は登録する
                const sql = 'INSERT INTO users SET ?';
                const params = [{
                    userid: message.author.id,
                    plan: 0,
                    paid_plan_expired_at: 0,
                    register_date: new Date().getTime(),
                    enabled: 1
                }];
                connection.query(sql, params, (error, results, fields) => {
                    if (error) {
                        console.error('Error connecting to database:', error);
                        return;
                    }
                    console.log('Inserted user');
                });
                //プランは無料
                plan = 0;
            } else {
                //ユーザーが存在する場合はそれを使用する
                plan = results[0].plan;
            }
            //キューに全てのURLを追加する
            for (let i = 0; i < urls.length; i++) {
                fetchWorkersServiceInstance.add_queue(message, plan, urls[i]);
                //キューに追加した事を示すためにリアクションを付ける
                message.react('🔁');
            }
        });
    });
})

client.on(Events.InteractionCreate, async (interaction) => {
});

client.login(config.token);