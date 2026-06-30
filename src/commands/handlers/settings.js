'use strict';

/**
 * /settings slash command、E
 *
 * すべての設定操作を次の形式に統一する:
 *   /settings <providername> <settingname> [ifneeded_subcommand] <value...>
 */

const { ApplicationCommandOptionType } = require('discord.js');
const { t, commandNameLocales, descriptionLocales, messageLocales } = require('../../locales');
const { conv_en_to_en_US } = require('../../utils');
const { saveSettings, settings } = require('../../settings');

const COMMON_HANDLERS = {
    disable:                 require('./settings/disable'),
    defaultlanguage:         require('./settings/defaultlanguage'),
    editoriginaliftranslate: require('./settings/editoriginaliftranslate'),
    extractbotmessage:       require('./settings/extractbotmessage'),
    button_invisible:        require('./settings/button_invisible'),
    button_disabled:         require('./settings/button_disabled'),
};

const PROVIDER_HANDLERS = {
    twitter: {
        bannedwords:                  require('../../providers/twitter/commands/settings/bannedwords'),
        setdefaultmediaasattachments: require('../../providers/twitter/commands/settings/setdefaultmediaasattachments'),
        deleteifonlypostedtweetlink:  require('../../providers/twitter/commands/settings/deleteifonlypostedtweetlink'),
        alwaysreplyifpostedtweetlink: require('../../providers/twitter/commands/settings/alwaysreplyifpostedtweetlink'),
        anonymousexpand:              require('../../providers/twitter/commands/settings/anonymousexpand'),
        quoterepostdonotextract:      require('../../providers/twitter/commands/settings/quoterepostdonotextract'),
        quoterepostmaxdepth:          require('../../providers/twitter/commands/settings/quoterepostmaxdepth'),
        legacymode:                   require('../../providers/twitter/commands/settings/legacymode'),
        passivemode:                  require('../../providers/twitter/commands/settings/passivemode'),
        secondaryextractmode:         require('../../providers/twitter/commands/settings/secondaryextractmode'),
        secondaryextracttarget:       require('../../providers/twitter/commands/settings/secondaryextracttarget'),
    },
    pixiv: {
        images_per_step: require('../../providers/pixiv/commands/settings/images_per_step'),
    },
};

async function runAndSave(handler, interaction, client) {
    const result = await handler(interaction, client);
    await saveSettings(settings);
    return result;
}

module.exports.execute = async function (interaction, client) {
    const provider = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!provider) {
        return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }

    const common = COMMON_HANDLERS[sub];
    if (common) return await runAndSave(common, interaction, client);

    const providerHandler = PROVIDER_HANDLERS[provider]?.[sub];
    if (providerHandler) return await runAndSave(providerHandler, interaction, client);

    return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
};

const boolOption = {
    name: 'boolean',
    name_localizations: conv_en_to_en_US(commandNameLocales.boolean),
    description: 'boolean',
    type: ApplicationCommandOptionType.Boolean,
    required: true,
};

function buildCommonOptions(includeSaveTweetOption) {
    const invisibleOptions = [
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
            name: 'all',
            name_localizations: conv_en_to_en_US(commandNameLocales.all),
            description: 'all',
            type: ApplicationCommandOptionType.Boolean,
        },
    ];

    if (includeSaveTweetOption) {
        invisibleOptions.splice(4, 0, {
            name: 'savetweet',
            name_localizations: conv_en_to_en_US(messageLocales.savetweetButtonLabelLocales),
            description: 'showSaveTweet',
            description_localizations: conv_en_to_en_US(messageLocales.showSaveTweetButtonLabelLocales),
            type: ApplicationCommandOptionType.Boolean,
        });
    }

    return [
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
                    required: false,
                },
                {
                    name: 'channel',
                    name_localizations: conv_en_to_en_US(commandNameLocales.channel),
                    description: 'channel',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableChannel),
                    type: ApplicationCommandOptionType.Channel,
                    required: false,
                },
                {
                    name: 'role',
                    name_localizations: conv_en_to_en_US(commandNameLocales.role),
                    description: 'role',
                    type: ApplicationCommandOptionType.Role,
                    required: false,
                },
            ],
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
                        { name: 'English', value: 'en' },
                        { name: 'Japanese', value: 'ja' },
                    ],
                },
            ],
        },
        {
            name: 'editoriginaliftranslate',
            name_localizations: conv_en_to_en_US(commandNameLocales.editoriginaliftranslate),
            description: 'editOriginalIfTranslate',
            description_localizations: conv_en_to_en_US(descriptionLocales.editoriginaliftranslate),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'extractbotmessage',
            name_localizations: conv_en_to_en_US(commandNameLocales.extractbotmessage),
            description: 'extractBotMessage',
            description_localizations: conv_en_to_en_US(descriptionLocales.settingsextractBotMessage),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'button_invisible',
            description: 'button invisible settings',
            type: ApplicationCommandOptionType.Subcommand,
            options: invisibleOptions,
        },
        {
            name: 'button_disabled',
            description: 'button disabled settings',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'user',
                    name_localizations: conv_en_to_en_US(commandNameLocales.user),
                    description: 'user',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableUser),
                    type: ApplicationCommandOptionType.User,
                    required: false,
                },
                {
                    name: 'channel',
                    name_localizations: conv_en_to_en_US(commandNameLocales.channel),
                    description: 'channel',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsDisableChannel),
                    type: ApplicationCommandOptionType.Channel,
                    required: false,
                },
                {
                    name: 'role',
                    name_localizations: conv_en_to_en_US(commandNameLocales.role),
                    description: 'role',
                    type: ApplicationCommandOptionType.Role,
                    required: false,
                },
            ],
        },
    ];
}

module.exports.definition = {
    name: 'settings',
    name_localizations: conv_en_to_en_US(commandNameLocales.settings),
    description: 'change settings',
    description_localizations: conv_en_to_en_US(descriptionLocales.settingscommand),
    options: [
        {
            name: 'twitter',
            description: 'twitter settings',
            type: ApplicationCommandOptionType.SubcommandGroup,
            options: [
                ...buildCommonOptions(true),
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
                            required: true,
                        },
                    ],
                },
                {
                    name: 'setdefaultmediaasattachments',
                    name_localizations: conv_en_to_en_US(commandNameLocales.setdefaultmediaasattachments),
                    description: 'setSendMediaAsAttachmentsAsDefault',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsSendMediaAsAttachmentsAsDefault),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
                },
                {
                    name: 'deleteifonlypostedtweetlink',
                    name_localizations: conv_en_to_en_US(commandNameLocales.deleteifonlypostedtweetlink),
                    description: 'deleteIfOnlyPostedTweetLink',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsDeleteMessageIfOnlyPostedTweetLink),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        boolOption,
                        {
                            name: 'secoundaryextractmode',
                            name_localizations: conv_en_to_en_US(commandNameLocales.doitwhensecondaryextractmodeisenabled),
                            description: 'doItWhenSecondaryExtractModeIsEnabled',
                            description_localizations: conv_en_to_en_US(descriptionLocales.settingsDoItWhenSecondaryExtractModeIsEnabled),
                            type: ApplicationCommandOptionType.Boolean,
                            required: false,
                        },
                    ],
                },
                {
                    name: 'alwaysreplyifpostedtweetlink',
                    name_localizations: conv_en_to_en_US(commandNameLocales.alwaysreplyifpostedtweetlink),
                    description: 'alwaysReplyIfPostedTweetLink',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsAlwaysReplyIfPostedTweetLink),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
                },
                {
                    name: 'anonymousexpand',
                    name_localizations: conv_en_to_en_US(commandNameLocales.anonymous_expand),
                    description: 'anonymous expand',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsAnonymousExpand),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
                },
                {
                    name: 'quoterepostdonotextract',
                    name_localizations: conv_en_to_en_US(commandNameLocales.quote_repost_do_not_extract),
                    description: 'quote repost do not extract',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsQuoteRepostDoNotExtract),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
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
                            name_localizations: conv_en_to_en_US({ en: 'depth' }),
                            description: 'max depth (0 for unlimited)',
                            description_localizations: conv_en_to_en_US({ en: 'max depth (0 for unlimited)' }),
                            type: ApplicationCommandOptionType.Integer,
                            required: true,
                            min_value: 0,
                            max_value: 10,
                        },
                    ],
                },
                {
                    name: 'legacymode',
                    name_localizations: conv_en_to_en_US(commandNameLocales.legacy_mode),
                    description: 'legacy mode',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsLegacyMode),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
                },
                {
                    name: 'passivemode',
                    name_localizations: conv_en_to_en_US(commandNameLocales.passive_mode),
                    description: 'passive mode',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsPassiveMode),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
                },
                {
                    name: 'secondaryextractmode',
                    name_localizations: conv_en_to_en_US(commandNameLocales.secondary_extract_mode),
                    description: 'secondary extract mode',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsSecondaryExtractMode),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [boolOption],
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
                            required: false,
                        },
                        {
                            name: 'video',
                            name_localizations: conv_en_to_en_US(commandNameLocales.video),
                            description: 'video',
                            type: ApplicationCommandOptionType.Boolean,
                            required: false,
                        },
                    ],
                },
            ],
        },
        {
            name: 'pixiv',
            name_localizations: conv_en_to_en_US(commandNameLocales.pixiv),
            description: 'pixiv settings',
            description_localizations: conv_en_to_en_US(descriptionLocales.settingsPixiv),
            type: ApplicationCommandOptionType.SubcommandGroup,
            options: [
                ...buildCommonOptions(false),
                {
                    name: 'images_per_step',
                    name_localizations: conv_en_to_en_US(commandNameLocales.images_per_step),
                    description: '4 or 10 images per step',
                    description_localizations: conv_en_to_en_US(descriptionLocales.settingsPixivImagesPerStep),
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'value',
                            name_localizations: conv_en_to_en_US(commandNameLocales.value),
                            description: '4 or 10 images per step',
                            description_localizations: conv_en_to_en_US(descriptionLocales.settingsPixivImagesPerStepValue),
                            type: ApplicationCommandOptionType.Integer,
                            required: true,
                            choices: [
                                { name: '4', value: 4 },
                                { name: '10', value: 10 },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};
