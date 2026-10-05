'use strict';

const fetch = require('../../providerFetch').withDeadline(require('node-fetch'));
const { recordProviderError } = require('../../errorTracking');
const { buildFailureResponse } = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');
const { INSTAGRAM_URL_PATTERN, INSTAGRAM_CLEAN_PATTERN, parseInstagramUrl, buildCanonicalUrl } = require('./urls');
const { parseInstagramHtml, normalizeMediaNode } = require('./instagramSourceParser');
const { createInstagramClient } = require('./client');
const {
    requesterNameFor,
    buildProfilePayload,
    buildMediaPayload,
    selectMedias,
    resolveMediaLimit,
} = require('./presentation');
const { buildInstagramProfileAnalytics, buildInstagramMediaAnalytics } = require('./analytics');

const { resolveShareUrl, resolveParsedUrl, fetchProfileData, fetchInstagramData, clearCache } = createInstagramClient(fetch);

function containsBannedWord(text, bannedWords) {
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    return bannedWords.some(word => word && text.includes(word));
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s, opts) {
    s = s || {};
    opts = opts || {};
    const lang = toApiLocaleFamily(s.defaultLanguage);

    const parsed = await resolveParsedUrl(parseInstagramUrl(url));
    if (!parsed || (parsed.kind !== 'media' && parsed.kind !== 'profile')) return null;

    const requesterName = requesterNameFor(message, s, lang);
    const canonicalUrl = buildCanonicalUrl(parsed);

    if (parsed.kind === 'profile') {
        let profile;
        try {
            profile = await fetchProfileData(parsed.username);
        } catch (err) {
            console.warn(`[instagram] Failed to extract profile ${url}: ${err?.message || err}`);
            recordProviderError('instagram', err, message, url, { endpointKey: 'instagram/profile' });
            return buildFailureResponse('instagram', url, s, err);
        }
        if (!profile) return null;

        const bannedTarget = [profile.username, profile.fullName, profile.biography].filter(Boolean).join('\n');
        if (containsBannedWord(bannedTarget, s.bannedWords)) return null;

        const payload = buildProfilePayload(profile, canonicalUrl, lang, requesterName, s);
        /** @type {import('../_types').SendStep} */
        const step = {
            content: payload.content,
            embeds: payload.embeds,
            files: payload.files,
            components: payload.components,
            allowedMentions: { repliedUser: false },
            send: opts.forceSendMode || (s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel'),
            analytics: buildInstagramProfileAnalytics(profile, canonicalUrl),
        };

        if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
            step.deleteSource = true;
        } else if (s.legacy_mode === true) {
            step.suppressSourceEmbeds = true;
        }

        return [step];
    }

    let data;
    try {
        data = await fetchInstagramData(parsed);
    } catch (err) {
        recordProviderError('instagram', err, message, url, { endpointKey: 'instagram/embed-or-graphql' });
        return buildFailureResponse('instagram', url, s, err);
    }

    if (containsBannedWord(data.caption || '', s.bannedWords)) return null;

    const payload = buildMediaPayload(data, canonicalUrl, lang, requesterName, s, parsed.mediaIndex);
    if (!payload) return null;
    const selected = selectMedias(data.medias, parsed.mediaIndex, resolveMediaLimit(s.instagram_media_limit, s));

    /** @type {import('../_types').SendStep} */
    const step = {
        content: payload.content,
        embeds: payload.embeds,
        files: payload.files,
        components: payload.components,
        allowedMentions: { repliedUser: false },
        send: opts.forceSendMode || (s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel'),
        analytics: buildInstagramMediaAnalytics(data, canonicalUrl, selected, parsed),
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    } else if (s.legacy_mode === true) {
        step.suppressSourceEmbeds = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const instagramProvider = {
    id: 'instagram',
    enabledByDefault: false,
    urlPattern: new RegExp(INSTAGRAM_URL_PATTERN),
    cleanPattern: new RegExp(INSTAGRAM_CLEAN_PATTERN),
    settings: [
        'bannedWords',
        'sendMediaAsAttachmentsAsDefault',
        'display_density',
        'media_display_mode',
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'legacy_mode',
        'instagram_caption_max_length',
        'instagram_media_limit',
        'gallery_display_mode',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'likes', label: { en: 'Likes field', ja: 'Likes field' } },
                { value: 'comments', label: { en: 'Comments field', ja: 'Comments field' } },
                { value: 'location', label: { en: 'Location field', ja: 'Location field' } },
                { value: 'hashtags', label: { en: 'Hashtags field', ja: 'Hashtags field' } },
                { value: 'mentions', label: { en: 'Mentions field', ja: 'Mentions field' } },
                { value: 'duration', label: { en: 'Video duration field', ja: 'Video duration field' } },
                { value: 'audio', label: { en: 'Audio field', ja: 'Audio field' } },
                { value: 'profile_status', label: { en: 'Profile status field', ja: 'Profile status field' } },
                { value: 'media_range', label: { en: 'Media count field', ja: 'メディア枚数欄' } },
                { value: 'profile_counts', label: { en: 'Profile count fields', ja: 'プロフィール数値欄' } },
            ],
        },
    ],
    extract,
};

module.exports = instagramProvider;
module.exports.__test = {
    parseInstagramUrl,
    parseInstagramHtml,
    normalizeMediaNode,
    resolveShareUrl,
    _clearCache: clearCache,
};
