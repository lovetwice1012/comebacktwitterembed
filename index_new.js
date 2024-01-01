const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions], partials: [Partials.Channel] , shards: 'auto'});
const config = require('./config.json');
const fs = require('fs');
const mysql = require('mysql');
const Translate = require('./src/resxParser');
const fetchWorkersService = require('./src/workers/fetch/fetchWorkersService');
const queueManager = require('./src/queue/queueManager');
const queueManagerInstance = new queueManager();
const fetchWorkersServiceInstance = new fetchWorkersService(queueManagerInstance);
const commandConfig = require('./src/command/commandConfig');

let processed_day = 0;
let processed_hour = 0;
let processed_minute = 0;


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
        }, 20);
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
    const message = await client.channels.cache.get(queue.message.channelId).messages.cache.get(queue.message.id);
    const plan = queue.plan;
    const tweetData = queue.result;
    const url = tweetData.tweet.url;
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
    if (settings.bannedWords != null) {
        const bannedWords = settings.bannedWords.split(',');
        for (let i = 0; i < bannedWords.length; i++) {
            if (tweetData.tweet.text.includes(bannedWords[i].replace("{#!comma}", ","))) {
                isBanned = true;
                break;
            }
        }
    }
    if (isBanned) {
        //禁止ワードが含まれていた場合はそれを送信する
        return message.reply({ content: Translate.yourMessageContainsABannedWord[settings.defaultLanguage], allowedMentions: { repliedUser: false } });
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
    const replies = tweetData.tweet.replies;
    const retweets = tweetData.tweet.retweets;
    const views = tweetData.tweet.views;
    const likes = tweetData.tweet.likes;
    const user_name = tweetData.tweet.author.name;
    const user_screen_name = tweetData.tweet.author.screen_name;

    embed.title = user_name;
    embed.url = url;
    embed.description = tweettext + '\n\n[View on Twitter](' + url + ')\n\n:eyes:' + views + ' views • :speech_balloon:' + replies + ' replies • :recycle:' + retweets + ' retweets • :heart:' + likes + ' likes';
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
    let videoText = null;
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
    if (media != undefined) {
        if (media.photos != undefined) {
            for (let i = 0; i < media.photos.length; i++) {
                if (i == 0) {
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

        if (media.videos != undefined) {
            for (let i = 0; i < media.videos.length; i++) {
                if (settings.sendMovieAsLink == 1) {
                    if (videoText == null) videoText = "";
                    //リンクとして送信する
                    videoText = videoText + "\n[動画リンク](" + media.videos[i].url + ")";
                } else {
                    if (message_object.files == undefined) message_object.files = [];
                    //添付ファイルとして送信する
                    message_object.files.push(media.videos[i].url);
                }
            }
        }
    }


    //3.もし匿名モードが有効化されている場合は、ユーザー名やアイコンを上書きして匿名化する
    //匿名モードが有効化されているかどうか
    let isAnonymous = false;
    if (settings.anonymous_users != null) {
        const anonymous_users = settings.anonymous_users.split(',');
        for (let i = 0; i < anonymous_users.length; i++) {
            if (message.author.id == anonymous_users[i]) {
                isAnonymous = true;
                break;
            }
        }
    }
    if (settings.anonymous_channels != null) {
        const anonymous_channels = settings.anonymous_channels.split(',');
        for (let i = 0; i < anonymous_channels.length; i++) {
            if (message.channel.id == anonymous_channels[i]) {
                isAnonymous = true;
                break;
            }
        }
    }
    if (settings.anonymous_roles != null) {
        const anonymous_roles = settings.anonymous_roles.split(',');
        for (let i = 0; i < anonymous_roles.length; i++) {
            if (message.member.roles.cache.has(anonymous_roles[i])) {
                isAnonymous = true;
                break;
            }
        }
    }

    if (isAnonymous) {
        //匿名モードが有効化されている場合は、ユーザー名やアイコンを上書きして匿名化する
        embed.author.name = 'request by Anonymous(id: Unknown)';
        embed.footer.text = 'Posted by Anonymous';
        embed.footer.icon_url = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
        embed.author.icon_url = 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png';
        embed.title = 'Anonymous';
        embed.url = "https://anonymous.sprink.cloud/" + message.id;
        embed.description = tweettext
        //もしimageEmbedsがある場合はそれも匿名化する
        if (imagesEmbeds.length != 0) {
            for (let i = 0; i < imagesEmbeds.length; i++) {
                imagesEmbeds[i].url = "https://anonymous.sprink.cloud/" + message.author.id + "/" + message.id;
            }
        }
    }

    //4.非表示化されてるボタンを除いてボタンを作成する

    //翻訳ボタン
    let translateButton = null;
    if (settings.button_invisible_translate == 0) {
        translateButton = new ButtonBuilder()
            .setCustomId('translate')
            .setLabel(Translate.translate[settings.defaultLanguage])
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🌐')
    }
    //削除ボタン
    let deleteButton = null;
    if (settings.button_invisible_delete == 0 && isAnonymous == false) {
        deleteButton = new ButtonBuilder()
            .setCustomId('delete')
            .setLabel(Translate.delete[settings.defaultLanguage])
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
    }
    //再読み込みボタン
    let reloadButton = null;
    if (plan == 1 || plan == 2) {
        if (settings.button_invisible_reload == 0 && isAnonymous == false) {
            reloadButton = new ButtonBuilder()
                .setCustomId('reload')
                .setLabel(Translate.reload[settings.defaultLanguage])
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄')
        }
    }
    //メディアを添付ファイルとして送信するボタン
    let showMediaAsAttachmentsButton = null;
    if (settings.button_invisible_showMediaAsAttachments == 0 && settings.sendMediaAsAttachmentsAsDefault == 0 && embed.image != undefined) {
        showMediaAsAttachmentsButton = new ButtonBuilder()
            .setCustomId('showMediaAsAttachments')
            .setLabel(Translate.showMediaAsAttachments[settings.defaultLanguage])
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📎')
    }

    //画像を埋め込みとして送信するボタンはここでは作成しない

    //5.ボタンをmessage_objectのcomponentsに追加する
    //new Discord.ActionRowBuilder().addComponents
    let components = [];
    let actionRow = new discord.ActionRowBuilder();
    if (translateButton != null) actionRow.addComponents(translateButton);
    if (deleteButton != null) actionRow.addComponents(deleteButton);
    if (reloadButton != null) actionRow.addComponents(reloadButton);
    if (showMediaAsAttachmentsButton != null) actionRow.addComponents(showMediaAsAttachmentsButton);
    //actionRowが空の場合はcomponentsに追加しない
    if (actionRow.components.length != 0) components.push(actionRow);

    //6.送信する
    //embedとimageEmbedsを結合する
    embeds.push(embed);
    embeds.push(...imagesEmbeds);
    message_object.embeds = embeds;
    message_object.components = components;
    if (queue.quotedCount != undefined && queue.quotedCount != null && queue.quotedCount != 0) message_object.content = "Quoted tweet(" + queue.quotedCount + "): ";

    //メッセージを送信する
    //alwaysReplyが有効化されている場合は返信の形で送信する
    if (settings.alwaysReply == 1) {
        message.reply(message_object).then((msg) => {
            if (videoText != null) message.channel.send(videoText);
            if (settings.deleteMessageIfOnlyPostedTweetLink == 1 && message.content == url) message.delete();
        }).catch((error) => {
            if (error.message.includes("Request entity too large")) {
                const files = message_object.files;
                //添付ファイルがある場合はそれを削除する
                delete message_object.files;
                //filesをリンクとして送信する
                videoText = "";
                for (let i = 0; i < files.length; i++) {
                    videoText = videoText + "\n[動画リンク](" + files[i] + ")";
                }
                message.channel.send(message_object).then((msg) => {
                    message.channel.send(videoText);
                    if (settings.deleteMessageIfOnlyPostedTweetLink == 1 && message.content == url) message.delete();
                });
                return
            }
            console.error(error);
        });
    } else {
        const channel = await client.channels.fetch(message.channelId);
        channel.send(message_object).then((msg) => {
            if (videoText != null) message.channel.send(videoText);
            if (settings.deleteMessageIfOnlyPostedTweetLink == 1 && message.content == url) message.delete();
        }).catch((error) => {
            if (error.message.includes("Request entity too large")) {
                const files = message_object.files;
                //添付ファイルがある場合はそれを削除する
                delete message_object.files;
                //filesをリンクとして送信する
                videoText = "";
                for (let i = 0; i < files.length; i++) {
                    videoText = videoText + "\n[動画リンク](" + files[i] + ")";
                }
                message.channel.send(message_object).then((msg) => {
                    message.channel.send(videoText);
                    if (settings.deleteMessageIfOnlyPostedTweetLink == 1 && message.content == url) message.delete();
                });
                return
            }
            console.error(error);
        });
    }
    if (settings.deleteMessageIfOnlyPostedTweetLink == 0 || message.content != url) {
        //messageのリアクションを取る
        const myReactions = message.reactions.cache.filter(reaction => reaction.users.cache.has(client.user.id));
        for (const reaction of myReactions.values()) {
            await reaction.users.remove(client.user.id).catch((error) => {});
        }
        message.react("✅").catch((error) => {});
    }

    processed_day++
    processed_hour++
    processed_minute++


    //もしtweetData.tweet.quoteがundefinedやnullじゃなくて、queue.quotedCountがmaxExtractQuotedTweetを超えていない場合は引用されたツイートのURL(tweetData.tweet.quote.url)をqueueに追加する
    if (tweetData.tweet.quote != undefined && tweetData.tweet.quote != null && queue.quotedCount < settings.maxExtractQuotedTweet) {
        fetchWorkersServiceInstance.add_queue(message, queue.plan, tweetData.tweet.quote.url, queue.quotedCount + 1);
    }

    //0.1秒待って次のキューを処理する
    setTimeout(() => {
        processNextQueue();
    }, 20);
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
                        value: processed_minute + 'messages'
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
        processed_column = processed_minute;
        processed_minute = 0;

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

    client.application.commands.set(commandConfig);
    fetchWorkersServiceInstance.set_total_workers(64);
    fetchWorkersServiceInstance.initialize(client);
    processNextQueue();

});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isCommand()) return;
    if(interaction.author.id != 796972193287503913 && interaction.author.id != 687374475997741075 && interaction.author.id != 933314562487386122) return interaction.reply("現在コマンドは調整中です。");
    // settingsコマンドの場合ロールの管理、メッセージの管理、チャンネルの管理どれかの権限がついていない場合はほかの人に見えない形で返信する
    if (interaction.commandName == Translate.settings["en-US"]) {
        if (!interaction.member.permissions.has(PermissionsBitField.ManageRoles) && !interaction.member.permissions.has(PermissionsBitField.ManageMessages) && !interaction.member.permissions.has(PermissionsBitField.ManageChannels)) {
            // embed形式で送らず通常のテキストで送る
            await interaction.reply(Translate.youDonTHavePermissionToUseThisCommand[interaction.locale] ?? Translate.youDonTHavePermissionToUseThisCommand["en-US"]);
        }
    }

    //現在のサーバー設定を確認する
    //settingsの取得
    const sql = 'SELECT * FROM settings WHERE guildId = ?';
    const params = [interaction.guild.id];

    connection.query(sql, params, async (error, results, fields) => {
        if (error) {
            console.error('Error connecting to database:', error);
            return;
        }
        if (results.length == 0) {
            //設定がない場合はデフォルトの設定を使用する
            const defaultSettings = {
                guildId: interaction.guild.id,
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
            });
            settings = defaultSettings;
        } else {
            //設定がある場合はそれを使用する
            settings = results[0];
        }


        switch (interaction.commandName) {

            case Translate.help["en-US"]:
                await interaction.reply({
                    embeds: [
                        {
                            title: 'Help',
                            description: Translate.Help_script[interaction.locale] ?? Translate.Help_script["en-US"],
                            color: 0x1DA1F2,
                            fields: [
                                {
                                    name: 'Commands',
                                    value: Translate.Help_command[interaction.locale] ?? Translate.Help_command["en-US"]
                                }
                            ]
                        }
                    ]
                });
                return

            case Translate.invite["en-US"]:
                await interaction.reply({
                    embeds: [
                        {
                            title: 'Invite',
                            description: Translate.inviteMeToYourServer[interaction.locale] ?? Translate.inviteMeToYourServer["en-US"],
                            color: 0x1DA1F2,
                            fields: [
                                {
                                    name: 'Invite link',
                                    value: '[click here!](https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877958144&scope=bot%20applications.commands)'
                                }
                            ]
                        }
                    ]
                });
                return

            case Translate.support["en-US"]:
                await interaction.reply({
                    embeds: [
                        {
                            title: 'Support',
                            description: Translate.joinSupportServer[interaction.locale] ?? Translate.joinSupportServer["en-US"],
                            color: 0x1DA1F2,
                            fields: [
                                {
                                    name: 'Support server link',
                                    value: '[Join the support server](https://discord.gg/DsHgvNU8GY)'
                                }
                            ]
                        }
                    ]
                });
                return

            case Translate.settings["en-US"]:
                switch (interaction.options.getSubcommand()) {
                    case Translate.disable["en-US"]:
                        //user channel role
                        const disable_option_user = interaction.options.getUser('user');
                        const disable_option_channel = interaction.options.getChannel('channel');
                        const disable_option_role = interaction.options.getRole('role');

                        if (option_user) {
                            //DBにoption_userを追加する
                            const option_user_data = {
                                guildId: interaction.guild.id,
                                disable_users: disable_option_user
                            };
                            const result = await settingsInputDb(option_user_data);
                            if (!result) await interaction.reply("無効化するユーザーを追加できませんでした");
                            else return await interaction.reply("無効化するユーザーを追加しました");
                        }
                        else if (option_channel) {
                            //DBにoption_channelを追加する
                            const option_channel_data = {
                                guildId: interaction.guild.id,
                                disable_channels: disable_option_channel
                            };
                            const result = await settingsInputDb(option_channel_data);
                            if (!result) await interaction.reply("無効化するチャンネルを追加できませんでした");
                            else return await interaction.reply("無効化するチャンネルを追加しました");
                        }
                        else if (option_role) {
                            //DBにoption_roleを追加する
                            const option_role_data = {
                                guildId: interaction.guild.id,
                                disable_roles: disable_option_role
                            };
                            const result = await settingsInputDb(option_role_data);
                            if (!result) await interaction.reply("無効化するロールを追加できませんでした");
                            else return await interaction.reply("無効化するロールを追加しました");
                        }
                        return
                        
                    case "anonymous":
                        //user channel role
                        const anonymous_option_user = interaction.options.getUser('user');
                        const anonymous_option_channel = interaction.options.getChannel('channel');
                        const anonymous_option_role = interaction.options.getRole('role');

                        if (anonymous_option_user) {
                            //DBにanonymous_option_userを追加する
                            const anonymous_option_user_data = {
                                guildId: interaction.guild.id,
                                anonymous_users: anonymous_option_user
                            };
                            const result = await settingsInputDb(anonymous_option_user_data);
                            if (!result) await interaction.reply("匿名モードを有効化するユーザーを追加できませんでした");
                            else return await interaction.reply("匿名モードを有効化するユーザーを追加しました");
                        }
                        else if (anonymous_option_channel) {
                            //DBにanonymous_option_channelを追加する
                            const anonymous_option_channel_data = {
                                guildId: interaction.guild.id,
                                anonymous_channels: anonymous_option_channel
                            };
                            const result = await settingsInputDb(anonymous_option_channel_data);
                            if (!result) await interaction.reply("匿名モードを有効化するチャンネルを追加できませんでした");
                            else return await interaction.reply("匿名モードを有効化するチャンネルを追加しました");
                        }
                        else if (anonymous_option_role) {
                            //DBにanonymous_option_roleを追加する
                            const anonymous_option_role_data = {
                                guildId: interaction.guild.id,
                                anonymous_roles: anonymous_option_role
                            };
                            const result = await settingsInputDb(anonymous_option_role_data);
                            if (!result) await interaction.reply("匿名モードを有効化するロールを追加できませんでした");
                            else return await interaction.reply("匿名モードを有効化するロールを追加しました");
                        }

                        case Translate.banWord["en-US"]:
                            //word
                            const option_word = interaction.options.getString(Translate.word["en-US"]);
                            connection.query('SELECT bannedWords FROM settings WHERE guildId = ?', [interaction.guild.id], async (err, results) => {
                                if (err) {
                                    console.log(err);
                                    await interaction.reply("エラーが発生しました");
                                    return;
                                }
                                // 現在のbannedWordsを取得し、新しい単語を追加
                                let currentBannedWords = results[0].bannedWords ?? '';
                                let bannedWordsArray = currentBannedWords.split(',')
                                if (!bannedWordsArray.includes(option_word)) {
                                    bannedWordsArray.push(option_word);
                                }
                                const updatedBannedWords = bannedWordsArray.join(',');
        
                                const option_word_data = {
                                    guildId: interaction.guild.id,
                                    bannedWords: updatedBannedWords
                                };
                                const result_word = await settingsInputDb(option_word_data);
                                if (!result_word) await interaction.reply("禁止ワードを追加できませんでした");
                                else return await interaction.reply("禁止ワードを追加しました");
                            });
                            return

                    case Translate.defaultLanguage["en-US"]:
                        //language
                        const option_language = interaction.options.getString(Translate.language["en-US"]);
                        const option_language_data = {
                            guildId: interaction.guild.id,
                            defaultLanguage: option_language
                        };
                        const result_language = await settingsInputDb(option_language_data);
                        if (!result_language) await interaction.reply("デフォルトの言語を設定できませんでした");
                        else return await interaction.reply("デフォルトの言語を設定しました");

                    case Translate.editOriginalIfTranslate["en-US"]:
                        //boolean
                        const option_editOriginalIfTranslate_boolean = interaction.options.getBoolean(Translate.boolean["en-US"]);
                        const option_editOriginalIfTranslate_data = {
                            guildId: interaction.guild.id,
                            editOriginalIfTranslate: option_editOriginalIfTranslate_boolean
                        };
                        const result_editOriginalIfTranslate_boolean = await settingsInputDb(option_editOriginalIfTranslate_data);
                        if (!result_editOriginalIfTranslate_boolean) await interaction.reply("翻訳ボタンが押されたときに元メッセージを編集するかどうかを設定できませんでした");
                        else return await interaction.reply("翻訳ボタンが押されたときに元メッセージを編集するかどうかを設定しました");

                    case Translate.showMediaAsAttachments["en-US"]:
                        //boolean
                        const option_showMediaAsAttachments_boolean = interaction.options.getBoolean(Translate.boolean["en-US"]);
                        const option_showMediaAsAttachments_data = {
                            guildId: interaction.guild.id,
                            showMediaAsAttachments: option_showMediaAsAttachments_boolean
                        };
                        const result_showMediaAsAttachments_boolean = await settingsInputDb(option_showMediaAsAttachments_data);
                        if (!result_showMediaAsAttachments_boolean) await interaction.reply("メディアを添付ファイルとして送信するかどうかを設定できませんでした");
                        else return await interaction.reply("メディアを添付ファイルとして送信するかどうかを設定しました");

                    case Translate.deleteIfOnlyPostedTweetlink["en-US"]:
                        //boolean
                        const option_deleteIfOnlyPostedTweetlink_boolean = interaction.options.getBoolean(Translate.boolean["en-US"]);
                        const option_deleteIfOnlyPostedTweetlink_data = {
                            guildId: interaction.guild.id,
                            deleteMessageIfOnlyPostedTweetLink: option_deleteIfOnlyPostedTweetlink_boolean
                        };
                        const result_deleteIfOnlyPostedTweetlink_boolean = await settingsInputDb(option_deleteIfOnlyPostedTweetlink_data);
                        if (!result_deleteIfOnlyPostedTweetlink_boolean) await interaction.reply("ツイートリンクのみのメッセージを削除するかどうかを設定できませんでした");
                        else return await interaction.reply("ツイートリンクのみのメッセージを削除するかどうかを設定しました");

                    case Translate.alwaysReplyIfPostedTweetlink['en-US']:
                        //boolean
                        const option_alwaysReplyIfPostedTweetlink_boolean = interaction.options.getBoolean(Translate.boolean["en-US"]);
                        const option_alwaysReplyIfPostedTweetlink_data = {
                            guildId: interaction.guild.id,
                            alwaysReply: option_alwaysReplyIfPostedTweetlink_boolean
                        };
                        const result_alwaysReplyIfPostedTweetlink_boolean = await settingsInputDb(option_alwaysReplyIfPostedTweetlink_data);
                        if (!result_alwaysReplyIfPostedTweetlink_boolean) await interaction.reply("ツイートリンクのみのメッセージを削除するかどうかを設定できませんでした");
                        else return await interaction.reply("ツイートリンクのみのメッセージを削除するかどうかを設定しました");

                    case Translate.button["en-US"]:
                        //showMediaAsAttachments showAttachmentsAsEmbedsImage translate delete reload
                        const option_showMediaAsAttachments = interaction.options.Boolean(Translate.boolean["en-US"]);
                        const option_showAttachmentsAsEmbedsImage = interaction.options.Boolean(Translate.boolean["en-US"]);
                        const option_translate = interaction.options.Boolean(Translate.boolean["en-US"]);
                        const option_delete = interaction.options.Boolean(Translate.boolean["en-US"]);
                        const option_reload = interaction.options.Boolean(Translate.boolean["en-US"]);

                        if (option_showMediaAsAttachments) {
                            //option_showMediaAsAttachmentsを反転させる
                            const option_showMediaAsAttachments_boolean_data = {
                                guildId: interaction.guild.id,
                                showMediaAsAttachments: option_showMediaAsAttachments
                            };
                            const result_showMediaAsAttachments_boolean = await settingsInputDb(option_showMediaAsAttachments_boolean_data);
                            if (!result_showMediaAsAttachments_boolean) await interaction.reply("メディアを添付ファイルとして送信するかどうかを設定できませんでした");
                            else return await interaction.reply("メディアを添付ファイルとして送信するかどうかを設定しました");
                        }
                        else if (option_showAttachmentsAsEmbedsImage) {
                            //option_showAttachmentsAsEmbedsImageを反転させる
                            const option_showAttachmentsAsEmbedsImage_boolean_data = {
                                guildId: interaction.guild.id,
                                showAttachmentsAsEmbedsImage: option_showAttachmentsAsEmbedsImage
                            };
                            const result_showAttachmentsAsEmbedsImage_boolean = await settingsInputDb(option_showAttachmentsAsEmbedsImage_boolean_data);
                            if (!result_showAttachmentsAsEmbedsImage_boolean) await interaction.reply("画像を埋め込みとして送信するかどうかを設定できませんでした");
                            else return await interaction.reply("画像を埋め込みとして送信するかどうかを設定しました");
                        }
                        else if (option_translate) {
                            //option_translateを反転させる
                            const option_translate_boolean_data = {
                                guildId: interaction.guild.id,
                                translate: option_translate
                            };
                            const result_translate_boolean = await settingsInputDb(option_translate_boolean_data);
                            if (!result_translate_boolean) await interaction.reply("翻訳ボタンを表示するかどうかを設定できませんでした");
                            else return await interaction.reply("翻訳ボタンを表示するかどうかを設定しました");
                        }
                        else if (option_delete) {
                            //option_deleteを反転させる
                            const option_delete_boolean_data = {
                                guildId: interaction.guild.id,
                                delete: option_delete
                            };
                            const result_delete_boolean = await settingsInputDb(option_delete_boolean_data);
                            if (!result_delete_boolean) await interaction.reply("削除ボタンを表示するかどうかを設定できませんでした");
                            else return await interaction.reply("削除ボタンを表示するかどうかを設定しました");
                        }
                        else if (option_reload) {
                            //option_reloadを反転させる
                            const option_reload_boolean_data = {
                                guildId: interaction.guild.id,
                                reload: option_reload
                            };
                            const result_reload_boolean = await settingsInputDb(option_reload_boolean_data);
                            if (!result_reload_boolean) await interaction.reply("再読み込みボタンを表示するかどうかを設定できませんでした");
                            else return await interaction.reply("再読み込みボタンを表示するかどうかを設定しました");
                        }
                        return

                    case Translate.extractBotMessage["en-US"]:
                        //boolean
                        const option_extractBotMessage_boolean = interaction.options.getBoolean(Translate.boolean["en-US"]);
                        const option_extractBotMessage_boolean_data = {
                            guildId: interaction.guild.id,
                            extractBotMessage: option_extractBotMessage_boolean
                        };
                        const result_extractBotMessage_boolean = await settingsInputDb(option_extractBotMessage_boolean_data);
                        if (!result_extractBotMessage_boolean) await interaction.reply("Botのメッセージを抽出するかどうかを設定できませんでした");
                        else return await interaction.reply("Botのメッセージを抽出するかどうかを設定しました");

                    case Translate.setsWhetherToExpandQuoteRetweets["en-US"]:
                        //boolean
                        const option_setsWhetherToExpandQuoteRetweets_boolean = interaction.options.getBoolean(Translate.boolean["en-US"]);
                        const option_setsWhetherToExpandQuoteRetweets_boolean_data = {
                            guildId: interaction.guild.id,
                            setsWhetherToExpandQuoteRetweets: option_setsWhetherToExpandQuoteRetweets_boolean
                        };
                        const result_setsWhetherToExpandQuoteRetweets_boolean = await settingsInputDb(option_setsWhetherToExpandQuoteRetweets_boolean_data);
                        if (!result_setsWhetherToExpandQuoteRetweets_boolean) await interaction.reply("引用リツイートを展開するかどうかを設定できませんでした");
                        else return await interaction.reply("引用リツイートを展開するかどうかを設定しました");
                    
                    case "maxExtractQuotedTweet":
                        //number
                        const option_maxExtractQuotedTweet_number = interaction.options.getInteger("number");
                        const option_maxExtractQuotedTweet_number_data = {
                            guildId: interaction.guild.id,
                            maxExtractQuotedTweet: option_maxExtractQuotedTweet_number
                        };
                        const result_maxExtractQuotedTweet_number = await settingsInputDb(option_maxExtractQuotedTweet_number_data);
                        if (!result_maxExtractQuotedTweet_number) await interaction.reply("引用ツイートを展開する数を設定できませんでした");
                        else return await interaction.reply("引用ツイートを展開する数を設定しました");
                    }
                return
        }
    });
});

async function settingsInputDb(value) {
    const query = 'UPDATE settings SET ?';
    return new Promise((resolve, reject) => {
        connection.query(query, [value], (err, results, fields) => {
            if (err) {
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
}

/* 

settingsテーブルの詳細な説明
    guildId    bigint(20)    :ギルドID
    bannedWords    text NULL    :禁止ワードをカンマ区切り。禁止ワードがない場合はNULL。カンマが禁止ワードに含まれている場合は{#!comma}に置換されているため復元の必要あり
    defaultLanguage    char(7) [en-US]    :デフォルトの言語
    editOriginalIfTranslate    tinyint(4) [0]    :翻訳ボタンが押されたときに元メッセージを編集するかどうか
    sendMediaAsAttachmentsAsDefault    tinyint(4) [0]    :デフォルトでメディアを添付ファイルとして送信するかどうか
    deleteMessageIfOnlyPostedTweetLink    tinyint(4) [0]    :ツイートリンクのみのメッセージを削除するかどうか
    alwaysReply    tinyint(4) [0]    :常に返信の形で内容を送信するかどうか。しない場合はチャンネルに送信する
    button_invisible_showMediaAsAttachments    tinyint(4) [0]:メディアを添付ファイルとして送信するボタンを表示するかどうか    
    button_invisible_showAttachmentsAsEmbedsImage    tinyint(4) [0]    :画像を埋め込みとして送信するボタンを表示するかどうか
    button_invisible_translate    tinyint(4) [0]    :翻訳ボタンを表示するかどうか
    button_invisible_delete    tinyint(4) [0]    :削除ボタンを表示するかどうか
    button_invisible_reload    tinyint(4) [0]    :再読み込みボタンを表示するかどうか(userのplanが1か2の場合のみ)
    button_disabled_users    text NULL    :ボタンを無効化するユーザーのIDをカンマ区切り。ボタンを無効化しない場合はNULL。
    button_disabled_channels    text NULL    :ボタンを無効化するチャンネルのIDをカンマ区切り。ボタンを無効化しない場合はNULL。
    button_disabled_roles    text NULL    :ボタンを無効化するロールのIDをカンマ区切り。ボタンを無効化しない場合はNULL。
    disable_users    text NULL    :BOTが無視するユーザーのIDをカンマ区切り。無効化しない場合はNULL。
    disable_channels    text NULL    :BOTが無視するチャンネルのIDをカンマ区切り。無効化しない場合はNULL。
    disable_roles    text NULL    :BOTが無視するロールのIDをカンマ区切り。無効化しない場合はNULL。
    extractBotMessage    tinyint(4) [0]    :BOTのメッセージに反応するかどうか
    extractWebhookMessage    tinyint(4) [0]    :Webhookのメッセージに反応するかどうか
    sendMovieAsLink    tinyint(4) [0]    :動画をリンクとして送信するかどうか。しない場合は添付ファイルとして送信するが、もし動画が添付ファイルとして送信できない場合はリンクとして送信する。　リンクとして送信する場合は [動画リンク](<動画のURL>)という形式で送信する
    anonymous_users    text NULL    :匿名モードを有効化するユーザーのIDをカンマ区切り。匿名化しない場合はNULL。
    anonymous_channels    text NULL    :匿名モードを有効化するチャンネルのIDをカンマ区切り。匿名化しない場合はNULL。
    anonymous_roles    text NULL    :匿名モードを有効化するロールのIDをカンマ区切り。匿名化しない場合はNULL。
    maxExtractQuotedTweet int(11) [3]    :引用ツイートを何個まで展開するか

    匿名モード：
    twitterのユーザー名やアイコン、誰が送信したかを表示しないモード。
    ツイートリンクも表示されない。
    削除ボタンは表示されない。

*/

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
        if (settings.extractBotMessage == 0 && message.author.bot) return;
        //webhookのメッセージに反応するかどうか
        if (settings.extractWebhookMessage == 0 && message.webhookId != null) return;
        //ユーザーが無効化されているかどうか
        if (settings.disable_users != null) {
            const disable_users = settings.disable_users.split(',');
            for (let i = 0; i < disable_users.length; i++) {
                if (message.author.id == disable_users[i]) return;
            }
        }
        //チャンネルが無効化されているかどうか
        if (settings.disable_channels != null) {
            const disable_channels = settings.disable_channels.split(',');
            for (let i = 0; i < disable_channels.length; i++) {
                if (message.channel.id == disable_channels[i]) return;
            }
        }
        //ロールが無効化されているかどうか
        if (settings.disable_roles != null) {
            const disable_roles = settings.disable_roles.split(',');
            for (let i = 0; i < disable_roles.length; i++) {
                if (message.member.roles.cache.has(disable_roles[i])) return;
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
                });
                //プランは無料
                plan = 0;
                enabled = 1;
            } else {
                //ユーザーが存在する場合はそれを使用する
                plan = results[0].plan;
                //もし有料プランの有効期限が切れていた場合はプランを無料にする
                if (results[0].paid_plan_expired_at < new Date().getTime()) plan = 0;
                const updateSQL = 'UPDATE users SET plan = ? WHERE userid = ?';
                const updateParams = [plan, message.author.id];
                connection.query(updateSQL, updateParams, (error, results, fields) => {
                    if (error) {
                        console.error('Error connecting to database:', error);
                        return;
                    }
                });
                enabled = results[0].enabled;
            }
            //もしenabledが0の場合は処理を終了する
            if (enabled == 0) return;

            /*******************************************************/
            /*                     2024/01/01                       */
            /* 石川県を中心に甚大な被害が出た巨大地震・津波が発生      */
            /* 情報共有を支援するために期限未定で全員に有料プランを開放*/
            /*******************************************************/
            plan = 2;
            
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
    //ボタンが押された時の処理
    if (!interaction.isButton()) return;
    await interaction.deferReply({ ephemeral: true });
    //DBより設定を取得
    const sql = 'SELECT * FROM settings WHERE guildId = ?';
    const params = [interaction.guildId];
    connection.query(sql, params, async (error, results, fields) => {
        if (error) {
            console.error('Error connecting to database:', error);
            return;
        }
        let settings = null;
        if (results.length == 0) {
            //設定がない場合はデフォルトの設定を使用する
            const defaultSettings = {
                guildId: interaction.guildId,
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
            settings = results[0];
        }

        //ボタンが無効化されているかどうか
        if (settings.button_disabled_users != null) {
            const button_disabled_users = settings.button_disabled_users.split(',');
            for (let i = 0; i < button_disabled_users.length; i++) {
                if (interaction.user.id == button_disabled_users[i]) {
                    await interaction.editReply({ content: Translate.youcantusebuttons[interaction.locale] ?? Translate.youcantusebuttons[settings.defaultLanguage], ephemeral: true });
                    setTimeout(() => {
                        interaction.deleteReply();
                    }, 3000);
                    return;
                }
            }
        }
        //ボタンが無効化されているかどうか
        if (settings.button_disabled_channels != null) {
            const button_disabled_channels = settings.button_disabled_channels.split(',');
            for (let i = 0; i < button_disabled_channels.length; i++) {
                if (interaction.channel.id == button_disabled_channels[i]) {
                    await interaction.editReply({ content: Translate.youcantusebuttons[interaction.locale] ?? Translate.youcantusebuttons[settings.defaultLanguage], ephemeral: true });
                    setTimeout(() => {
                        interaction.deleteReply();
                    }, 3000);
                    return;
                }
            }
        }
        //ボタンが無効化されているかどうか
        if (settings.button_disabled_roles != null) {
            const button_disabled_roles = settings.button_disabled_roles.split(',');
            for (let i = 0; i < button_disabled_roles.length; i++) {
                if (interaction.member.roles.cache.has(button_disabled_roles[i])) {
                    await interaction.editReply({ content: Translate.youcantusebuttons[interaction.locale] ?? Translate.youcantusebuttons[settings.defaultLanguage], ephemeral: true });
                    setTimeout(() => {
                        interaction.deleteReply();
                    }, 3000);
                    return;
                }
            }
        }

        const deleteButton = new ButtonBuilder()
            .setCustomId('delete')
            .setLabel(Translate.delete[settings.defaultLanguage])
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
        const translateButton = new ButtonBuilder()
            .setCustomId('translate')
            .setLabel(Translate.translate[settings.defaultLanguage])
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🌐')
        const showAttachmentsAsMediaButton = new ButtonBuilder()
            .setCustomId('showAttachmentsAsEmbedsImage')
            .setLabel(Translate.showAttachmentsAsEmbedsImage[settings.defaultLanguage])
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📷');
        const showMediaAsAttachmentsButton = new ButtonBuilder()
            .setCustomId('showMediaAsAttachments')
            .setLabel(Translate.showMediaAsAttachments[settings.defaultLanguage])
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📎');
        const reloadButton = new ButtonBuilder()
            .setCustomId('reload')
            .setLabel(Translate.reload[settings.defaultLanguage])
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄')
        let actionRow = new discord.ActionRowBuilder();
        switch (interaction.customId) {
            case 'showMediaAsAttachments':
                const messageObject = {};
                messageObject.files = [];
                messageObject.embeds = [];
                messageObject.components = [];
                interaction.message.embeds.forEach(element => {
                    if (element.image) {
                        messageObject.files.push(element.image.url);
                    }
                });
                let deepCopyEmbed0 = JSON.parse(JSON.stringify(interaction.message.embeds[0]));
                delete deepCopyEmbed0.image;
                messageObject.embeds.push(deepCopyEmbed0);
                if (messageObject.embeds[0].image) delete messageObject.embeds.image;
                if (settings.button_invisible_showAttachmentsAsEmbedsImage == 0 && messageObject.files != undefined) actionRow.addComponents(showAttachmentsAsMediaButton);
                if (settings.button_invisible_translate == 0) actionRow.addComponents(translateButton);
                if (settings.button_invisible_delete == 0) actionRow.addComponents(deleteButton);
                messageObject.components.push(actionRow);
                await interaction.message.edit(messageObject);
                await interaction.editReply({ content: Translate.finishedAction[interaction.locale] ?? Translate.finishedAction[settings.defaultLanguage], ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
                break;

            case 'showAttachmentsAsEmbedsImage':
                const messageObject2 = {};
                messageObject2.components = [];
                if (interaction.message.attachments === undefined || interaction.message.attachments === null) return interaction.reply('There are no attachments to show.');
                const attachments = interaction.message.attachments.map(attachment => attachment.url);
                if (attachments.length > 4) return interaction.reply('You can\'t show more than 4 attachments as embeds image.');
                if (settings.button_invisible_showMediaAsAttachments == 0) actionRow.addComponents(showMediaAsAttachmentsButton);
                if (settings.button_invisible_translate == 0) actionRow.addComponents(translateButton);
                if (settings.button_invisible_delete == 0) actionRow.addComponents(deleteButton);
                messageObject2.components.push(actionRow);
                messageObject2.embeds = [];
                attachments.forEach(element => {
                    const extension = element.split("?").pop().split('.').pop();
                    if (messageObject2.embeds.length === 0) {
                        let embed = {};
                        embed.url = interaction.message.embeds[0].url;
                        embed.title = interaction.message.embeds[0].title;
                        embed.description = interaction.message.embeds[0].description;
                        embed.color = interaction.message.embeds[0].color;
                        embed.author = interaction.message.embeds[0].author;
                        embed.footer = interaction.message.embeds[0].footer;
                        embed.timestamp = interaction.message.embeds[0].timestamp;
                        embed.fields = interaction.message.embeds[0].fields;
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
                await interaction.editReply({ content: Translate.finishedAction[interaction.locale] ?? Translate.finishedAction[settings.defaultLanguage], ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
                break;

            case 'delete':
                if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                    await interaction.message.delete();
                    await interaction.editReply({ content: Translate.finishedAction[interaction.locale] ?? Translate.finishedAction[settings.defaultLanguage], ephemeral: true });
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
                    await interaction.editReply({ content: Translate.finishedAction[interaction.locale] ?? Translate.finishedAction[settings.defaultLanguage], ephemeral: true });
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
                await interaction.editReply({ content: Translate.finishedAction[interaction.locale] ?? Translate.finishedAction[settings.defaultLanguage], ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
                break;

            case 'reload':
                await interaction.editReply({ content: "この機能は現在開発中です", ephemeral: true });
                setTimeout(() => {
                    interaction.deleteReply();
                }, 3000);
                break;
        }
    });
})

client.login(config.token);

