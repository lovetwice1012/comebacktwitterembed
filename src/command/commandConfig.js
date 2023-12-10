const { Client, Events, GatewayIntentBits, Partials, ActivityType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField} = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],shards:'auto' });

const locales = require('../resxParser');

/*
283行目 quoterepostdonotextract

コマンド / 説明共に翻訳文なし

*/

client.on('ready', () => {
    console.log(`${client.user.tag} is ready!`);

    client.application.commands.set([
        {
            name: (locales.en.Help),
            name_localizations: conv_en_to_en_US(locales.ja.Help),
            description: (locales.en.Help),
            description_localizations: conv_en_to_en_US(locales.ja.show_helpMessage)
        },
        {
            name: 'ping',
            name_localizations: conv_en_to_en_US(locales.ja.Ping),
            description: 'Pong!',
            description_localizations: conv_en_to_en_US('Pong!')
        },
        {
            name: 'invite',
            name_localizations: conv_en_to_en_US(locales.ja.Invite),
            description: 'Invite me to your server!',
            description_localizations: conv_en_to_en_US(locales.ja.BOT_Invite_Link)
        },
        {
            name: 'support',
            name_localizations: conv_en_to_en_US(locales.ja.Support),
            description: 'Join support server!',
            description_localizations: conv_en_to_en_US(locales.ja.supportServer_Invite_Link)
        },
        {
            name: 'settings',
            name_localizations: conv_en_to_en_US(locales.ja.Settings),
            description: 'chenge Settings',
            description_localizations: conv_en_to_en_US(locales.ja.settings_change),
            options: [
                {
                    name: 'disable',
                    name_localizations: conv_en_to_en_US(locales.ja.Disable),
                    description: 'disable',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_ch_user),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            name_localizations: conv_en_to_en_US(locales.ja.User),
                            description: 'user',
                            description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_user),
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: 'channel',
                            name_localizations: conv_en_to_en_US(locales.ja.Channel),
                            description: 'channel',
                            description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_ch),
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: 'role',
                            name_localizations: conv_en_to_en_US(locales.ja.command_name_role_Locales),
                            description: 'role',
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: 'bannedwords',
                    name_localizations: conv_en_to_en_US(locales.ja.BanWard),
                    description: 'bannedWords',
                    description_localizations: conv_en_to_en_US(settingsBannedWordsDescriptionLocalizations),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'word',
                            name_localizations: conv_en_to_en_US(command_name_word_Locales),
                            description: 'word',
                            description_localizations: conv_en_to_en_US(locales.ja.settings_Add_remove_BANWords),
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'defaultlanguage',
                    name_localizations: conv_en_to_en_US(locales.ja.DefaultLanguage),
                    description: 'defaultLanguage',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_translating_defaultLanguage),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'language',
                            name_localizations: conv_en_to_en_US(locales.ja.Language),
                            description: 'language',
                            description_localizations: conv_en_to_en_US(locales.ja.Language),
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
                    name_localizations: conv_en_to_en_US(locales.ja.message_translate_originalMessageEdit),
                    description: 'editOriginalIfTranslate',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_translating_messageEdit_option),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'setdefaultmediaasattachments',
                    name_localizations: conv_en_to_en_US(locales.ja.show_media),
                    description: 'setSendMediaAsAttachmentsAsDefault',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_show_media),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'deleteifonlypostedtweetlink',
                    name_localizations: conv_en_to_en_US(locales.ja.only_tweetLink_to_DeleteMessage),
                    description: 'deleteIfOnlyPostedTweetLink',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_send_OnlyTwitterLink_Delete),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'alwaysreplyifpostedtweetlink',
                    name_localizations: conv_en_to_en_US(locales.ja.send_to_tweetLink_always_reply),
                    description: 'alwaysReplyIfPostedTweetLink',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_tweetLink_allow_reply),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: 'boolean',
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: 'button',
                    name_localizations: conv_en_to_en_US(locales.ja.Button),
                    description: 'button',
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: 'invisible',
                            name_localizations: conv_en_to_en_US(locales.ja.Invisible),
                            description: 'invisible',
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: 'showmediaasattachments',
                                    name_localizations: conv_en_to_en_US(locales.ja.show_media),
                                    description: 'showMediaAsAttachments',
                                    description_localizations: conv_en_to_en_US(locales.ja.show_mediaFiles),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'showattachmentsasembedsimage',
                                    name_localizations: conv_en_to_en_US(locales.ja.show_Embed_img),
                                    description: 'showAttachmentsAsEmbedsImage',
                                    description_localizations: conv_en_to_en_US(locales.ja.show_Embed_img),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'translate',
                                    name_localizations: conv_en_to_en_US(locales.ja.Translate),
                                    description: 'translate',
                                    description_localizations: conv_en_to_en_US(locales.ja.Translate),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'delete',
                                    name_localizations: conv_en_to_en_US(locales.ja.Delete),
                                    description: 'delete',
                                    description_localizations: conv_en_to_en_US(locales.ja.Delete),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: 'all',
                                    name_localizations: conv_en_to_en_US(locales.ja.All),
                                    description: 'all',
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: 'disabled',
                            name_localizations: conv_en_to_en_US(locales.ja.Disable),
                            description: 'disabled',
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: 'user',
                                    name_localizations: conv_en_to_en_US(locales.ja.User),
                                    description: 'user',
                                    description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_user),
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: 'channel',
                                    name_localizations: conv_en_to_en_US(locales.ja.Channel),
                                    description: 'channel',
                                    description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_ch),
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: 'role',
                                    name_localizations: conv_en_to_en_US(locales.ja.Role),
                                    description: 'role',
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                }, {
                    name: 'extractbotmessage',
                    name_localizations: conv_en_to_en_US(locales.ja.open_BOT_message),
                    description: 'extractBotMessage',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_BOT_message_open),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'boolean',
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
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
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
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