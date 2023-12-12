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
            name: (locales.en.Ping),
            name_localizations: conv_en_to_en_US(locales.ja.Ping),
            description: 'Pong!',
            description_localizations: conv_en_to_en_US('Pong!')
        },
        {
            name: (locales.en.Invite),
            name_localizations: conv_en_to_en_US(locales.ja.Invite),
            description: (locales.en.Invite),
            description_localizations: conv_en_to_en_US(locales.ja.BOT_Invite_Link)
        },
        {
            name: (locales.en.Support),
            name_localizations: conv_en_to_en_US(locales.ja.Support),
            description: (locales.en.supportServer_Invite_Link),
            description_localizations: conv_en_to_en_US(locales.ja.supportServer_Invite_Link)
        },
        {
            name: (locales.en.Settings),
            name_localizations: conv_en_to_en_US(locales.ja.Settings),
            description: (locales.en.settings_change),
            description_localizations: conv_en_to_en_US(locales.ja.settings_change),
            options: [
                {
                    name: (locales.en.Disable),
                    name_localizations: conv_en_to_en_US(locales.ja.Disable),
                    description: (locales.en.settings_Disable_ch_user),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_ch_user),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.User),
                            name_localizations: conv_en_to_en_US(locales.ja.User),
                            description: (locales.en.settings_Disable_user),
                            description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_user),
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: (locales.en.Channel),
                            name_localizations: conv_en_to_en_US(locales.ja.Channel),
                            description: (locales.en.settings_Disable_ch),
                            description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_ch),
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: (locales.en.command_name_role_Locales),
                            name_localizations: conv_en_to_en_US(locales.ja.command_name_role_Locales),
                            description: 'role',
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: (locales.en.BanWard),
                    name_localizations: conv_en_to_en_US(locales.ja.BanWard),
                    description: (locales.en.settings_Add_remove_BANWords),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_Add_remove_BANWords),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Word),
                            name_localizations: conv_en_to_en_US(locales.ja.Word),
                            description: (locales.en.settings_Add_remove_BANWords),
                            description_localizations: conv_en_to_en_US(locales.ja.settings_Add_remove_BANWords),
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.en.DefaultLanguage),
                    name_localizations: conv_en_to_en_US(locales.ja.DefaultLanguage),
                    description: (locales.en.settings_translating_defaultLanguage),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_translating_defaultLanguage),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Language),
                            name_localizations: conv_en_to_en_US(locales.ja.Language),
                            description: (locales.en.Language),
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
                    name: (locales.en.message_translate_originalMessageEdit),
                    name_localizations: conv_en_to_en_US(locales.ja.message_translate_originalMessageEdit),
                    description: (locales.en.settings_translating_messageEdit_option),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_translating_messageEdit_option),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Boolean),
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: (locales.en.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.en.show_media),
                    name_localizations: conv_en_to_en_US(locales.ja.show_media),
                    description: (locales.en.settings_show_media),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_show_media),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Boolean),
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: (locales.en.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.en.only_tweetLink_to_DeleteMessage),
                    name_localizations: conv_en_to_en_US(locales.ja.only_tweetLink_to_DeleteMessage),
                    description: (locales.en.settings_send_OnlyTwitterLink_Delete),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_send_OnlyTwitterLink_Delete),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Boolean),
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: (locales.en.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.en.send_to_tweetLink_always_reply),
                    name_localizations: conv_en_to_en_US(locales.ja.send_to_tweetLink_always_reply),
                    description: (locales.en.settings_tweetLink_allow_reply),
                    description_localizations: conv_en_to_en_US(locales.ja.settings_tweetLink_allow_reply),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Boolean),
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: (locales.en.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.en.Button),
                    name_localizations: conv_en_to_en_US(locales.ja.Button),
                    description: (locales.en.Button),
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: (locales.en.Invisible),
                            name_localizations: conv_en_to_en_US(locales.ja.Invisible),
                            description: (locales.en.Invisible),
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: (locales.en.show_media),
                                    name_localizations: conv_en_to_en_US(locales.ja.show_media),
                                    description: (locales.en.show_mediaFiles),
                                    description_localizations: conv_en_to_en_US(locales.ja.show_mediaFiles),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.en.show_Embed_img),
                                    name_localizations: conv_en_to_en_US(locales.ja.show_Embed_img),
                                    description: (locales.en.show_Embed_img),
                                    description_localizations: conv_en_to_en_US(locales.ja.show_Embed_img),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.en.Translate),
                                    name_localizations: conv_en_to_en_US(locales.ja.Translate),
                                    description: (locales.en.Translate),
                                    description_localizations: conv_en_to_en_US(locales.ja.Translate),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.en.Delete),
                                    name_localizations: conv_en_to_en_US(locales.ja.Delete),
                                    description: (locales.en.Delete),
                                    description_localizations: conv_en_to_en_US(locales.ja.Delete),
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.en.All),
                                    name_localizations: conv_en_to_en_US(locales.ja.All),
                                    description: (locales.en.All),
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: (locales.en.Disable),
                            name_localizations: conv_en_to_en_US(locales.ja.Disable),
                            description: (locales.en.Disable),
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: (locales.en.User),
                                    name_localizations: conv_en_to_en_US(locales.ja.User),
                                    description: (locales.en.settings_Disable_user),
                                    description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_user),
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: (locales.en.Channel),
                                    name_localizations: conv_en_to_en_US(locales.ja.Channel),
                                    description: (locales.en.settings_Disable_ch),
                                    description_localizations: conv_en_to_en_US(locales.ja.settings_Disable_ch),
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: (locales.en.Role),
                                    name_localizations: conv_en_to_en_US(locales.ja.Role),
                                    description: (locales.en.Role),
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                }, { //これ以下変更なし
                    name: 'extractbotmessage',
                    name_localizations: conv_en_to_en_US(locales.ja.open_BOT_message),
                    description: 'extractBotMessage',
                    description_localizations: conv_en_to_en_US(locales.ja.settings_BOT_message_open),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.en.Boolean),
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: (locales.en.Boolean),
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
                            name: (locales.en.Boolean),
                            name_localizations: conv_en_to_en_US(locales.ja.Boolean),
                            description: (locales.en.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                }
            ]
        }
    ]);
});