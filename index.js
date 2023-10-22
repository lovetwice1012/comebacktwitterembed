//discord.js v14
const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const config = require('./config.json');
const fetch = require('node-fetch');
const fs = require('fs');
const deepl = require('deepl-node');
const authKey = config.deeplAuthKey;
const translator = new deepl.Translator(authKey);

if (!fs.existsSync('./settings.json')) {
    fs.writeFileSync('./settings.json', JSON.stringify({
        "disable": {
            "user": [],
            "channel": [],
        },
        "bannedWords": {},
        "defaultLanguage": {},
        "editOriginalIfTranslate": {}
    }, null, 4));
}
const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));

if (settings.defaultLanguage === undefined) {
    settings.defaultLanguage = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
}

if (settings.editOriginalIfTranslate === undefined) {
    settings.editOriginalIfTranslate = {};
    fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
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
    ja: 'ユーザーまたはチャンネルを指定する必要があります。',
    en: 'You must specify a user or channel.'
}

const userCantSpecifyBothAUserAndAChannelLocales = {
    ja: 'ユーザーとチャンネルの両方を指定することはできません。',
    en: 'You can\'t specify both a user and a channel.'
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
    ja: 'ワードを指定する必要があります。',
    en: 'You must specify a word.'
}

const defaultLanguageDiscriptionLocales = {
    ja: '翻訳するときのデフォルトの言語を設定します。',
    en: 'Sets the default language when translating.'
}

const editoriginaliftranslateDiscriptionLocales = {
    ja: '翻訳するときにオリジナルのメッセージを編集するかどうかを設定します。',
    en: 'Sets whether to edit the original message when translating.'
}

const deleteButtonLavelLocales = {
    ja: '削除',
    en: 'Delete'
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



function conv_en_to_en_US(obj) {
    if (obj === undefined) return undefined;
    if (obj["en"] !== undefined) {
        obj["en-US"] = obj["en"];
        delete obj["en"];
    } else {
        return undefined;
    }
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

    client.application.commands.set([
        {
            name: 'help',
            description: 'Shows help message.',
            descriptionLocalizations: conv_en_to_en_US(helpcommandDescriptionLocalizations)
        },
        {
            name: 'ping',
            description: 'Pong!',
            descriptionLocalizations: conv_en_to_en_US(pingcommandDescriptionLocalizations)
        },
        {
            name: 'invite',
            description: 'Invite me to your server!',
            descriptionLocalizations: conv_en_to_en_US(invitecommandDescriptionLocalizations)
        },
        {
            name: 'support',
            description: 'Join support server!',
            descriptionLocalizations: conv_en_to_en_US(supportcommandDescriptionLocalizations)
        },
        {
            name: 'settings',
            description: 'chenge Settings',
            descriptionLocalizations: conv_en_to_en_US(settingscommandDescriptionLocalizations),
            options: [
                {
                    name: 'disable',
                    description: 'disable',
                    descriptionLocalizations: conv_en_to_en_US(settingsDisableDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            description: 'user',
                            descriptionLocalizations: conv_en_to_en_US(settingsDisableUserDescriptionLocalizations),
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: 'channel',
                            description: 'channel',
                            descriptionLocalizations: conv_en_to_en_US(settingsDisableChannelDescriptionLocalizations),
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        }
                    ]
                },
                {
                    name: 'bannedwords',
                    description: 'bannedWords',
                    descriptionLocalizations: conv_en_to_en_US(settingsBannedWordsDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'word',
                            description: 'word',
                            descriptionLocalizations: conv_en_to_en_US(settingsBannedWordsWordDescriptionLocalizations),
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'defaultlanguage',
                    description: 'defaultLanguage',
                    descriptionLocalizations: conv_en_to_en_US(defaultLanguageDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'language',
                            description: 'language',
                            descriptionLocalizations: conv_en_to_en_US(defaultLanguageLanguageDescriptionLocalizations),
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
                    description: 'editOriginalIfTranslate',
                    descriptionLocalizations: conv_en_to_en_US(editoriginaliftranslateDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
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

function getStringFromObject(object, locale) {
    if(object === undefined) return undefined;
    if(locale === undefined){
        if(object["en"] !== undefined) {
            return object["en"];
        }
        return undefined;
    };
    if (object[locale] !== undefined) {
        return object[locale];
    } else if (object["en"] !== undefined) {
        return object["en"];
    } else {
        return undefined;
    }
}

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot && !message.webhookId) return;
    if ((message.content.includes('twitter.com') || message.content.includes('x.com')) && message.content.includes('status')) {
        const url = message.content.match(/(https?:\/\/[^\s]+)/g);
        if (url === null) return;
        if (settings.disable.user.includes(message.author.id)) return;
        if (settings.disable.channel.includes(message.channel.id)) return;
        for (let i = 0; i < url.length; i++) {
            const element = url[i];
            //replace twitter.com or x.com with api.vxtwitter.com
            var newUrl = element.replace(/twitter.com|x.com/g, 'api.vxtwitter.com');
            if (newUrl.split("/").length > 6) {
                newUrl = newUrl.split("/").slice(0, 6).join("/");
            }
            //fetch the api
            fetch(newUrl)
                .then(res => res.json())
                .then(json => {
                    attachments = [];
                    let embeds = [];
                    let showMediaAsAttachmentsButton = null;
                    const deleteButton = new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(getStringFromObject(deleteButtonLabelLocales, settings.defaultLanguage[message.guild.id])).setCustomId('delete');
                    const translateButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(translateButtonLabelLocales, settings.defaultLanguage[message.guild.id])).setCustomId('translate');
                    let messageObject = {
                        allowedMentions: {
                            repliedUser: false
                        }
                    };
                    let detected_bannedword = false;
                    if (settings.bannedWords[message.guildId] !== undefined) {
                        for(let i = 0; i < settings.bannedWords[message.guildId].length; i++) {
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
                        json.text = json.text.slice(0, 300) + '...';
                    }
                    const embed = {
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
                    embeds.push(embed);
                    if (json.mediaURLs) {
                        if (json.mediaURLs.length > 4) {
                            if (json.mediaURLs.length > 10) {
                                json.mediaURLs = json.mediaURLs.slice(0, 10);
                            }
                            attachments = json.mediaURLs
                        } else {
                            json.mediaURLs.forEach(element => {
                                if (element.includes('video.twimg.com')) {
                                    attachments.push(element);
                                    return;
                                }
                                showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(getStringFromObject(showMediaAsAttachmentsButtonLocales, settings.defaultLanguage[message.guild.id])).setCustomId('showMediaAsAttachments');
                                embeds.push({
                                    url: json.tweetURL,
                                    image: {
                                        url: element
                                    }
                                })
                            });
                        }
                    }
                    if (attachments.length > 0) messageObject.files = attachments;
                    if (showMediaAsAttachmentsButton !== null) messageObject.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
                    if (!messageObject.components) messageObject.components = [];
                    messageObject.components.push({ type: ComponentType.ActionRow, components: [translateButton,deleteButton] });
                    messageObject.embeds = embeds;
                    message.reply(messageObject);
                })
                .catch(err => {
                    console.log(err);
                });
        };
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.ApplicationCommand) return;
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
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
                if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null) {
                    return await interaction.reply(userMustSpecifyAUserOrChannelLocales[interaction.locale] ?? userMustSpecifyAUserOrChannelLocales["en"]);
                }

                if (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) {
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
                    await interaction.reply(setdefaultlanguagetolocales[interaction.locale] ?? setdefaultlanguagetolocales["en"] + language);
                } else {
                    await interaction.reply('You must specify either en or ja.');
                }
            } else if (interaction.options.getSubcommand() === 'editoriginaliftranslate') {
                if (interaction.options.getBoolean('boolean') === null) return await interaction.reply(userMustSpecifyAnyWordLocales[interaction.locale] ?? userMustSpecifyAnyWordLocales["en"]);
                const boolean = interaction.options.getBoolean('boolean');
                settings.editOriginalIfTranslate[interaction.guildId] = boolean;
                await interaction.reply(seteditoriginaliftranslatetolocales[interaction.locale] ?? seteditoriginaliftranslatetolocales["en"] + boolean);
            }
        } else {
            if (interaction.options.getSubcommand() === 'disable') {
                if (interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null) {
                    return await interaction.reply(userMustSpecifyAUserOrChannelLocales[interaction.locale] ?? userMustSpecifyAUserOrChannelLocales["en"]);
                }

                if (interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null) {
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
                }
            } else if (interaction.options.getSubcommand() === 'bannedwords') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'defaultlanguage') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            } else if (interaction.options.getSubcommand() === 'editoriginaliftranslate') {
                await interaction.reply(userDonthavePermissionLocales[interaction.locale] ?? userDonthavePermissionLocales["en"]);
            }
        }
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.MessageComponent || interaction.type === InteractionType.ApplicationCommand) return;
    await interaction.deferReply({ ephemeral: true });
    const deleteButton = new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel('Delete').setCustomId('delete');
    const translateButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Translate').setCustomId('translate');
    const showAttachmentsAsMediaButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showAttachmentsAsEmbedsImagebuttonLocales[interaction.locale] ?? showAttachmentsAsEmbedsImagebuttonLocales["en"]).setCustomId('showAttachmentsAsEmbedsImage');
    const showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showMediaAsAttachmentsButtonLocales[interaction.locale] ?? showMediaAsAttachmentsButtonLocales["en"]).setCustomId('showMediaAsAttachments');
    
    switch (interaction.customId) {
        case 'showMediaAsAttachments':
            const messageObject = {};
            messageObject.components = [{ type: ComponentType.ActionRow, components: [showAttachmentsAsMediaButton] }];
            messageObject.components.push({ type: ComponentType.ActionRow, components: [translateButton,deleteButton] });
            messageObject.files = [];
            messageObject.embeds = [];
            interaction.message.embeds.forEach(element => {
                if (element.image) {
                    messageObject.files.push(element.image.url);
                }
            });
            messageObject.embeds.push(interaction.message.embeds[0]);
            if (messageObject.embeds[0].image) delete messageObject.embeds.image;
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
            messageObject2.components.push({ type: ComponentType.ActionRow, components: [translateButton,deleteButton] });
            messageObject2.embeds = [];
            messageObject2.embeds.push(interaction.message.embeds[0]);
            if (messageObject2.embeds[0].image) delete messageObject2.embeds.image;
            attachments.forEach(element => {
                const extension = element.split("?").pop().split('.').pop();
                if (videoExtensions.includes(extension)) {
                    messageObject2.files.push(element);
                    return;
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
            if(interaction.message.embeds[0].images){
                copyEmbedObject.image = interaction.message.embeds[0].image;
            }
            if(interaction.message.embeds[0].thumbnail)copyEmbedObject.thumbnail = interaction.message.embeds[0].thumbnail;
            messageObject3.embeds.push(copyEmbedObject);
            if(interaction.message.embeds.length > 1) {
                for(let i = 1; i < interaction.message.embeds.length; i++) {
                    messageObject3.embeds.push(interaction.message.embeds[i]);
                }
            }
            const translated = await translator.translateText(interaction.message.embeds[0].description, null, interaction.locale);  
            messageObject3.embeds[0].description = translated.text;
            await interaction.editReply(messageObject3);
            if(settings.editOriginalIfTranslate[interaction.guildId] === true) {
            if(interaction.message.attachments.length > 0){
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

client.login(config.token);