// Discord.js v14 - Twitter Embed Bot
// Refactored version using modular architecture

// ============================================================================
// Module Imports
// ============================================================================

// Core Discord.js
const {
    Events,
    ActivityType,
    InteractionType,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    PermissionsBitField,
    ApplicationCommandOptionType
} = require('discord.js');

// Configuration & Database
const client = require('./src/config/discord');
const connection = require('./src/config/database');
const { MUST_BE_MAIN_INSTANCE } = require('./src/config/constants');

// Utilities
const { antiDirectoryTraversalAttack } = require('./src/utils/security');
const {
    getStringFromObject,
    ifUserHasRole,
    convertBoolToEnableDisable,
    sendContentPromise,
    checkComponentIncludesDisabledButtonAndIfFindDeleteIt,
    conv_en_to_en_US
} = require('./src/utils/helpers');
const { loadSettings, saveSettings, getSettings } = require('./src/utils/settings');

// Localization
const { t, getLocaleObject, convEnToEnUS } = require('./src/locales');

// Services
const { initializeConsoleLogger } = require('./src/services/consoleLogger');
const { incrementProcessed, getStats, resetHourly, resetDaily } = require('./src/services/stats');

// External dependencies
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// Constants & Configuration
// ============================================================================

const settings = loadSettings();
const must_be_main_instance = MUST_BE_MAIN_INSTANCE;

const button_disabled_template = {
    user: [],
    channel: [],
    role: []
};

const button_invisible_template = {
    showMediaAsAttachments: false,
    showAttachmentsAsEmbedsImage: false,
    translate: false,
    delete: false,
    all: false
};

const videoExtensions = [
    'mp4', 'mov', 'wmv', 'avi', 'avchd', 'flv', 'f4v', 'swf', 'mkv', 'webm',
    'm4v', '3gp', '3g2', 'mpg', 'mpeg', 'mp2', 'mpe', 'mpv', 'm2v', 'm4p',
    'm4v', 'qt', 'ogv', 'ogg', 'vob', 'drc', 'avi', 'mts', 'm2ts', 'ts'
];

// ============================================================================
// Main Tweet Embed Function
// ============================================================================

async function sendTweetEmbed(message, url, quoted = false, parent = null, saved = false) {
    return new Promise((resolve, reject) => {
        const element = url;
        let newUrl = element.replace(/twitter.com|x.com/g, 'api.vxtwitter.com');

        if (newUrl.split("/").length > 6 && !newUrl.includes("twidata.sprink.cloud")) {
            newUrl = newUrl.split("/").slice(0, 6).join("/");
        }

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

                let attachments = [];
                let embeds = [];
                let showMediaAsAttachmentsButton = null;

                const locale = settings.defaultLanguage[message.guild.id] ?? "en";
                const deleteButton = new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel(t('deleteButton', locale))
                    .setCustomId('delete');
                const translateButton = new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel(t('translateButton', locale))
                    .setCustomId('translate');
                const savetweetButton = new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel(t('saveTweetButton', locale))
                    .setCustomId('savetweet');

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

                    if (detected_bannedword) return message.reply(t('yourcontentsisconteinbannedword', locale)).then(msg => {
                        setTimeout(() => {
                            msg.delete();
                            message.delete().catch(err => {
                                message.channel.send(t('idonthavedeletemessagepermission', locale)).then(msg2 => {
                                    setTimeout(() => {
                                        msg2.delete();
                                    }, 3000);
                                });
                            });
                        }, 3000);
                    });
                }

                if (json.text.length > 1500) {
                    json.text = json.text.slice(0, 1500) + '...';
                }

                let content = [];
                let embed = {}

                if (settings.deletemessageifonlypostedtweetlink[message.guild.id] === undefined)
                    settings.deletemessageifonlypostedtweetlink[message.guild.id] = false;
                if (settings.passive_mode[message.guild.id] === undefined)
                    settings.passive_mode[message.guild.id] = false;
                if (settings.secondary_extract_mode[message.guild.id] === undefined)
                    settings.secondary_extract_mode[message.guild.id] = false;
                if (settings.legacy_mode[message.guild.id] === undefined) {
                    if (message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                        settings.legacy_mode[message.guild.id] = true;
                    } else {
                        settings.legacy_mode[message.guild.id] = false;
                    }
                }

                if (settings.legacy_mode[message.guild.id] === false && !quoted &&
                    (settings.deletemessageifonlypostedtweetlink[message.guild.id] === false ||
                    (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content != url)) &&
                    !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                    embed = {
                        url: json.tweetURL,
                        description: ':speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: 'request by ' + (message.author?.username ?? message.user.username) + '(id:' + (message.author?.id ?? message.user.id) + ')',
                        },
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
                            showMediaAsAttachmentsButton = new ButtonBuilder()
                                .setStyle(ButtonStyle.Primary)
                                .setLabel(t('showAttachmentsAsEmbedsImage', locale))
                                .setCustomId('showAttachmentsAsEmbedsImage');
                        }

                        if (settings.secondary_extract_mode[message.guild.id] === true && !videoflag &&
                            json.mediaURLs.length == 1 && !url.includes("twidata.sprink.cloud") &&
                            !url.includes("localhost:3088")) {
                            if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined ||
                                settings.quote_repost_do_not_extract[message.guild.id] === false)))
                                return await sendTweetEmbed(message, json.qrtURL, true, message);
                            return resolve();
                        }
                    } else {
                        json.mediaURLs.forEach(async element => {
                            if (element.includes('video.twimg.com')) {
                                attachments.push(element);
                                videoflag = true;
                                return;
                            }
                            showMediaAsAttachmentsButton = new ButtonBuilder()
                                .setStyle(ButtonStyle.Primary)
                                .setLabel(t('showMediaAsAttachments', locale))
                                .setCustomId('showMediaAsAttachments');

                            if (json.mediaURLs.length > 1) {
                                if (embeds.length == 0) embeds.push(embed);
                                embeds.push({
                                    url: json.tweetURL,
                                    image: {
                                        url: element
                                    }
                                })
                            } else {
                                if ((settings.legacy_mode[message.guild.id] === false && !quoted &&
                                    (settings.deletemessageifonlypostedtweetlink[message.guild.id] === false ||
                                    (settings.deletemessageifonlypostedtweetlink[message.guild.id] === true && message.content != url)) &&
                                    !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088"))) {
                                    if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined ||
                                        settings.quote_repost_do_not_extract[message.guild.id] === false)))
                                        return await sendTweetEmbed(message, json.qrtURL, true, message);
                                    showMediaAsAttachmentsButton = null
                                    return
                                }
                                embed.image = {
                                    url: element
                                }
                                embeds.push(embed);
                            }
                        });

                        if (settings.secondary_extract_mode[message.guild.id] === true && json.mediaURLs.length == 1 &&
                            !videoflag && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                            if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined ||
                                settings.quote_repost_do_not_extract[message.guild.id] === false)))
                                return await sendTweetEmbed(message, json.qrtURL, true, message);
                            return resolve();
                        }
                    }
                } else if (settings.secondary_extract_mode[message.guild.id] === true &&
                    !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                    if (json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined ||
                        settings.quote_repost_do_not_extract[message.guild.id] === false))
                        await sendTweetEmbed(message, json.qrtURL, true, msg);
                    return resolve();
                }

                if (embeds.length === 0) embeds.push(embed);
                if (attachments.length > 0) messageObject.files = attachments;
                if (showMediaAsAttachmentsButton !== null)
                    messageObject.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
                if (!messageObject.components) messageObject.components = [];
                messageObject.components.push({
                    type: ComponentType.ActionRow,
                    components: embeds[0].title ? [translateButton, deleteButton, savetweetButton] : [deleteButton]
                });
                messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, message.guildId);
                messageObject.embeds = embeds;
                if (quoted) messageObject.content = "Quoted tweet:"

                let msg = null;
                if (settings.legacy_mode[message.guild.id] === true &&
                    message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                    try {
                        await message.suppressEmbeds(true)
                    } catch (err) {
                        // Ignore suppression errors
                    }
                }

                if (settings.alwaysreplyifpostedtweetlink[message.guild.id] === true ||
                    settings.deletemessageifonlypostedtweetlink[message.guild.id] === true || quoted || parent !== null) {
                    if (parent !== null) {
                        msg = await parent.reply(messageObject)
                    } else {
                        msg = await message.reply(messageObject)
                    }
                } else {
                    msg = await message.channel.send(messageObject);
                }

                if ((settings.deletemessageifonlypostedtweetlink[message.guild.id] === true &&
                    message.content === url) ||
                    (settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[message.guild.id] === true &&
                    message.content === url && settings.secondary_extract_mode[message.guild.id] === true &&
                    (videoflag || (json.mediaURLs && json.mediaURLs.length > 1)))) {
                    try {
                        await message.delete()
                    } catch (err) {
                        console.log("Failed to delete message:", err);
                    }
                }

                if ((json.qrtURL !== null && (settings.quote_repost_do_not_extract[message.guild.id] === undefined ||
                    settings.quote_repost_do_not_extract[message.guild.id] === false)) &&
                    !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088")) {
                    await sendTweetEmbed(message, json.qrtURL, true, msg);
                }

                incrementProcessed();
                resolve();
            })
            .catch(err => {
                console.error('Error fetching tweet:', err);
                reject(err);
            });
    });
}

// ============================================================================
// Helper Functions for Message Processing
// ============================================================================

function shouldIgnoreMessage(message) {
    const isBotMessageNotExtracted = message.author.bot &&
        settings.extract_bot_message[message.guild.id] !== true && !message.webhookId;
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
    const isRoleDisabled = !message.webhookId &&
        settings.disable.role[message.guild.id] !== undefined &&
        ifUserHasRole(message.member, settings.disable.role[message.guild.id]);

    return isUserDisabled || isChannelDisabled || isRoleDisabled;
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

// ============================================================================
// Event Handlers
// ============================================================================

// Ready Event
client.on('ready', () => {
    console.log(`${client.user.tag} is ready!`);

    // Initialize console logger
    initializeConsoleLogger(client);

    // Set bot presence
    setInterval(() => {
        client.user.setPresence({
            status: 'online',
            activities: [{
                name: client.guilds.cache.size + 'servers | No special setup is required, just post the tweet link.',
                type: ActivityType.Watching
            }]
        });
    }, 60000);

    // Stats reporting interval
    setInterval(async () => {
        const stats = getStats();
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
                        value: stats.processed + 'messages'
                    },
                    {
                        name: '一時間に処理したメッセージ数',
                        value: stats.processed_hour + 'messages'
                    },
                    {
                        name: '一日に処理したメッセージ数',
                        value: stats.processed_day + 'messages'
                    }
                ]
            }]
        })

        if (new Date().getMinutes() === 0) {
            resetHourly();
        }
        if (new Date().getHours() === 0 && new Date().getMinutes() === 0) {
            resetDaily();
        }
    }, 60000);

    // Register slash commands
    client.application.commands.set([
        {
            name: 'help',
            name_localizations: convEnToEnUS(getLocaleObject('help')),
            description: 'Shows help message.',
            description_localizations: convEnToEnUS(getLocaleObject('helpCommandDescription'))
        },
        {
            name: 'ping',
            name_localizations: convEnToEnUS(getLocaleObject('ping')),
            description: 'Pong!',
            description_localizations: convEnToEnUS(getLocaleObject('pingCommandDescription'))
        },
        {
            name: 'invite',
            name_localizations: convEnToEnUS(getLocaleObject('invite')),
            description: 'Invite me to your server!',
            description_localizations: convEnToEnUS(getLocaleObject('inviteCommandDescription'))
        },
        {
            name: 'support',
            name_localizations: convEnToEnUS(getLocaleObject('support')),
            description: 'Join support server!',
            description_localizations: convEnToEnUS(getLocaleObject('supportCommandDescription'))
        },
        {
            name: 'settings',
            name_localizations: convEnToEnUS(getLocaleObject('settings')),
            description: 'chenge Settings',
            description_localizations: convEnToEnUS(getLocaleObject('settingsCommandDescription')),
            options: [
                {
                    name: 'disable',
                    name_localizations: convEnToEnUS(getLocaleObject('disable')),
                    description: 'disable',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsDisableDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            name_localizations: convEnToEnUS(getLocaleObject('user')),
                            description: 'user',
                            description_localizations: convEnToEnUS(getLocaleObject('settingsDisableUserDescription')),
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: 'channel',
                            name_localizations: convEnToEnUS(getLocaleObject('channel')),
                            description: 'channel',
                            description_localizations: convEnToEnUS(getLocaleObject('settingsDisableChannelDescription')),
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: 'role',
                            name_localizations: convEnToEnUS(getLocaleObject('role')),
                            description: 'role',
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: 'bannedwords',
                    name_localizations: convEnToEnUS(getLocaleObject('bannedwords')),
                    description: 'bannedWords',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsBannedWordsDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'word',
                            name_localizations: convEnToEnUS(getLocaleObject('word')),
                            description: 'word',
                            description_localizations: convEnToEnUS(getLocaleObject('settingsBannedWordsWordDescription')),
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'defaultlanguage',
                    name_localizations: convEnToEnUS(getLocaleObject('defaultlanguage')),
                    description: 'defaultLanguage',
                    description_localizations: convEnToEnUS(getLocaleObject('defaultLanguageDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'language',
                            name_localizations: convEnToEnUS(getLocaleObject('language')),
                            description: 'language',
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
                    name_localizations: convEnToEnUS(getLocaleObject('editoriginaliftranslate')),
                    description: 'editOriginalIfTranslate',
                    description_localizations: convEnToEnUS(getLocaleObject('editoriginaliftranslateDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'setdefaultmediaasattachments',
                    name_localizations: convEnToEnUS(getLocaleObject('setdefaultmediaasattachments')),
                    description: 'setSendMediaAsAttachmentsAsDefault',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsSendMediaAsAttachmentsAsDefaultDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'deleteifonlypostedtweetlink',
                    name_localizations: convEnToEnUS(getLocaleObject('deleteifonlypostedtweetlink')),
                    description: 'deleteIfOnlyPostedTweetLink',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsDeleteMessageIfOnlyPostedTweetLinkDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        },
                        {
                            name: 'secoundaryextractmode',
                            name_localizations: convEnToEnUS(getLocaleObject('secoundaryextractmode')),
                            description: 'doItWhenSecondaryExtractModeIsEnabled',
                            description_localizations: convEnToEnUS(getLocaleObject('settingsDoItWhenSecondaryExtractModeIsEnabledDescription')),
                            type: ApplicationCommandOptionType.Boolean,
                            required: false
                        }
                    ]
                },
                {
                    name: 'alwaysreplyifpostedtweetlink',
                    name_localizations: convEnToEnUS(getLocaleObject('alwaysreplyifpostedtweetlink')),
                    description: 'alwaysReplyIfPostedTweetLink',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsAlwaysReplyIfPostedTweetLinkDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'button',
                    name_localizations: convEnToEnUS(getLocaleObject('button')),
                    description: 'button',
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: 'invisible',
                            name_localizations: convEnToEnUS(getLocaleObject('invisible')),
                            description: 'invisible',
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: 'showmediaasattachments',
                                    name_localizations: convEnToEnUS(getLocaleObject('showmediaasattachments')),
                                    description: 'showMediaAsAttachments',
                                    description_localizations: convEnToEnUS(getLocaleObject('showMediaAsAttachments')),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'showattachmentsasembedsimage',
                                    name_localizations: convEnToEnUS(getLocaleObject('showattachmentsasembedsimage')),
                                    description: 'showAttachmentsAsEmbedsImage',
                                    description_localizations: convEnToEnUS(getLocaleObject('showAttachmentsAsEmbedsImage')),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'translate',
                                    name_localizations: convEnToEnUS(getLocaleObject('translate')),
                                    description: 'translate',
                                    description_localizations: convEnToEnUS(getLocaleObject('translateButton')),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'delete',
                                    name_localizations: convEnToEnUS(getLocaleObject('delete')),
                                    description: 'delete',
                                    description_localizations: convEnToEnUS(getLocaleObject('deleteButton')),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'savetweet',
                                    name_localizations: convEnToEnUS(getLocaleObject('saveTweetButton')),
                                    description: 'showSaveTweet',
                                    description_localizations: convEnToEnUS(getLocaleObject('showSaveTweetButton')),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'all',
                                    name_localizations: convEnToEnUS(getLocaleObject('all')),
                                    description: 'all',
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: 'disabled',
                            name_localizations: convEnToEnUS(getLocaleObject('disabled')),
                            description: 'disabled',
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: 'user',
                                    name_localizations: convEnToEnUS(getLocaleObject('user')),
                                    description: 'user',
                                    description_localizations: convEnToEnUS(getLocaleObject('settingsDisableUserDescription')),
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: 'channel',
                                    name_localizations: convEnToEnUS(getLocaleObject('channel')),
                                    description: 'channel',
                                    description_localizations: convEnToEnUS(getLocaleObject('settingsDisableChannelDescription')),
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: 'role',
                                    name_localizations: convEnToEnUS(getLocaleObject('role')),
                                    description: 'role',
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                },
                {
                    name: 'extractbotmessage',
                    name_localizations: convEnToEnUS(getLocaleObject('extractbotmessage')),
                    description: 'extractBotMessage',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsextractBotMessageDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'quoterepostdonotextract',
                    name_localizations: convEnToEnUS(getLocaleObject('quote_repost_do_not_extract')),
                    description: 'quote repost do not extract',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsQuoteRepostDoNotExtractDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'legacymode',
                    name_localizations: convEnToEnUS(getLocaleObject('legacy_mode')),
                    description: 'legacy mode',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsLegacyModeDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'secondaryextractmode',
                    name_localizations: convEnToEnUS(getLocaleObject('secondary_extract_mode')),
                    description: 'secondary extract mode',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsSecondaryExtractModeDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: convEnToEnUS(getLocaleObject('boolean')),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                }
            ]
        },
        {
            name: 'showsavetweet',
            name_localizations: convEnToEnUS(getLocaleObject('showsavedtweet')),
            description: 'Shows save tweet.',
            description_localizations: convEnToEnUS(getLocaleObject('showSaveTweetCommandDescription')),
            options: [
                {
                    name: 'id',
                    name_localizations: convEnToEnUS(getLocaleObject('id')),
                    description: 'string',
                    type: ApplicationCommandOptionType.String,
                    required: false
                }
            ]
        },
        {
            name: 'savetweetquotaoverride',
            name_localizations: convEnToEnUS(getLocaleObject('save_tweet_quota_override')),
            description: 'save tweet quota override',
            description_localizations: convEnToEnUS(getLocaleObject('settingsSaveTweetQuotaOverrideDescription')),
            options: [
                {
                    name: 'newquota',
                    name_localizations: convEnToEnUS(getLocaleObject('quota')),
                    description: 'new quota',
                    type: ApplicationCommandOptionType.Integer,
                    required: true
                },
                {
                    name: 'user',
                    name_localizations: convEnToEnUS(getLocaleObject('user')),
                    description: 'user',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsDisableUserDescription')),
                    type: ApplicationCommandOptionType.User,
                    required: false
                }
            ]
        },
        {
            name: 'deletesavetweet',
            name_localizations: convEnToEnUS(getLocaleObject('delete')),
            description: 'delete save tweet.',
            description_localizations: convEnToEnUS(getLocaleObject('settingsSaveTweetQuotaOverrideDescription')),
            options: [
                {
                    name: 'id',
                    name_localizations: convEnToEnUS(getLocaleObject('id')),
                    description: 'string',
                    type: ApplicationCommandOptionType.String,
                    required: true
                }
            ]
        },
        {
            name: 'quotastats',
            name_localizations: convEnToEnUS(getLocaleObject('quotastats')),
            description: 'quota stats',
            description_localizations: convEnToEnUS(getLocaleObject('settingsSaveTweetQuotaOverrideDescription')),
            options: [
                {
                    name: 'user',
                    name_localizations: convEnToEnUS(getLocaleObject('user')),
                    description: 'user',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsDisableUserDescription')),
                    type: ApplicationCommandOptionType.User,
                    required: false
                }
            ]
        },
        {
            name: 'checkmyguildsettings',
            name_localizations: convEnToEnUS(getLocaleObject('myguildsettings')),
            description: 'check my guild settings',
            description_localizations: convEnToEnUS(getLocaleObject('settingsSaveTweetQuotaOverrideDescription')),
            options: [
                {
                    name: 'guild',
                    name_localizations: convEnToEnUS(getLocaleObject('user')),
                    description: 'guild',
                    type: ApplicationCommandOptionType.String,
                    required: false
                }
            ]
        },
        {
            name: 'autoextract',
            name_localizations: convEnToEnUS(getLocaleObject('autoextract')),
            description: 'auto extract',
            description_localizations: convEnToEnUS(getLocaleObject('settingsAutoExtractDescription')),
            options: [
                {
                    name: 'list',
                    name_localizations: convEnToEnUS(getLocaleObject('autoextract_list')),
                    description: 'list',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsAutoExtractListDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                },
                {
                    name: 'add',
                    name_localizations: convEnToEnUS(getLocaleObject('autoextract_add')),
                    description: 'add',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsAutoExtractAddDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'username',
                            name_localizations: convEnToEnUS(getLocaleObject('autoextract_username')),
                            description: 'username',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        },
                        {
                            name: 'webhook',
                            name_localizations: convEnToEnUS(getLocaleObject('autoextract_webhook')),
                            description: 'webhook',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'delete',
                    name_localizations: convEnToEnUS(getLocaleObject('autoextract_delete')),
                    description: 'delete',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsAutoExtractDeleteDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'id',
                            name_localizations: convEnToEnUS(getLocaleObject('autoextract_id')),
                            description: 'id',
                            type: ApplicationCommandOptionType.Integer,
                            required: true
                        }
                    ]
                },
                {
                    name: 'additionalautoextractslot',
                    name_localizations: convEnToEnUS(getLocaleObject('additionalautoextractslot')),
                    description: 'ADMIN ONLY',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsAdditionalAutoExtractSlotDescription')),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            name_localizations: convEnToEnUS(getLocaleObject('user')),
                            description: 'user',
                            type: ApplicationCommandOptionType.User,
                            required: true
                        },
                        {
                            name: 'slot',
                            name_localizations: convEnToEnUS(getLocaleObject('slot')),
                            description: 'slot',
                            type: ApplicationCommandOptionType.Integer,
                            required: true
                        }
                    ]
                },
                {
                    name: 'checkfreeslot',
                    name_localizations: convEnToEnUS(getLocaleObject('checkfreeslot')),
                    description: 'check free slot',
                    description_localizations: convEnToEnUS(getLocaleObject('settingsAdditionalAutoExtractCheckFreeSlotDescription')),
                    type: ApplicationCommandOptionType.Subcommand
                }
            ]
        }
    ]);
});

// Crosspost Event (specific guild/channel)
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

// Main Message Processing Event
client.on(Events.MessageCreate, async (message) => {
    if (shouldIgnoreMessage(message)) return;

    const content = cleanMessageContent(message.content);
    const urls = extractTwitterUrls(content);

    if (urls.length === 0) return;
    if (isMessageDisabledForUserOrChannel(message)) return;

    for (const url of urls) {
        await sendTweetEmbed(message, url);
    }
});

// Slash Command Handler
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.ApplicationCommand) return;

    const locale = interaction.locale?.startsWith('en') ? 'en' : interaction.locale || 'en';

    if (interaction.commandName === 'ping') {
        await interaction.reply({
            embeds: [{
                title: 'Pong!',
                description: 'Ping: ' + client.ws.ping + 'ms',
                color: 0x1DA1F2
            }]
        });
    } else if (interaction.commandName === 'help') {
        await interaction.reply({
            embeds: [{
                title: t('helpTitle', locale),
                description: t('helpDescription', locale),
                color: 0x1DA1F2,
                fields: [{
                    name: 'Commands',
                    value: t('helpCommands', locale)
                }]
            }]
        });
    } else if (interaction.commandName === 'invite') {
        await interaction.reply({
            content: 'https://discord.com/api/oauth2/authorize?client_id=1059009376020582470&permissions=534723947584&scope=bot%20applications.commands'
        });
    } else if (interaction.commandName === 'support') {
        await interaction.reply({
            content: 'https://discord.gg/CQ5fTaFQK5'
        });
    } else if (interaction.commandName === 'settings') {
        const subcommand = interaction.options.getSubcommand();

        // Permission check for most settings
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
            subcommand !== 'disable') {
            return interaction.reply({
                content: t('userDonthavePermission', locale),
                ephemeral: true
            });
        }

        // Handle disable subcommand
        if (subcommand === 'disable') {
            const user = interaction.options.getUser('user');
            const channel = interaction.options.getChannel('channel');
            const role = interaction.options.getRole('role');

            // Count specified options
            const specifiedCount = [user, channel, role].filter(x => x !== null).length;

            if (specifiedCount === 0) {
                return interaction.reply({
                    content: t('userMustSpecifyAUserOrChannel', locale),
                    ephemeral: true
                });
            }

            if (specifiedCount > 1) {
                return interaction.reply({
                    content: t('userCantSpecifyBothAUserAndAChannel', locale),
                    ephemeral: true
                });
            }

            // Handle user disable
            if (user) {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
                    user.id !== interaction.user.id) {
                    return interaction.reply({
                        content: t('userCantUseThisCommandForOtherUsers', locale),
                        ephemeral: true
                    });
                }

                if (settings.disable.user.includes(user.id)) {
                    settings.disable.user = settings.disable.user.filter(id => id !== user.id);
                    saveSettings(settings);
                    return interaction.reply({
                        content: t('removedUserFromDisableUser', locale),
                        ephemeral: true
                    });
                } else {
                    settings.disable.user.push(user.id);
                    saveSettings(settings);
                    return interaction.reply({
                        content: t('addedUserToDisableUser', locale),
                        ephemeral: true
                    });
                }
            }

            // Handle channel disable
            if (channel) {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                    return interaction.reply({
                        content: t('userDonthavePermission', locale),
                        ephemeral: true
                    });
                }

                if (settings.disable.channel.includes(channel.id)) {
                    settings.disable.channel = settings.disable.channel.filter(id => id !== channel.id);
                    saveSettings(settings);
                    return interaction.reply({
                        content: t('removedChannelFromDisableChannel', locale),
                        ephemeral: true
                    });
                } else {
                    settings.disable.channel.push(channel.id);
                    saveSettings(settings);
                    return interaction.reply({
                        content: t('addedChannelToDisableChannel', locale),
                        ephemeral: true
                    });
                }
            }

            // Handle role disable
            if (role) {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                    return interaction.reply({
                        content: t('userDonthavePermission', locale),
                        ephemeral: true
                    });
                }

                if (!settings.disable.role[interaction.guildId]) {
                    settings.disable.role[interaction.guildId] = [];
                }

                if (settings.disable.role[interaction.guildId].includes(role.id)) {
                    settings.disable.role[interaction.guildId] = settings.disable.role[interaction.guildId].filter(id => id !== role.id);
                    saveSettings(settings);
                    return interaction.reply({
                        content: t('removedRoleFromDisableRole', locale),
                        ephemeral: true
                    });
                } else {
                    settings.disable.role[interaction.guildId].push(role.id);
                    saveSettings(settings);
                    return interaction.reply({
                        content: t('addedRoleToDisableRole', locale),
                        ephemeral: true
                    });
                }
            }
        }

        // Handle bannedwords subcommand
        if (subcommand === 'bannedwords') {
            const word = interaction.options.getString('word');

            if (!word) {
                return interaction.reply({
                    content: t('userMustSpecifyAnyWord', locale),
                    ephemeral: true
                });
            }

            if (!settings.bannedWords[interaction.guildId]) {
                settings.bannedWords[interaction.guildId] = [];
            }

            if (settings.bannedWords[interaction.guildId].includes(word)) {
                settings.bannedWords[interaction.guildId] = settings.bannedWords[interaction.guildId].filter(w => w !== word);
                saveSettings(settings);
                return interaction.reply({
                    content: t('removedWordFromBannedWords', locale),
                    ephemeral: true
                });
            } else {
                settings.bannedWords[interaction.guildId].push(word);
                saveSettings(settings);
                return interaction.reply({
                    content: t('addedWordToBannedWords', locale),
                    ephemeral: true
                });
            }
        }

        // Handle boolean settings
        const booleanSettings = {
            'defaultlanguage': { key: 'defaultLanguage', message: 'setdefaultlanguageto' },
            'editoriginaliftranslate': { key: 'editOriginalIfTranslate', message: 'seteditoriginaliftranslateto' },
            'setdefaultmediaasattachments': { key: 'sendMediaAsAttachmentsAsDefault', message: 'setdefaultmediaasattachmentsto' },
            'deleteifonlypostedtweetlink': { key: 'deletemessageifonlypostedtweetlink', message: 'setdeleteifonlypostedtweetlinkto' },
            'alwaysreplyifpostedtweetlink': { key: 'alwaysreplyifpostedtweetlink', message: 'setalwaysreplyifpostedtweetlinkto' },
            'extractbotmessage': { key: 'extract_bot_message', message: 'setextractbotmessageto' },
            'quote_repost_do_not_extract': { key: 'quote_repost_do_not_extract', message: 'setquoterepostdonotextractto' },
            'legacy_mode': { key: 'legacy_mode', message: 'setlegacymodeto' },
            'passive_mode': { key: 'passive_mode', message: 'setpassivemodeto' },
            'secondary_extract_mode': { key: 'secondary_extract_mode', message: 'setsecondaryextractmodeto' }
        };

        if (subcommand === 'defaultlanguage') {
            const language = interaction.options.getString('language');
            settings.defaultLanguage[interaction.guildId] = language;
            saveSettings(settings);
            return interaction.reply({
                content: t('setdefaultlanguageto', locale) + language,
                ephemeral: true
            });
        }

        if (booleanSettings[subcommand]) {
            const value = interaction.options.getBoolean('boolean');
            const setting = booleanSettings[subcommand];
            settings[setting.key][interaction.guildId] = value;
            saveSettings(settings);
            return interaction.reply({
                content: t(setting.message, locale) + convertBoolToEnableDisable(value, locale),
                ephemeral: true
            });
        }
    }
});

// Button Interaction Handler
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.MessageComponent || interaction.type === InteractionType.ApplicationCommand) return;

    await interaction.deferReply({ ephemeral: true });

    const locale = interaction.locale?.startsWith('en') ? 'en' : interaction.locale || 'en';

    // Check button permissions
    if (settings.button_disabled[interaction.guildId] !== undefined) {
        if (settings.button_disabled[interaction.guildId].user.includes(interaction.user.id)) {
            await interaction.editReply({
                content: t('userDonthavePermission', locale),
                ephemeral: true
            });
            setTimeout(() => interaction.deleteReply(), 3000);
            return;
        }
        if (settings.button_disabled[interaction.guildId].channel.includes(interaction.channel.id)) {
            await interaction.editReply({
                content: t('userDonthavePermission', locale),
                ephemeral: true
            });
            setTimeout(() => interaction.deleteReply(), 3000);
            return;
        }
        let role = false;
        settings.button_disabled[interaction.guildId].role.forEach(element => {
            if (ifUserHasRole(interaction.member, element)) {
                role = true;
            }
        });
        if (role) {
            await interaction.editReply({
                content: t('userDonthavePermission', locale),
                ephemeral: true
            });
            setTimeout(() => interaction.deleteReply(), 3000);
            return;
        }
    }

    const deleteButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setLabel('Delete')
        .setCustomId('delete');
    const translateButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel('Translate')
        .setCustomId('translate');
    const showAttachmentsAsMediaButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel(t('showAttachmentsAsEmbedsImage', locale))
        .setCustomId('showAttachmentsAsEmbedsImage');
    const showMediaAsAttachmentsButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel(t('showMediaAsAttachments', locale))
        .setCustomId('showMediaAsAttachments');

    switch (interaction.customId) {
        case 'showMediaAsAttachments':
            const messageObject = {};
            messageObject.components = [{
                type: ComponentType.ActionRow,
                components: [showAttachmentsAsMediaButton]
            }];
            messageObject.components.push({
                type: ComponentType.ActionRow,
                components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton]
            });
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
            await interaction.editReply({
                content: t('finishAction', locale),
                ephemeral: true
            });
            setTimeout(() => interaction.deleteReply(), 3000);
            break;

        case 'showAttachmentsAsEmbedsImage':
            const messageObject2 = {};
            if (interaction.message.attachments === undefined || interaction.message.attachments === null) {
                return interaction.reply('There are no attachments to show.');
            }

            const attachments = interaction.message.attachments.map(attachment => attachment.url);
            if (attachments.length > 4) {
                return interaction.reply('You can\'t show more than 4 attachments as embeds image.');
            }

            messageObject2.components = [{
                type: ComponentType.ActionRow,
                components: [showMediaAsAttachmentsButton]
            }];
            messageObject2.components.push({
                type: ComponentType.ActionRow,
                components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton]
            });
            messageObject2.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject2.components, interaction.guildId);
            messageObject2.embeds = [];

            attachments.forEach(element => {
                const extension = element.split("?").pop().split('.').pop();
                if (videoExtensions.includes(extension)) {
                    if (!messageObject2.files) messageObject2.files = [];
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
                    embed.image = { url: element };
                    messageObject2.embeds.push(embed);
                    return
                }
                messageObject2.embeds.push({
                    url: messageObject2.embeds[0].url,
                    image: { url: element }
                });
            });

            messageObject2.files = [];
            await interaction.message.edit(messageObject2);
            await interaction.editReply({
                content: t('finishAction', locale),
                ephemeral: true
            });
            setTimeout(() => interaction.deleteReply(), 3000);
            break;

        case 'delete':
            if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
                await interaction.message.delete();
                await interaction.editReply({
                    content: t('finishAction', locale),
                    ephemeral: true
                });
                setTimeout(() => interaction.deleteReply(), 3000);
            } else {
                if (interaction.message.embeds[0].author.name.split(":")[1].split(")")[0] != interaction.user.id) {
                    await interaction.editReply({
                        content: t('youcantdeleteotherusersmessages', locale),
                        ephemeral: true
                    });
                    setTimeout(() => interaction.deleteReply(), 3000);
                    return;
                }
                await interaction.message.delete();
                await interaction.editReply({
                    content: t('finishAction', locale),
                    ephemeral: true
                });
                setTimeout(() => interaction.deleteReply(), 3000);
            }
            break;

        case 'translate':
            const originalDescription = interaction.message.embeds[0].description;
            if (!originalDescription) {
                await interaction.editReply({
                    content: 'No text to translate.',
                    ephemeral: true
                });
                setTimeout(() => interaction.deleteReply(), 3000);
                return;
            }

            // Extract tweet text from description
            const tweetText = originalDescription.split('\n\n[View on Twitter]')[0];
            const statsText = originalDescription.split('\n\n').pop();

            // Translate using DeepL API
            const targetLang = locale === 'ja' ? 'JA' : 'EN';

            try {
                const response = await fetch(`https://api-free.deepl.com/v2/translate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: `auth_key=YOUR_DEEPL_API_KEY&text=${encodeURIComponent(tweetText)}&target_lang=${targetLang}`
                });

                const data = await response.json();
                const translatedText = data.translations[0].text;

                const messageObject3 = {};
                messageObject3.components = interaction.message.components;
                messageObject3.embeds = [];

                const copyEmbedObject = {};
                copyEmbedObject.title = interaction.message.embeds[0].title;
                copyEmbedObject.url = interaction.message.embeds[0].url;
                copyEmbedObject.description = translatedText + '\n\n[View on Twitter](' + copyEmbedObject.url + ')\n\n' + statsText;
                copyEmbedObject.color = interaction.message.embeds[0].color;
                copyEmbedObject.author = interaction.message.embeds[0].author;
                copyEmbedObject.footer = interaction.message.embeds[0].footer;
                copyEmbedObject.timestamp = interaction.message.embeds[0].timestamp;
                copyEmbedObject.fields = interaction.message.embeds[0].fields;
                if (interaction.message.embeds[0].image) copyEmbedObject.image = interaction.message.embeds[0].image;
                if (interaction.message.embeds[0].thumbnail) copyEmbedObject.thumbnail = interaction.message.embeds[0].thumbnail;

                messageObject3.embeds.push(copyEmbedObject);

                if (interaction.message.embeds.length > 1) {
                    for (let i = 1; i < interaction.message.embeds.length; i++) {
                        messageObject3.embeds.push(interaction.message.embeds[i]);
                    }
                }

                if (settings.editOriginalIfTranslate[interaction.guildId] === true) {
                    await interaction.message.edit(messageObject3);
                    await interaction.editReply({
                        content: t('finishAction', locale),
                        ephemeral: true
                    });
                } else {
                    await interaction.message.reply(messageObject3);
                    await interaction.editReply({
                        content: t('finishAction', locale),
                        ephemeral: true
                    });
                }
                setTimeout(() => interaction.deleteReply(), 3000);
            } catch (err) {
                console.error('Translation error:', err);
                await interaction.editReply({
                    content: 'Translation failed.',
                    ephemeral: true
                });
                setTimeout(() => interaction.deleteReply(), 3000);
            }
            break;

        case 'savetweet':
            // Save tweet functionality - implement as needed
            await interaction.editReply({
                content: 'Save tweet functionality not yet implemented.',
                ephemeral: true
            });
            setTimeout(() => interaction.deleteReply(), 3000);
            break;
    }
});

// ============================================================================
// Global Error Handlers
// ============================================================================

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Application specific logging, throwing an error, or other logic here
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Exit gracefully
    process.exit(1);
});

// ============================================================================
// Configuration Loading with Validation
// ============================================================================

function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');

    if (!fs.existsSync(configPath)) {
        console.error('❌ CRITICAL: config.json not found!');
        console.error('Please create config.json with the following structure:');
        console.error(JSON.stringify({
            token: 'YOUR_DISCORD_BOT_TOKEN',
            URL: 'YOUR_WEBHOOK_URL'
        }, null, 2));
        console.error('\nOr use environment variables:');
        console.error('DISCORD_TOKEN=your_token');
        console.error('WEBHOOK_URL=your_webhook');

        // Fallback to environment variables
        const token = process.env.DISCORD_TOKEN;
        const URL = process.env.WEBHOOK_URL;

        if (!token) {
            throw new Error('Discord token not configured. Set DISCORD_TOKEN env variable or create config.json');
        }

        return { token, URL };
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        if (!config.token) {
            throw new Error('Discord token not found in config.json');
        }

        return config;
    } catch (error) {
        console.error('Error loading config.json:', error.message);
        throw error;
    }
}

// ============================================================================
// Bot Login
// ============================================================================

const config = loadConfig();
client.login(config.token).catch(error => {
    console.error('Failed to login to Discord:', error.message);
    process.exit(1);
});
