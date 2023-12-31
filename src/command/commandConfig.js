const { ApplicationCommandOptionType } = require('discord.js');
const locales = require('../resxParser');
const commands = [
        {
            name: locales.help["en-US"],
            name_localizations: locales.help,
            description: locales.help["en-US"],
            description_localizations: locales.show_helpMessage
        },
        {
            name: locales.ping["en-US"],
            name_localizations: locales.ping,
            description: 'Pong!',
        },
        {
            name: locales.invite["en-US"],
            name_localizations: locales.invite,
            description: locales.inviteMeToYourServer["en-US"],
            description_localizations: locales.inviteMeToYourServer,
        
        },
        {
            name: locales.support["en-US"],
            name_localizations: locales.support,
            description: locales.joinSupportServer["en-US"],
            description_localizations: locales.joinSupportServer
        
        },
        {
            name: locales.settings["en-US"],
            name_localizations: locales.settings,
            description: locales.changeSettings["en-US"],
            description_localizations: locales.changeSettings,
            options: [
                {
                    name: locales.disable["en-US"],
                    name_localizations: locales.disable,
                    description: locales.disableByUserOrChannel["en-US"],
                    description_localizations: locales.disableByUserOrChannel,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.user["en-US"],
                            name_localizations: locales.user,
                            description: locales.specifyTheUserToDisable["en-US"],
                            description_localizations: locales.specifyTheUserToDisable,
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: locales.channel["en-US"],
                            name_localizations: locales.channel,
                            description: locales.specifyTheChannelToDisable["en-US"],
                            description_localizations: locales.specifyTheChannelToDisable,
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        },
                        {
                            name: locales.role["en-US"],
                            name_localizations: locales.role,
                            description: 'role'["en-US"],
                            type: ApplicationCommandOptionType.Role,
                            required: false
                        }
                    ]
                },
                {
                    name: locales.banWord["en-US"],
                    name_localizations: locales.banWord,
                    description: locales.addOrRemoveBannedWords["en-US"],
                    description_localizations: locales.addOrRemoveBannedWords,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.word["en-US"],
                            name_localizations: locales.word,
                            description: locales.addOrRemoveBannedWords["en-US"],
                            description_localizations: locales.addOrRemoveBannedWords,
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.defaultLanguage["en-US"],
                    name_localizations: locales.defaultLanguage,
                    description: locales.setsTheDefaultLanguageWhenTranslating["en-US"],
                    description_localizations: locales.setsTheDefaultLanguageWhenTranslating,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.language["en-US"],
                            name_localizations: locales.language,
                            description: locales.language["en-US"],
                            description_localizations: locales.language,
                            type: ApplicationCommandOptionType.String,
                            required: true,
                            choices: [
                                {
                                    name: 'English',
                                    value: 'en-US'
                                },
                                {
                                    name: 'Japanese',
                                    value: 'ja'
                                },
                                {
                                    name: 'German',
                                    value: 'de'
                                },
                                {
                                    name: 'Spanish',
                                    value: 'es-ES'
                                },
                                {
                                    name: 'French',
                                    value: 'fr'
                                },
                                {
                                    name: 'Portuguese,Brazilian',
                                    value: 'pt-BR'
                                },
                                {
                                    name: 'Russian',
                                    value: 'ru'
                                },
                                {
                                    name: 'Chinese',
                                    value: 'zh-CN'
                                },
                            ]
                        }
                    ]
                },
                {
                    name: locales.editOriginalIfTranslate["en-US"],
                    name_localizations: locales.editOriginalIfTranslate,
                    description: locales.setsWhetherToEditTheOriginalMessageWhenTranslating["en-US"],
                    description_localizations: locales.setsWhetherToEditTheOriginalMessageWhenTranslating,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.boolean["en-US"],
                            name_localizations: locales.boolean,
                            description: locales.boolean["en-US"],
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
                            name: locales.boolean["en-US"],
                            name_localizations: locales.boolean,
                            description: locales.boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.deleteIfOnlyPostedTweetlink["en-US"],
                    name_localizations: locales.deleteIfOnlyPostedTweetlink,
                    description: locales.setsWhetherToDeleteTheMessageIfOnlyTheTweetLinkIsPosted["en-US"],
                    description_localizations: locales.setsWhetherToDeleteTheMessageIfOnlyTheTweetLinkIsPosted,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.boolean["en-US"],
                            name_localizations: locales.boolean,
                            description: locales.boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.alwaysReplyIfPostedTweetlink["en-US"],
                    name_localizations: locales.alwaysReplyIfPostedTweetlink,
                    description: locales.setsWhetherToAlwaysReplyIfTheTweetLinkIsPosted["en-US"],
                    description_localizations: locales.setsWhetherToAlwaysReplyIfTheTweetLinkIsPosted,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.boolean["en-US"],
                            name_localizations: locales.boolean,
                            description: locales.boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.button["en-US"],
                    name_localizations: locales.button,
                    description: locales.button["en-US"],
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    options: [
                        {
                            name: locales.invisible["en-US"],
                            name_localizations: locales.invisible,
                            description: locales.invisible["en-US"],
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: locales.showMediaAsAttachments["en-US"],
                                    name_localizations: locales.showMediaAsAttachments,
                                    description: locales.showMediaAsAttachments["en-US"],
                                    description_localizations: locales.showMediaAsAttachments,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.showMediaInEmbedsImage["en-US"],
                                    name_localizations: locales.showMediaInEmbedsImage,
                                    description: locales.showMediaInEmbedsImage["en-US"],
                                    description_localizations: locales.showMediaInEmbedsImage,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.translate["en-US"],
                                    name_localizations: locales.translate,
                                    description: locales.translate["en-US"],
                                    description_localizations: locales.translate,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.delete["en-US"],
                                    name_localizations: locales.delete,
                                    description: locales.delete["en-US"],
                                    description_localizations: locales.delete,
                                    type: ApplicationCommandOptionType.Boolean,
                                },
                                {
                                    name: locales.all["en-US"],
                                    name_localizations: locales.all,
                                    description: locales.all["en-US"],
                                    type: ApplicationCommandOptionType.Boolean,
                                }
                            ]
                        },
                        {
                            name: locales.disable["en-US"],
                            name_localizations: locales.disable,
                            description: locales.disable["en-US"],
                            type: ApplicationCommandOptionType.Subcommand,
                            options: [
                                {
                                    name: locales.user["en-US"],
                                    name_localizations: locales.user,
                                    description: locales.specifyTheUserToDisable["en-US"],
                                    description_localizations: locales.specifyTheUserToDisable,
                                    type: ApplicationCommandOptionType.User,
                                    required: false
                                },
                                {
                                    name: locales.channel["en-US"],
                                    name_localizations: locales.channel,
                                    description: locales.specifyTheChannelToDisable["en-US"],
                                    description_localizations: locales.specifyTheChannelToDisable,
                                    type: ApplicationCommandOptionType.Channel,
                                    required: false
                                },
                                {
                                    name: locales.role["en-US"],
                                    name_localizations: locales.role,
                                    description: locales.role["en-US"],
                                    type: ApplicationCommandOptionType.Role,
                                    required: false
                                }
                            ]
                        }
                    ]
                },
                {
                    name: locales.extractBotMessage["en-US"],
                    name_localizations: locales.extractBotMessage,
                    description: locales.setsWhetherToExtractBotMessages["en-US"],
                    description_localizations: locales.setsWhetherToExtractBotMessages,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.boolean["en-US"],
                            name_localizations: locales.boolean,
                            description: locales.boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                },
                {
                    name: locales.setsWhetherToExpandQuoteRetweets["en-US"],
                    name_localizations: locales.setsWhetherToExpandQuoteRetweets,
                    description: locales.doNotDeployQuoteRetweets["en-US"],
                    description_localizations: locales.doNotDeployQuoteRetweets,
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: locales.boolean["en-US"],
                            name_localizations: locales.boolean,
                            description: locales.boolean["en-US"],
                            type: ApplicationCommandOptionType.Boolean,
                            required: true
                        }
                    ]
                }
            ]
        }
];

module.exports = commands;