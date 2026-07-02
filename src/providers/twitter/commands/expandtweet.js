'use strict';

const { ApplicationCommandOptionType } = require('discord.js');

function sendTweetEmbed(/** @type {any} */ message, /** @type {string} */ url, /** @type {any=} */ extra) {
    return require(/** @type {any} */ ('..')).sendTweetEmbed(message, url, extra);
}

function providerSettings() {
    return require('../../_provider_settings');
}

function stripDiscordUrlMarkup(value) {
    return String(value || '').trim().replace(/^<(.+)>$/, '$1').replace(/^\|\|(.+)\|\|$/, '$1');
}

function normalizeAccount(account) {
    const raw = stripDiscordUrlMarkup(account).trim();
    if (!raw) return '';

    const urlMatch = raw.match(/^(?:https?:\/\/)?(?:twitter\.com|x\.com)\/([^/?#]+)/i);
    const handle = (urlMatch ? urlMatch[1] : raw).replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        throw new Error('account must be a Twitter/X handle.');
    }
    return handle.toLowerCase();
}

function extractTweetId(value) {
    const match = String(value || '').match(/\/status\/(\d+)/);
    if (match) return match[1];
    return /^\d{5,30}$/.test(String(value || '').trim()) ? String(value).trim() : '';
}

function normalizeTweetUrl(input, accountInput) {
    let value = stripDiscordUrlMarkup(input);
    if (/^(twitter\.com|x\.com)\//i.test(value)) value = `https://${value}`;

    const account = normalizeAccount(accountInput);
    const bareId = /^\d{5,30}$/.test(value) ? value : '';
    if (bareId) {
        if (!account) throw new Error('account is required when url is only a tweet id.');
        return `https://twitter.com/${account}/status/${bareId}`;
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('url must be a Twitter/X status URL.');
    }

    if (!/^(twitter\.com|x\.com)$/i.test(parsed.hostname)) {
        throw new Error('url must be a Twitter/X status URL.');
    }

    const tweetId = extractTweetId(parsed.pathname);
    if (!tweetId) throw new Error('url must include a tweet status id.');
    if (account) return `https://twitter.com/${account}/status/${tweetId}`;
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${parsed.search}`;
}

function buildSettingsOverride(depth) {
    const override = {
        secondary_extract_mode: false,
    };
    if (depth !== null) {
        override.quote_repost_max_depth = depth;
        override.quote_repost_do_not_extract = false;
    }
    return override;
}

function formatDepth(depth) {
    if (depth === null) return null;
    return depth === 0 ? 'unlimited' : String(depth);
}

function finishMessage(depth, saveResult, saveError) {
    const lines = ['Finished action.'];
    const depthText = formatDepth(depth);
    if (depthText) lines.push(`Quote repost depth: ${depthText}`);
    if (saveResult?.account) lines.push(`Saved future depth for @${saveResult.account}.`);
    else if (saveResult?.global) lines.push('Saved future default quote repost depth.');
    else if (saveError) lines.push('Expanded tweet, but saving the future setting failed.');
    return lines.join('\n');
}

async function persistDepth(interaction, account, depth) {
    if (depth === null) throw new Error('depth is required when save is true or account is set.');
    const settings = providerSettings();
    const provider = { id: 'twitter' };
    if (account) {
        const current = await settings.getSetting(provider, 'quote_repost_depth_by_account', interaction.guildId) || {};
        await settings.setSetting(provider, 'quote_repost_depth_by_account', interaction.guildId, {
            ...current,
            [account]: depth,
        });
        return { account };
    }

    await settings.setSetting(provider, 'quote_repost_max_depth', interaction.guildId, depth);
    await settings.setSetting(provider, 'quote_repost_do_not_extract', interaction.guildId, false);
    return { global: true };
}

module.exports.execute = async function (interaction) {
    const rawUrl = interaction.options.getString('url');
    const depth = interaction.options.getInteger('depth');
    const rawAccount = interaction.options.getString('account');

    if (depth === null) {
        return await interaction.editReply({ content: 'depth is required.' });
    }

    let url;
    let account;
    try {
        account = normalizeAccount(rawAccount);
        url = normalizeTweetUrl(rawUrl, account);
    } catch (err) {
        return await interaction.editReply({ content: err.message });
    }
    const save = interaction.options.getBoolean('save') === true || !!account;

    const sendOptions = {
        forceSendMode: 'channel',
        settingsOverride: buildSettingsOverride(depth),
    };
    await sendTweetEmbed(interaction, url, sendOptions);

    let saveResult = null;
    let saveError = null;
    if (save) {
        try {
            saveResult = await persistDepth(interaction, account, depth);
        } catch (err) {
            saveError = err;
            console.warn(`[et] Failed to save quote repost depth for guild ${interaction.guildId}:`, err);
        }
    }

    await interaction.editReply({ content: finishMessage(depth, saveResult, saveError) });
};

module.exports.definition = {
    name: 'et',
    description: 'Expand a tweet with optional quote repost depth.',
    description_localizations: {
        ja: '引用RTの展開数を指定してツイートを展開します。',
    },
    options: [
        {
            name: 'url',
            description: 'Twitter/X status URL, or a tweet id when account is set.',
            description_localizations: {
                ja: 'Twitter/X のステータスURL。account 指定時はツイートIDも使用できます。',
            },
            type: ApplicationCommandOptionType.String,
            required: true,
        },
        {
            name: 'depth',
            name_localizations: {
                ja: '展開数',
            },
            description: 'Quote repost expansion depth. 0 means unlimited.',
            description_localizations: {
                ja: '引用RTを展開する深さ。0 は無制限です。',
            },
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 0,
        },
        {
            name: 'save',
            name_localizations: {
                ja: '保存',
            },
            description: 'Apply this quote repost depth to future expansions.',
            description_localizations: {
                ja: 'この引用RT展開数を今後の展開にも適用します。',
            },
            type: ApplicationCommandOptionType.Boolean,
            required: false,
        },
        {
            name: 'account',
            name_localizations: {
                ja: 'アカウント',
            },
            description: 'Twitter/X account handle. Automatically saves this depth for the account.',
            description_localizations: {
                ja: 'Twitter/X アカウント。指定するとこの展開数が自動保存されます。',
            },
            type: ApplicationCommandOptionType.String,
            required: false,
        },
    ],
};

module.exports._internal = {
    normalizeAccount,
    normalizeTweetUrl,
    buildSettingsOverride,
    finishMessage,
    persistDepth,
};
