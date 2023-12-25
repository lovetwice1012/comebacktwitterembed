const { Client, Events, GatewayIntentBits, Partials, ActivityType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField} = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],shards:'auto' });

const locales = require('../resxParser');

client.on('ready', () => {
    console.log(`${client.user.tag} is ready!`);

    client.application.commands.set([
        {
            name: (locales.Help.en),
            name_localizations: {
                "ja": (locales.Help.ja)
            },
            description: (locales.Help.en),
            description_localizations: {
                "ja": (locales.show_helpMessage.ja)
            }
        },
        {
            name: (locales.Ping.en),
            name_localizations: {
                "ja": (locales.Ping.ja)
            },
            description: 'Pong!',
        },
        {
            name: (locales.Invite.en),
            name_localizations: {
                "ja": locales.Invite.ja
            },
            description: (locales.Invite.en),
            description_localizations: {
                "ja": locales.BOT_Invite_Link.ja
            }
        },
        {
            name: (locales.Support.en),
            name_localizations: {
                "ja": locales.Support.ja
            },
            description: (locales.supportServer_Invite_Link.en),
            description_localizations: {
                "ja": locales.supportServer_Invite_Link.ja
            }
        },
        {
            name: (locales.Settings.en),
            name_localizations: {
                "ja": locales.Settings.ja
            },
            description: (locales.settings_change.en),
            description_localizations: {
                "ja": locales.settings_change.ja
            },
            options: [
                {
                    name: (locales.Disable.en),
                    name_localizations: {
                        "ja": locales.Disable.ja
                    },
                    description: (locales.settings_Disable_ch_user.en),
                    description_localizations: {
                        "ja": locales.settings_Disable_ch_user.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.User.en),
                            name_localizations: {
                                "ja": locales.User.ja
                            },
                            description: (locales.settings_Disable_user.en),
                            description_localizations: {
                                "ja": locales.settings_Disable_user.ja
                            },
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: (locales.Channel.en),
                            name_localizations: {
                                "ja": locales.Channel.ja
                            },
                            description: (locales.settings_Disable_ch.en),
                            description_localizations: {
                                "ja": locales.settings_Disable_ch.ja
                            },
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: (locales.command_name_role_Locales.en),
                            name_localizations: {
                                "ja": locales.command_name_role_Locales.ja
                            },
                            description: 'role',
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: (locales.BanWard.en),
                    name_localizations: {
                        "ja": locales.BanWard.ja
                    },
                    description: (locales.settings_Add_remove_BANWords.en),
                    description_localizations: {
                        "ja": locales.settings_Add_remove_BANWords.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Word.en),
                            name_localizations: {
                                "ja": locales.Word.ja
                            },
                            description: (locales.settings_Add_remove_BANWords.en),
                            description_localizations: {
                                "ja": locales.settings_Add_remove_BANWords.ja
                            },
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.DefaultLanguage.en),
                    name_localizations: {
                        "ja": locales.DefaultLanguage.ja
                    },
                    description: (locales.settings_translating_defaultLanguage.en),
                    description_localizations: {
                        "ja": locales.settings_translating_defaultLanguage.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Language.en),
                            name_localizations: {
                                "ja": locales.Language.ja
                            },
                            description: (locales.Language.en),
                            description_localizations: {
                                "ja": locales.Language.ja
                            },
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
                    name: (locales.message_translate_originalMessageEdit.en),
                    name_localizations: {
                        "ja": locales.message_translate_originalMessageEdit.ja
                    },
                    description: (locales.settings_translating_messageEdit_option.en),
                    description_localizations: {
                        "ja": locales.settings_translating_messageEdit_option.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean.en),
                            name_localizations: {
                                "ja": locales.Boolean.ja
                            },
                            description: (locales.Boolean.en),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.show_media.en),
                    name_localizations: {
                        "ja": locales.show_media.ja
                    },
                    description: (locales.settings_show_media.en),
                    description_localizations: {
                        "ja": locales.settings_show_media.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean.en),
                            name_localizations: {
                                "ja": locales.Boolean.ja
                            },
                            description: (locales.Boolean.en),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.only_tweetLink_to_DeleteMessage.en),
                    name_localizations: {
                        "ja": locales.only_tweetLink_to_DeleteMessage.ja
                    },
                    description: (locales.settings_send_OnlyTwitterLink_Delete.en),
                    description_localizations: {
                        "ja": locales.settings_send_OnlyTwitterLink_Delete.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean.en),
                            name_localizations: {
                                "ja": locales.Boolean.ja
                            },
                            description: (locales.Boolean.en),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.send_to_tweetLink_always_reply.en),
                    name_localizations: {
                        "ja": locales.send_to_tweetLink_always_reply.ja
                    },
                    description: (locales.settings_tweetLink_allow_reply.en),
                    description_localizations: {
                        "ja": locales.settings_tweetLink_allow_reply.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean.en),
                            name_localizations: {
                                "ja": locales.Boolean.ja
                            },
                            description: (locales.Boolean.en),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.Button.en),
                    name_localizations: {
                        "ja": locales.Button.ja
                    },
                    description: (locales.Button.en),
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: (locales.Invisible.en),
                            name_localizations: {
                                "ja": locales.Invisible.ja
                            },
                            description: (locales.Invisible.en),
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: (locales.show_media.en),
                                    name_localizations: {
                                        "ja": locales.show_media.ja
                                    },
                                    description: (locales.show_mediaFiles.en),
                                    description_localizations: {
                                        "ja": locales.show_mediaFiles.ja
                                    },
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.show_Embed_img.en),
                                    name_localizations: {
                                        "ja": locales.show_Embed_img.ja
                                    },
                                    description: (locales.show_Embed_img.en),
                                    description_localizations: {
                                        "ja": locales.show_Embed_img.ja
                                    },
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.Translate.en),
                                    name_localizations: {
                                        "ja": locales.Translate.ja
                                    },
                                    description: (locales.Translate.en),
                                    description_localizations: {
                                        "ja": locales.Translate.ja
                                    },
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.Delete.en),
                                    name_localizations: {
                                        "ja": locales.Delete.ja
                                    },
                                    description: (locales.Delete.en),
                                    description_localizations: {
                                        "ja": locales.Delete.ja
                                    },
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.All.en),
                                    name_localizations: {
                                        "ja": locales.All.ja
                                    },
                                    description: (locales.All.en),
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: (locales.Disable.en),
                            name_localizations: {
                                "ja": locales.Disable.ja
                            },
                            description: (locales.Disable.en),
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: (locales.User.en),
                                    name_localizations: {
                                        "ja": locales.User.ja
                                    },
                                    description: (locales.settings_Disable_user.en),
                                    description_localizations: {
                                        "ja": locales.settings_Disable_user.ja
                                    },
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: (locales.Channel.en),
                                    name_localizations: {
                                        "ja": locales.Channel.ja
                                    },
                                    description: (locales.settings_Disable_ch.en),
                                    description_localizations: {
                                        "ja": locales.settings_Disable_ch.ja
                                    },
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: (locales.Role.en),
                                    name_localizations: {
                                        "ja": locales.Role.ja
                                    },
                                    description: (locales.Role.en),
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                },
                {
                    name: (locales.open_BOT_message.en),
                    name_localizations: {
                        "ja": locales.open_BOT_message.ja
                    },
                    description: (locales.settings_BOT_message_open.en),
                    description_localizations: {
                        "ja": locales.settings_BOT_message_open.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean.en),
                            name_localizations: {
                                "ja": locales.Boolean.ja
                            },
                            description: (locales.Boolean.en),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.settings_QuoteDoNot_Extract.en),
                    name_localizations: {
                        "ja": locales.settings_QuoteDoNot_Extract.ja
                    },
                    description: locales.settings_QuoteDoNot_Extract_name.en,
                    description_localizations: {
                        "ja": locales.settings_QuoteDoNot_Extract_name.ja
                    },
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean.en),
                            name_localizations: {
                                "ja": locales.Boolean.ja
                            },
                            description: (locales.Boolean.en),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                }
            ]
        }
    ]);
});