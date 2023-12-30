const locales = require('../resxParser');
const commands = [
        {
            name: (locales.Help),
            name_localizations: (locales.Help),
            description: (locales.Help),
            description_localizations: (locales.show_helpMessage)
        },
        {
            name: (locales.Ping),
            name_localizations: (locales.Ping),
            description: 'Pong!',
        },
        {
            name: (locales.Invite),
            name_localizations: locales.Invite,
            description: (locales.Invite),
            description_localizations: locales.BOT_Invite_Link,
        
        },
        {
            name: (locales.Support),
            name_localizations: locales.Support,
            description: (locales.supportServer_Invite_Link),
            description_localizations: locales.supportServer_Invite_Link
        
        },
        {
            name: (locales.Settings),
            name_localizations: locales.Settings,
            description: (locales.settings_change),
            description_localizations: locales.settings_change,
            options: [
                {
                    name: (locales.Disable),
                    name_localizations: locales.Disable,
                    description: (locales.settings_Disable_ch_user),
                    description_localizations: locales.settings_Disable_ch_user,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.User),
                            name_localizations: locales.User,
                            description: (locales.settings_Disable_user),
                            description_localizations: locales.settings_Disable_user,
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: (locales.Channel),
                            name_localizations: locales.Channel,
                            description: (locales.settings_Disable_ch),
                            description_localizations: locales.settings_Disable_ch,
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: (locales.command_name_role_Locales),
                            name_localizations: locales.command_name_role_Locales,
                            description: 'role',
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: (locales.BanWard),
                    name_localizations: locales.BanWard,
                    description: (locales.settings_Add_remove_BANWords),
                    description_localizations: locales.settings_Add_remove_BANWords,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Word),
                            name_localizations: locales.Word,
                            description: (locales.settings_Add_remove_BANWords),
                            description_localizations: locales.settings_Add_remove_BANWords,
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.DefaultLanguage),
                    name_localizations: locales.DefaultLanguage,
                    description: (locales.settings_translating_defaultLanguage),
                    description_localizations: locales.settings_translating_defaultLanguage,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Language),
                            name_localizations: locales.Language,
                            description: (locales.Language),
                            description_localizations: locales.Language,
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
                    name: (locales.message_translate_originalMessageEdit),
                    name_localizations: locales.message_translate_originalMessageEdit,
                    description: (locales.settings_translating_messageEdit_option),
                    description_localizations: locales.settings_translating_messageEdit_option,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean),
                            name_localizations: locales.Boolean,
                            description: (locales.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.show_media),
                    name_localizations: locales.show_media,
                    description: (locales.settings_show_media),
                    description_localizations: locales.settings_show_media,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean),
                            name_localizations: locales.Boolean,
                            description: (locales.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.only_tweetLink_to_DeleteMessage),
                    name_localizations: locales.only_tweetLink_to_DeleteMessage,
                    description: (locales.settings_send_OnlyTwitterLink_Delete),
                    description_localizations: locales.settings_send_OnlyTwitterLink_Delete,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean),
                            name_localizations: locales.Boolean,
                            description: (locales.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.send_to_tweetLink_always_reply),
                    name_localizations: locales.send_to_tweetLink_always_reply,
                    description: (locales.settings_tweetLink_allow_reply),
                    description_localizations: locales.settings_tweetLink_allow_reply,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean),
                            name_localizations: locales.Boolean,
                            description: (locales.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.Button),
                    name_localizations: locales.Button,
                    description: (locales.Button),
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: (locales.Invisible),
                            name_localizations: locales.Invisible,
                            description: (locales.Invisible),
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: (locales.show_media),
                                    name_localizations: locales.show_media,
                                    description: (locales.show_mediaFiles),
                                    description_localizations: locales.show_mediaFiles,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.show_Embed_img),
                                    name_localizations: locales.show_Embed_img,
                                    description: (locales.show_Embed_img),
                                    description_localizations: locales.show_Embed_img,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.Translate),
                                    name_localizations: locales.Translate,
                                    description: (locales.Translate),
                                    description_localizations: locales.Translate,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.Delete),
                                    name_localizations: locales.Delete,
                                    description: (locales.Delete),
                                    description_localizations: locales.Delete,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: (locales.All),
                                    name_localizations: locales.All,
                                    description: (locales.All),
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: (locales.Disable),
                            name_localizations: locales.Disable,
                            description: (locales.Disable),
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: (locales.User),
                                    name_localizations: locales.User,
                                    description: (locales.settings_Disable_user),
                                    description_localizations: locales.settings_Disable_user,
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: (locales.Channel),
                                    name_localizations: locales.Channel,
                                    description: (locales.settings_Disable_ch),
                                    description_localizations: locales.settings_Disable_ch,
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: (locales.Role),
                                    name_localizations: locales.Role,
                                    description: (locales.Role),
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                },
                {
                    name: (locales.open_BOT_message),
                    name_localizations: locales.open_BOT_message,
                    description: (locales.settings_BOT_message_open),
                    description_localizations: locales.settings_BOT_message_open,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean),
                            name_localizations: locales.Boolean,
                            description: (locales.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: (locales.settings_QuoteDoNot_Extract),
                    name_localizations: locales.settings_QuoteDoNot_Extract,
                    description: locales.settings_QuoteDoNot_Extract_name,
                    description_localizations: locales.settings_QuoteDoNot_Extract_name,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: (locales.Boolean),
                            name_localizations: locales.Boolean,
                            description: (locales.Boolean),
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                }
            ]
        }
];

module.exports = commands;