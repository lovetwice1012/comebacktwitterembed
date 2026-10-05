'use strict';

const fetch = require('../../providerFetch').withDeadline(require('node-fetch'));
const { recordProviderError } = require('../../errorTracking');
const { applyMediaDisplayToStep, buildFailureResponse } = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');
const { GITHUB_URL_PATTERN, cleanRawUrl, parseGitHubUrl } = require('./urls');
const { createGitHubClient } = require('./client');
const { buildEmbed, buildComponents, stateText } = require('./presentation');
const { buildVisualAttachment } = require('./visuals');
const { buildGitHubAnalytics } = require('./analytics');

const { fetchGitHubData } = createGitHubClient(fetch);

function normalizeLang(settings) {
    return toApiLocaleFamily(settings?.defaultLanguage);
}

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && String(text || '').includes(word));
}

function externalMediaUrlsFromStep(step) {
    const urls = [];
    for (const embed of step?.embeds || []) {
        if (/^https?:\/\//i.test(embed?.image?.url || '')) urls.push(embed.image.url);
        if (/^https?:\/\//i.test(embed?.thumbnail?.url || '')) urls.push(embed.thumbnail.url);
    }
    return urls;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, settings) {
    settings = settings || {};
    const parsed = parseGitHubUrl(url);
    if (!parsed) return null;

    let data;
    try {
        data = await fetchGitHubData(parsed, settings);
    } catch (err) {
        recordProviderError('github', err, message, url, { endpointKey: 'github/rest' });
        console.log(err);
        return buildFailureResponse('github', url, settings, err);
    }

    const lang = normalizeLang(settings);
    /** @type {any} */
    const embed = buildEmbed(data, parsed, message, settings, lang);
    if (!embed) return null;

    const bannedTarget = [
        embed.title,
        embed.description,
        ...(embed.fields || []).map(field => field.value),
    ].filter(Boolean).join('\n');
    if (containsBannedWord(bannedTarget, settings.bannedWords)) return null;

    const visualAttachment = buildVisualAttachment(data, parsed, settings);
    if (visualAttachment?.imageUrl) {
        embed.image = { url: visualAttachment.imageUrl };
    } else if (visualAttachment?.attachment) {
        embed.image = { url: `attachment://${visualAttachment.attachment.name}` };
    }

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        files: visualAttachment?.attachment ? [visualAttachment.attachment] : [],
        components: buildComponents(lang, embed.url || parsed.canonicalUrl),
        allowedMentions: { repliedUser: false },
        send: settings.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics: buildGitHubAnalytics(data, parsed),
    };

    if (settings.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    applyMediaDisplayToStep(step, settings, externalMediaUrlsFromStep(step), 'Image');
    return [step];
}

/** @type {import('../_types').Provider} */
const githubProvider = {
    id: 'github',
    enabledByDefault: false,
    urlPattern: new RegExp(GITHUB_URL_PATTERN.source, GITHUB_URL_PATTERN.flags),
    settings: [
        'bannedWords',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'github_card_style',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'license', label: { en: 'License field', ja: 'License field' } },
                { value: 'state', label: { en: 'State field', ja: 'State field' } },
                { value: 'comments', label: { en: 'Comments field', ja: 'Comments field' } },
                { value: 'mergeable', label: { en: 'Mergeable field', ja: 'Mergeable field' } },
                { value: 'review_state', label: { en: 'Review state field', ja: 'Review state field' } },
                { value: 'checks', label: { en: 'Checks field', ja: 'Checks field' } },
                { value: 'labels', label: { en: 'Labels field', ja: 'Labels field' } },
                { value: 'assignees', label: { en: 'Assignees field', ja: 'Assignees field' } },
                { value: 'changes', label: { en: 'Changes field', ja: 'Changes field' } },
                { value: 'commits', label: { en: 'Commits field', ja: 'Commits field' } },
                { value: 'files', label: { en: 'Files field', ja: 'Files field' } },
                { value: 'sha', label: { en: 'SHA field', ja: 'SHA field' } },
                { value: 'author', label: { en: 'Author field', ja: 'Author field' } },
                { value: 'tag', label: { en: 'Tag field', ja: 'Tag field' } },
                { value: 'assets', label: { en: 'Assets field', ja: 'Assets field' } },
                { value: 'type', label: { en: 'Type field', ja: 'Type field' } },
                { value: 'size', label: { en: 'Size field', ja: 'Size field' } },
                { value: 'snippet', label: { en: 'File snippet', ja: 'File snippet' } },
                { value: 'repositories', label: { en: 'Repositories field', ja: 'Repositories field' } },
                { value: 'followers', label: { en: 'Followers field', ja: 'Followers field' } },
                { value: 'location', label: { en: 'Location field', ja: 'Location field' } },
                { value: 'contributions', label: { en: 'Contributions field', ja: 'Contributions field' } },
                { value: 'gist_files', label: { en: 'Gist files field', ja: 'Gist files field' } },
                { value: 'language_breakdown', label: { en: 'Language breakdown field', ja: 'Language breakdown field' } },
                { value: 'topics', label: { en: 'Topics field', ja: 'Topics field' } },
                { value: 'default_branch', label: { en: 'Default branch field', ja: 'Default branch field' } },
                { value: 'last_push', label: { en: 'Last push field', ja: 'Last push field' } },
                { value: 'repo_card', label: { en: 'Repository card image', ja: 'リポジトリカード画像' } },
                { value: 'language', label: { en: 'Language field/visual', ja: '言語欄/言語表示' } },
                { value: 'repo_stats', label: { en: 'Stars/forks/issues fields', ja: 'スター/フォーク/Issue欄' } },
            ],
        },
    ],
    extract,
};

module.exports = githubProvider;
module.exports._internal = {
    buildEmbed,
    cleanRawUrl,
    parseGitHubUrl,
    stateText,
};
