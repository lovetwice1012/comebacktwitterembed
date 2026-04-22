'use strict';

const { ApplicationCommandOptionType } = require('discord.js');
const { t, commandNameLocales, descriptionLocales, messageLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');

const HANDLERS = {
    "disable": require('./settings/disable'),
    "bannedwords": require('./settings/bannedwords'),
    "defaultlanguage": require('./settings/defaultlanguage'),
    "editoriginaliftranslate": require('./settings/editoriginaliftranslate'),
    "setdefaultmediaasattachments": require('./settings/setdefaultmediaasattachments'),
    "deleteifonlypostedtweetlink": require('./settings/deleteifonlypostedtweetlink'),
    "alwaysreplyifpostedtweetlink": require('./settings/alwaysreplyifpostedtweetlink'),
    "anonymousexpand": require('./settings/anonymousexpand'),
    "extractbotmessage": require('./settings/extractbotmessage'),
    "quoterepostdonotextract": require('./settings/quoterepostdonotextract'),
    "quoterepostmaxdepth": require('./settings/quoterepostmaxdepth'),
    "legacymode": require('./settings/legacymode'),
    "passivemode": require('./settings/passivemode'),
    "secondaryextractmode": require('./settings/secondaryextractmode'),
    "secondaryextracttarget": require('./settings/secondaryextracttarget'),
    "button:invisible": require('./settings/button_invisible'),
    "button:disabled": require('./settings/button_disabled'),
};

module.exports.execute = async function (interaction, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const key = group ? `${group}:${sub}` : sub;
    const handler = HANDLERS[key];
    if (handler) return await handler(interaction, client);
    return await interaction.reply(t('userMustSpecifyAnyWordLocales', interaction.locale));
};


module.exports.definition = {
        name: 'settings',
        name_localizations: conv_en_to_en_US(commandNameLocales.settings),
        description: 'chenge Settings',
        description_localizations: conv_en_to_en_US(descriptionLocales.settingscommand),
        options: [
            {
                name: 'disable',
                name_localizations: conv_en_to_en_US(commandNameLocales.disable),
                description: 'disable',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisable),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'user',
                        name_localizations: conv_en_to_en_US(commandNameLocales.user),
                        description: 'user',
                        description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableUser),
                        type: ApplicationCommandOptionType.User,
                        required: false
                    },
                    {
                        name: 'channel',
                        name_localizations: conv_en_to_en_US(commandNameLocales.channel),
                        description: 'channel',
                        description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableChannel),
                        type: ApplicationCommandOptionType.Channel,
                        required: false
                    },
                    {
                        name: 'role',
                        name_localizations: conv_en_to_en_US(commandNameLocales.role),
                        description: 'role',
                        type: ApplicationCommandOptionType.Role,
                        required: false
                    }
                ]
            },
            {
                name: 'bannedwords',
                name_localizations: conv_en_to_en_US(commandNameLocales.bannedwords),
                description: 'bannedWords',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsBannedWords),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'word',
                        name_localizations: conv_en_to_en_US(commandNameLocales.word),
                        description: 'word',
                        description_localizations: conv_en_to_en_US(descriptionLocales.settingsBannedWordsWord),
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }
                ]
            },
            {
                name: 'defaultlanguage',
                name_localizations: conv_en_to_en_US(commandNameLocales.defaultlanguage),
                description: 'defaultLanguage',
                description_localizations: conv_en_to_en_US(descriptionLocales.defaultLanguage),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'language',
                        name_localizations: conv_en_to_en_US(commandNameLocales.language),
                        description: 'language',
                        description_localizations: conv_en_to_en_US(descriptionLocales.defaultLanguageLanguage),
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
                name_localizations: conv_en_to_en_US(commandNameLocales.editoriginaliftranslate),
                description: 'editOriginalIfTranslate',
                description_localizations: conv_en_to_en_US(descriptionLocales.editoriginaliftranslate),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'setdefaultmediaasattachments',
                name_localizations: conv_en_to_en_US(commandNameLocales.setdefaultmediaasattachments),
                description: 'setSendMediaAsAttachmentsAsDefault',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsSendMediaAsAttachmentsAsDefault),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'deleteifonlypostedtweetlink',
                name_localizations: conv_en_to_en_US(commandNameLocales.deleteifonlypostedtweetlink),
                description: 'deleteIfOnlyPostedTweetLink',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsDeleteMessageIfOnlyPostedTweetLink),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    },
                    {
                        name: 'secoundaryextractmode',
                        name_localizations: conv_en_to_en_US(commandNameLocales.doitwhensecondaryextractmodeisenabled),
                        description: 'doItWhenSecondaryExtractModeIsEnabled',
                        description_localizations: conv_en_to_en_US(descriptionLocales.settingsDoItWhenSecondaryExtractModeIsEnabled),
                        type: ApplicationCommandOptionType.Boolean,
                        required: false
                    }
                ]
            },
            {
                name: 'alwaysreplyifpostedtweetlink',
                name_localizations: conv_en_to_en_US(commandNameLocales.alwaysreplyifpostedtweetlink),
                description: 'alwaysReplyIfPostedTweetLink',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAlwaysReplyIfPostedTweetLink),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'anonymousexpand',
                name_localizations: conv_en_to_en_US(commandNameLocales.anonymous_expand),
                description: 'anonymous expand',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsAnonymousExpand),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'button',
                name_localizations: conv_en_to_en_US(commandNameLocales.button),
                description: 'button',
                type: ApplicationCommandOptionType.SubcommandGroup,
                options: [
                    {
                        name: 'invisible',
                        name_localizations: conv_en_to_en_US(commandNameLocales.invisible),
                        description: 'invisible',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            {
                                name: 'showmediaasattachments',
                                name_localizations: conv_en_to_en_US(commandNameLocales.showmediaasattachments),
                                description: 'showMediaAsAttachments',
                                description_localizations: conv_en_to_en_US(messageLocales.showMediaAsAttachmentsButtonLocales),
                                type: ApplicationCommandOptionType.Boolean,
                            },
                            {
                                name: 'showattachmentsasembedsimage',
                                name_localizations: conv_en_to_en_US(commandNameLocales.showattachmentsasembedsimage),
                                description: 'showAttachmentsAsEmbedsImage',
                                description_localizations: conv_en_to_en_US(messageLocales.showAttachmentsAsEmbedsImagebuttonLocales),
                                type: ApplicationCommandOptionType.Boolean,
                            },
                            {
                                name: 'translate',
                                name_localizations: conv_en_to_en_US(commandNameLocales.translate),
                                description: 'translate',
                                description_localizations: conv_en_to_en_US(messageLocales.translateButtonLabelLocales),
                                type: ApplicationCommandOptionType.Boolean,
                            },
                            {
                                name: 'delete',
                                name_localizations: conv_en_to_en_US(commandNameLocales.delete),
                                description: 'delete',
                                description_localizations: conv_en_to_en_US(messageLocales.deleteButtonLabelLocales),
                                type: ApplicationCommandOptionType.Boolean,
                            },
                            {
                                name: 'savetweet',
                                name_localizations: conv_en_to_en_US(messageLocales.savetweetButtonLabelLocales),
                                description: 'showSaveTweet',
                                description_localizations: conv_en_to_en_US(messageLocales.showSaveTweetButtonLabelLocales),
                                type: ApplicationCommandOptionType.Boolean,
                            },
                            {
                                name: 'all',
                                name_localizations: conv_en_to_en_US(commandNameLocales.all),
                                description: 'all',
                                type: ApplicationCommandOptionType.Boolean,
                            }
                        ]
                    },
                    {
                        name: 'disabled',
                        name_localizations: conv_en_to_en_US(commandNameLocales.disabled),
                        description: 'disabled',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            {
                                name: 'user',
                                name_localizations: conv_en_to_en_US(commandNameLocales.user),
                                description: 'user',
                                description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableUser),
                                type: ApplicationCommandOptionType.User,
                                required: false
                            },
                            {
                                name: 'channel',
                                name_localizations: conv_en_to_en_US(commandNameLocales.channel),
                                description: 'channel',
                                description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableChannel),
                                type: ApplicationCommandOptionType.Channel,
                                required: false
                            },
                            {
                                name: 'role',
                                name_localizations: conv_en_to_en_US(commandNameLocales.role),
                                description: 'role',
                                type: ApplicationCommandOptionType.Role,
                                required: false
                            }
                        ]
                    }
                ]
            }, {
                name: 'extractbotmessage',
                name_localizations: conv_en_to_en_US(commandNameLocales.extractbotmessage),
                description: 'extractBotMessage',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsextractBotMessage),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'quoterepostdonotextract',
                name_localizations: conv_en_to_en_US(commandNameLocales.quote_repost_do_not_extract),
                description: 'quote repost do not extract',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsQuoteRepostDoNotExtract),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'quoterepostmaxdepth',
                name_localizations: conv_en_to_en_US(commandNameLocales.quote_repost_max_depth),
                description: 'quote repost max depth',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsQuoteRepostMaxDepth),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'depth',
                        name_localizations: conv_en_to_en_US({ ja: '深さ', en: 'depth' }),
                        description: 'max depth (0 for unlimited)',
                        description_localizations: conv_en_to_en_US({ ja: '最大深さ (0で無制限)', en: 'max depth (0 for unlimited)' }),
                        type: ApplicationCommandOptionType.Integer,
                        required: true,
                        min_value: 0,
                        max_value: 10
                    }
                ]
            },
            {
                name: 'legacymode',
                name_localizations: conv_en_to_en_US(commandNameLocales.legacy_mode),
                description: 'legacy mode',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsLegacyMode),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            /*
            {
                name: 'passivemode',
                name_localizations: conv_en_to_en_US(commandNameLocales.passive_mode),
                description: 'passive mode',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsPassiveMode),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            */
            {
                name: 'secondaryextractmode',
                name_localizations: conv_en_to_en_US(commandNameLocales.secondary_extract_mode),
                description: 'secondary extract mode',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsSecondaryExtractMode),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'boolean',
                        name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
                        description: 'boolean',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true
                    }
                ]
            },
            {
                name: 'secondaryextracttarget',
                name_localizations: conv_en_to_en_US(commandNameLocales.secondaryextracttarget),
                description: 'secondary extract target',
                description_localizations: conv_en_to_en_US(descriptionLocales.settingsSecondaryExtractTarget),
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'multipleimages',
                        name_localizations: conv_en_to_en_US(commandNameLocales.multipleimages),
                        description: 'multiple images',
                        type: ApplicationCommandOptionType.Boolean,
                        required: false
                    },
                    {
                        name: 'video',
                        name_localizations: conv_en_to_en_US(commandNameLocales.video),
                        description: 'video',
                        type: ApplicationCommandOptionType.Boolean,
                        required: false
                    }
                ]
            }
        ]
    };
