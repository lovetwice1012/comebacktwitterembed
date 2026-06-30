'use strict';

/**
 * /settings slash command、E
 *
 * すべての設定操作を次の形式に統一する:
 *   /settings <providername> <settingname> [ifneeded_subcommand] <value...>
 */

const { ApplicationCommandOptionType } = require('discord.js');
const { t, commandNameLocales, descriptionLocales, messageLocales } = require('../../locales');
const { loadProviders } = require('../../providers/_loader');

const COMMON_HANDLERS = {
    disable:                 require('./settings/disable'),
    defaultlanguage:         require('./settings/defaultlanguage'),
    editoriginaliftranslate: require('./settings/editoriginaliftranslate'),
    extractbotmessage:       require('./settings/extractbotmessage'),
    button_invisible:        require('./settings/button_invisible'),
    button_disabled:         require('./settings/button_disabled'),
    bannedwords:                  require('../../providers/twitter/commands/settings/bannedwords'),
    setdefaultmediaasattachments: require('../../providers/twitter/commands/settings/setdefaultmediaasattachments'),
    deleteifonlypostedtweetlink:  require('../../providers/twitter/commands/settings/deleteifonlypostedtweetlink'),
    alwaysreplyifpostedtweetlink: require('../../providers/twitter/commands/settings/alwaysreplyifpostedtweetlink'),
    anonymousexpand:              require('../../providers/twitter/commands/settings/anonymousexpand'),
    legacymode:                   require('../../providers/twitter/commands/settings/legacymode'),
};

const PROVIDER_HANDLERS = {
    twitter: {
        quoterepostdonotextract:      require('../../providers/twitter/commands/settings/quoterepostdonotextract'),
        quoterepostmaxdepth:          require('../../providers/twitter/commands/settings/quoterepostmaxdepth'),
        passivemode:                  require('../../providers/twitter/commands/settings/passivemode'),
        secondaryextractmode:         require('../../providers/twitter/commands/settings/secondaryextractmode'),
        secondaryextracttarget:       require('../../providers/twitter/commands/settings/secondaryextracttarget'),
    },
    pixiv: {
        images_per_step: require('../../providers/pixiv/commands/settings/images_per_step'),
    },
};

const DEFAULT_PROVIDER_BY_SUBCOMMAND = {
    quoterepostdonotextract: 'twitter',
    quoterepostmaxdepth: 'twitter',
    passivemode: 'twitter',
    secondaryextractmode: 'twitter',
    secondaryextracttarget: 'twitter',
    images_per_step: 'pixiv',
};

async function runAndSave(handler, interaction, client) {
    return await handler(interaction, client);
}

module.exports.execute = async function (interaction, client) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);

    if (!sub) {
        return await require('./guisetting').execute(interaction, client);
    }

    const provider = group || interaction.options.getString('provider') || DEFAULT_PROVIDER_BY_SUBCOMMAND[sub] || 'twitter';

    if (!provider) {
        return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
    }

    const common = COMMON_HANDLERS[sub];
    if (common) return await runAndSave(common, interaction, client);

    const providerHandler = PROVIDER_HANDLERS[provider]?.[sub];
    if (providerHandler) return await runAndSave(providerHandler, interaction, client);

    return await interaction.editReply(t('userMustSpecifyAnyWordLocales', interaction.locale));
};

function jaOnly(localizedValues) {
    if (!localizedValues || localizedValues.ja === undefined) return undefined;
    return { ja: localizedValues.ja };
}

function omitLocalization(_localizedValues) {
    return undefined;
}

function cloneOption(option) {
    return {
        ...option,
        options: option.options?.map(cloneOption),
        choices: option.choices?.map(choice => ({ ...choice })),
    };
}

function buildProviderOption(_providers) {
    return {
        name: 'provider',
        description: 'provider',
        type: ApplicationCommandOptionType.String,
        required: false,
    };
}

function withProviderOption(option, providers) {
    const out = cloneOption(option);
    out.options = [
        ...(out.options || []),
        buildProviderOption(providers),
    ];
    return out;
}

const boolOption = {
    name: 'boolean',
    name_localizations: jaOnly(commandNameLocales.boolean),
    description: 'boolean',
    type: ApplicationCommandOptionType.Boolean,
    required: true,
};

function buildCommonOptions(includeSaveTweetOption) {
    const invisibleOptions = [
        {
            name: 'showmediaasattachments',
            name_localizations: jaOnly(commandNameLocales.showmediaasattachments),
            description: 'showMediaAsAttachments',
            description_localizations: omitLocalization(messageLocales.showMediaAsAttachmentsButtonLocales),
            type: ApplicationCommandOptionType.Boolean,
        },
        {
            name: 'showattachmentsasembedsimage',
            name_localizations: jaOnly(commandNameLocales.showattachmentsasembedsimage),
            description: 'showAttachmentsAsEmbedsImage',
            description_localizations: omitLocalization(messageLocales.showAttachmentsAsEmbedsImagebuttonLocales),
            type: ApplicationCommandOptionType.Boolean,
        },
        {
            name: 'translate',
            name_localizations: jaOnly(commandNameLocales.translate),
            description: 'translate',
            description_localizations: omitLocalization(messageLocales.translateButtonLabelLocales),
            type: ApplicationCommandOptionType.Boolean,
        },
        {
            name: 'delete',
            name_localizations: jaOnly(commandNameLocales.delete),
            description: 'delete',
            description_localizations: omitLocalization(messageLocales.deleteButtonLabelLocales),
            type: ApplicationCommandOptionType.Boolean,
        },
        {
            name: 'all',
            name_localizations: jaOnly(commandNameLocales.all),
            description: 'all',
            type: ApplicationCommandOptionType.Boolean,
        },
    ];

    if (includeSaveTweetOption) {
        invisibleOptions.splice(4, 0, {
            name: 'savetweet',
            name_localizations: jaOnly(commandNameLocales.savetweet),
            description: 'showSaveTweet',
            description_localizations: omitLocalization(messageLocales.showSaveTweetButtonLabelLocales),
            type: ApplicationCommandOptionType.Boolean,
        });
    }

    const options = [
        {
            name: 'disable',
            name_localizations: jaOnly(commandNameLocales.disable),
            description: 'disable',
            description_localizations: omitLocalization(descriptionLocales.settingsDisable),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'user',
                    name_localizations: jaOnly(commandNameLocales.user),
                    description: 'user',
                    description_localizations: omitLocalization(descriptionLocales.settingsDisableUser),
                    type: ApplicationCommandOptionType.User,
                    required: false,
                },
                {
                    name: 'channel',
                    name_localizations: jaOnly(commandNameLocales.channel),
                    description: 'channel',
                    description_localizations: omitLocalization(descriptionLocales.settingsDisableChannel),
                    type: ApplicationCommandOptionType.Channel,
                    required: false,
                },
                {
                    name: 'role',
                    name_localizations: jaOnly(commandNameLocales.role),
                    description: 'role',
                    type: ApplicationCommandOptionType.Role,
                    required: false,
                },
            ],
        },
        {
            name: 'defaultlanguage',
            name_localizations: jaOnly(commandNameLocales.defaultlanguage),
            description: 'defaultLanguage',
            description_localizations: omitLocalization(descriptionLocales.defaultLanguage),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'language',
                    name_localizations: jaOnly(commandNameLocales.language),
                    description: 'language',
                    description_localizations: omitLocalization(descriptionLocales.defaultLanguageLanguage),
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
            name_localizations: jaOnly(commandNameLocales.editoriginaliftranslate),
            description: 'editOriginalIfTranslate',
            description_localizations: omitLocalization(descriptionLocales.editoriginaliftranslate),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'extractbotmessage',
            name_localizations: jaOnly(commandNameLocales.extractbotmessage),
            description: 'extractBotMessage',
            description_localizations: omitLocalization(descriptionLocales.settingsextractBotMessage),
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
                    name_localizations: jaOnly(commandNameLocales.user),
                    description: 'user',
                    description_localizations: omitLocalization(descriptionLocales.settingsDisableUser),
                    type: ApplicationCommandOptionType.User,
                    required: false,
                },
                {
                    name: 'channel',
                    name_localizations: jaOnly(commandNameLocales.channel),
                    description: 'channel',
                    description_localizations: omitLocalization(descriptionLocales.settingsDisableChannel),
                    type: ApplicationCommandOptionType.Channel,
                    required: false,
                },
                {
                    name: 'role',
                    name_localizations: jaOnly(commandNameLocales.role),
                    description: 'role',
                    type: ApplicationCommandOptionType.Role,
                    required: false,
                },
            ],
        },
    ];

    options.push(
        {
            name: 'bannedwords',
            name_localizations: jaOnly(commandNameLocales.bannedwords),
            description: 'bannedWords',
            description_localizations: omitLocalization(descriptionLocales.settingsBannedWords),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'word',
                    name_localizations: jaOnly(commandNameLocales.word),
                    description: 'word',
                    description_localizations: omitLocalization(descriptionLocales.settingsBannedWordsWord),
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'setdefaultmediaasattachments',
            name_localizations: jaOnly(commandNameLocales.setdefaultmediaasattachments),
            description: 'setSendMediaAsAttachmentsAsDefault',
            description_localizations: omitLocalization(descriptionLocales.settingsSendMediaAsAttachmentsAsDefault),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'deleteifonlypostedtweetlink',
            name_localizations: jaOnly(commandNameLocales.deleteifonlypostedtweetlink),
            description: 'deleteIfOnlyPostedLink',
            description_localizations: omitLocalization(descriptionLocales.settingsDeleteMessageIfOnlyPostedTweetLink),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                boolOption,
                ...(includeSaveTweetOption ? [{
                    name: 'secoundaryextractmode',
                    name_localizations: jaOnly(commandNameLocales.doitwhensecondaryextractmodeisenabled),
                    description: 'doItWhenSecondaryExtractModeIsEnabled',
                    description_localizations: omitLocalization(descriptionLocales.settingsDoItWhenSecondaryExtractModeIsEnabled),
                    type: ApplicationCommandOptionType.Boolean,
                    required: false,
                }] : []),
            ],
        },
        {
            name: 'alwaysreplyifpostedtweetlink',
            name_localizations: jaOnly(commandNameLocales.alwaysreplyifpostedtweetlink),
            description: 'alwaysReplyIfPostedLink',
            description_localizations: omitLocalization(descriptionLocales.settingsAlwaysReplyIfPostedTweetLink),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'anonymousexpand',
            name_localizations: jaOnly(commandNameLocales.anonymous_expand),
            description: 'anonymous expand',
            description_localizations: omitLocalization(descriptionLocales.settingsAnonymousExpand),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'legacymode',
            name_localizations: jaOnly(commandNameLocales.legacy_mode),
            description: 'legacy mode',
            description_localizations: omitLocalization(descriptionLocales.settingsLegacyMode),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
    );

    return options;
}

function buildTwitterOptions() {
    return [
        {
            name: 'quoterepostdonotextract',
            name_localizations: jaOnly(commandNameLocales.quote_repost_do_not_extract),
            description: 'quote repost do not extract',
            description_localizations: omitLocalization(descriptionLocales.settingsQuoteRepostDoNotExtract),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'quoterepostmaxdepth',
            name_localizations: jaOnly(commandNameLocales.quote_repost_max_depth),
            description: 'quote repost max depth',
            description_localizations: omitLocalization(descriptionLocales.settingsQuoteRepostMaxDepth),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'depth',
                    name_localizations: jaOnly({ en: 'depth' }),
                    description: 'max depth (0 for unlimited)',
                    description_localizations: omitLocalization({ en: 'max depth (0 for unlimited)' }),
                    type: ApplicationCommandOptionType.Integer,
                    required: true,
                    min_value: 0,
                    max_value: 10,
                },
            ],
        },
        {
            name: 'passivemode',
            name_localizations: jaOnly(commandNameLocales.passive_mode),
            description: 'passive mode',
            description_localizations: omitLocalization(descriptionLocales.settingsPassiveMode),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'secondaryextractmode',
            name_localizations: jaOnly(commandNameLocales.secondary_extract_mode),
            description: 'secondary extract mode',
            description_localizations: omitLocalization(descriptionLocales.settingsSecondaryExtractMode),
            type: ApplicationCommandOptionType.Subcommand,
            options: [boolOption],
        },
        {
            name: 'secondaryextracttarget',
            name_localizations: jaOnly(commandNameLocales.secondaryextracttarget),
            description: 'secondary extract target',
            description_localizations: omitLocalization(descriptionLocales.settingsSecondaryExtractTarget),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'multipleimages',
                    name_localizations: jaOnly(commandNameLocales.multipleimages),
                    description: 'multiple images',
                    type: ApplicationCommandOptionType.Boolean,
                    required: false,
                },
                {
                    name: 'video',
                    name_localizations: jaOnly(commandNameLocales.video),
                    description: 'video',
                    type: ApplicationCommandOptionType.Boolean,
                    required: false,
                },
            ],
        },
    ];
}

function buildPixivOptions() {
    return [
        {
            name: 'images_per_step',
            name_localizations: jaOnly(commandNameLocales.images_per_step),
            description: '4 or 10 images per step',
            description_localizations: omitLocalization(descriptionLocales.settingsPixivImagesPerStep),
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'value',
                    name_localizations: jaOnly(commandNameLocales.value),
                    description: '4 or 10 images per step',
                    description_localizations: omitLocalization(descriptionLocales.settingsPixivImagesPerStepValue),
                    type: ApplicationCommandOptionType.Integer,
                    required: true,
                    choices: [
                        { name: '4', value: 4 },
                        { name: '10', value: 10 },
                    ],
                },
            ],
        },
    ];
}

function buildProviderOptions(provider) {
    return [
        ...buildCommonOptions(provider.id === 'twitter'),
        ...(provider.id === 'twitter' ? buildTwitterOptions() : []),
        ...(provider.id === 'pixiv' ? buildPixivOptions() : []),
    ];
}

function sortProvidersForSettings(providers) {
    return [...providers].sort((a, b) => {
        if (a.id === 'twitter') return -1;
        if (b.id === 'twitter') return 1;
        return a.id.localeCompare(b.id);
    });
}

function buildSettingsDefinition() {
    const providers = sortProvidersForSettings(loadProviders());
    return {
        name: 'settings',
        name_localizations: jaOnly(commandNameLocales.settings),
        description: 'change settings',
        description_localizations: omitLocalization(descriptionLocales.settingscommand),
        options: [
            ...buildCommonOptions(true).map(option => withProviderOption(option, providers)),
            {
                name: 'twitter',
                description: 'twitter settings',
                type: ApplicationCommandOptionType.SubcommandGroup,
                options: buildTwitterOptions(),
            },
            {
                name: 'pixiv',
                name_localizations: jaOnly(commandNameLocales.pixiv),
                description: 'pixiv settings',
                type: ApplicationCommandOptionType.SubcommandGroup,
                options: buildPixivOptions(),
            },
        ],
    };
}

module.exports.definition = buildSettingsDefinition();
module.exports._internal = {
    buildSettingsDefinition,
    buildProviderOptions,
    sortProvidersForSettings,
};
