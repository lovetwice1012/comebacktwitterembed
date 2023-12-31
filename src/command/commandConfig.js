const { ApplicationCommandOptionType } = require('discord.js');
const locales = require('../resxParser');
const commands = [
        {
            name: locales.Help["en-US"],
            name_localizations: locales.Help,
            description: locales.Help["en-US"],
            description_localizations: locales.show_helpMessage
        },
        {
            name: locales.Ping["en-US"],
            name_localizations: locales.Ping,
            description: 'Pong!',
        },
        {
            name: locales.Invite["en-US"],
            name_localizations: locales.Invite,
            description: locales.Invite["en-US"],
            description_localizations: locales.BOT_Invite_Link,
        
        },
        {
            name: locales.Support["en-US"],
            name_localizations: locales.Support,
            description: locales.supportServer_Invite_Link["en-US"],
            description_localizations: locales.supportServer_Invite_Link
        
        },
        {
            name: locales.Settings["en-US"],
            name_localizations: locales.Settings,
            description: locales.settings_change["en-US"],
            description_localizations: locales.settings_change,
            options: [
                {
                    name: locales.Disable["en-US"],
                    name_localizations: locales.Disable,
                    description: locales.settings_Disable_ch_user["en-US"],
                    description_localizations: locales.settings_Disable_ch_user,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.User["en-US"],
                            name_localizations: locales.User,
                            description: locales.settings_Disable_user["en-US"],
                            description_localizations: locales.settings_Disable_user,
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: locales.Channel["en-US"],
                            name_localizations: locales.Channel,
                            description: locales.settings_Disable_ch["en-US"],
                            description_localizations: locales.settings_Disable_ch,
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: locales.command_name_role_Locales["en-US"],
                            name_localizations: locales.command_name_role_Locales,
                            description: 'role'["en-US"],
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: locales.BanWard["en-US"],
                    name_localizations: locales.BanWard,
                    description: locales.settings_Add_remove_BANWords["en-US"],
                    description_localizations: locales.settings_Add_remove_BANWords,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Word["en-US"],
                            name_localizations: locales.Word,
                            description: locales.settings_Add_remove_BANWords["en-US"],
                            description_localizations: locales.settings_Add_remove_BANWords,
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.DefaultLanguage["en-US"],
                    name_localizations: locales.DefaultLanguage,
                    description: locales.settings_translating_defaultLanguage["en-US"],
                    description_localizations: locales.settings_translating_defaultLanguage,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Language["en-US"],
                            name_localizations: locales.Language,
                            description: locales.Language["en-US"],
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
                    name: locales.message_translate_originalMessageEdit["en-US"],
                    name_localizations: locales.message_translate_originalMessageEdit,
                    description: locales.settings_translating_messageEdit_option["en-US"],
                    description_localizations: locales.settings_translating_messageEdit_option,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Boolean["en-US"],
                            name_localizations: locales.Boolean,
                            description: locales.Boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.show_media["en-US"],
                    name_localizations: locales.show_media,
                    description: locales.settings_show_media["en-US"],
                    description_localizations: locales.settings_show_media,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Boolean["en-US"],
                            name_localizations: locales.Boolean,
                            description: locales.Boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.only_tweetLink_to_DeleteMessage["en-US"],
                    name_localizations: locales.only_tweetLink_to_DeleteMessage,
                    description: locales.settings_send_OnlyTwitterLink_Delete["en-US"],
                    description_localizations: locales.settings_send_OnlyTwitterLink_Delete,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Boolean["en-US"],
                            name_localizations: locales.Boolean,
                            description: locales.Boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.send_to_tweetLink_always_reply["en-US"],
                    name_localizations: locales.send_to_tweetLink_always_reply,
                    description: locales.settings_tweetLink_allow_reply["en-US"],
                    description_localizations: locales.settings_tweetLink_allow_reply,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Boolean["en-US"],
                            name_localizations: locales.Boolean,
                            description: locales.Boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.Button["en-US"],
                    name_localizations: locales.Button,
                    description: locales.Button["en-US"],
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: locales.Invisible["en-US"],
                            name_localizations: locales.Invisible,
                            description: locales.Invisible["en-US"],
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: locales.show_media["en-US"],
                                    name_localizations: locales.show_media,
                                    description: locales.show_mediaFiles["en-US"],
                                    description_localizations: locales.show_mediaFiles,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.show_Embed_img["en-US"],
                                    name_localizations: locales.show_Embed_img,
                                    description: locales.show_Embed_img["en-US"],
                                    description_localizations: locales.show_Embed_img,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.Translate["en-US"],
                                    name_localizations: locales.Translate,
                                    description: locales.Translate["en-US"],
                                    description_localizations: locales.Translate,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.Delete["en-US"],
                                    name_localizations: locales.Delete,
                                    description: locales.Delete["en-US"],
                                    description_localizations: locales.Delete,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.All["en-US"],
                                    name_localizations: locales.All,
                                    description: locales.All["en-US"],
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: locales.Disable["en-US"],
                            name_localizations: locales.Disable,
                            description: locales.Disable["en-US"],
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: locales.User["en-US"],
                                    name_localizations: locales.User,
                                    description: locales.settings_Disable_user["en-US"],
                                    description_localizations: locales.settings_Disable_user,
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: locales.Channel["en-US"],
                                    name_localizations: locales.Channel,
                                    description: locales.settings_Disable_ch["en-US"],
                                    description_localizations: locales.settings_Disable_ch,
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: locales.Role["en-US"],
                                    name_localizations: locales.Role,
                                    description: locales.Role["en-US"],
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                },
                {
                    name: locales.open_BOT_message["en-US"],
                    name_localizations: locales.open_BOT_message,
                    description: locales.settings_BOT_message_open["en-US"],
                    description_localizations: locales.settings_BOT_message_open,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Boolean["en-US"],
                            name_localizations: locales.Boolean,
                            description: locales.Boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.settings_QuoteDoNot_Extract["en-US"],
                    name_localizations: locales.settings_QuoteDoNot_Extract,
                    description: locales.settings_QuoteDoNot_Extract_name["en-US"],
                    description_localizations: locales.settings_QuoteDoNot_Extract_name,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.Boolean["en-US"],
                            name_localizations: locales.Boolean,
                            description: locales.Boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                }
            ]
        }
];

module.exports = commands;