'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { videoExtensions } = require('../../utils');
const {
    applyMediaDisplayToStep,
    resolveDensityMaxLength,
    resolveDisplayDensity,
    shouldShowOutputItem,
} = require('../_output_controls');
const { EMBED_COLOR, MAX_MEDIA_PER_MESSAGE, DESCRIPTION_MAX_LENGTH, CAPTION_MAX_LENGTH } = require('./constants');

const STR = {
    requesterPrefix:              { ja: '\u5c55\u958b\u8005: ', en: 'Requested by ' },
    anonRequester:                { ja: '\u533f\u540d\u30e6\u30fc\u30b6\u30fc', en: 'Anonymous requester' },
    viewLink:                     { ja: 'Instagram \u3067\u898b\u308b', en: 'View on Instagram' },
    mediaField:                   { ja: '\u30e1\u30c7\u30a3\u30a2', en: 'Media' },
    showMediaAsAttachmentsButton: { ja: '\u30e1\u30c7\u30a3\u30a2\u3092\u6dfb\u4ed8\u30d5\u30a1\u30a4\u30eb\u3068\u3057\u3066\u8868\u793a\u3059\u308b', en: 'Show media as attachments' },
    showAttachmentsAsEmbedButton: { ja: '\u753b\u50cf\u3092\u57cb\u3081\u8fbc\u307f\u753b\u50cf\u3068\u3057\u3066\u8868\u793a\u3059\u308b', en: 'Show media in embeds image' },
    translateButton:              { ja: '\u7ffb\u8a33', en: 'Translate' },
    deleteButton:                 { ja: '\u524a\u9664', en: 'Delete' },
    postsField:                   { ja: '\u6295\u7a3f', en: 'Posts' },
    followersField:               { ja: '\u30d5\u30a9\u30ed\u30ef\u30fc', en: 'Followers' },
    followingField:               { ja: '\u30d5\u30a9\u30ed\u30fc\u4e2d', en: 'Following' },
    websiteLink:                  { ja: '\u30a6\u30a7\u30d6\u30b5\u30a4\u30c8', en: 'Website' },
    likesField:                   { ja: 'Likes', en: 'Likes' },
    commentsField:                { ja: 'Comments', en: 'Comments' },
    locationField:                { ja: 'Location', en: 'Location' },
    hashtagsField:                { ja: 'Hashtags', en: 'Hashtags' },
    mentionsField:                { ja: 'Mentions', en: 'Mentions' },
    durationField:                { ja: 'Duration', en: 'Duration' },
    audioField:                   { ja: 'Audio', en: 'Audio' },
    profileStatusField:           { ja: 'Status', en: 'Status' },
    verifiedStatus:               { ja: 'Verified', en: 'Verified' },
    privateStatus:                { ja: 'Private', en: 'Private' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function truncate(value, max) {
    if (!value) return '';
    if (max <= 0) return '';
    return value.length <= max ? value : value.slice(0, max - 3) + '...';
}

function requesterNameFor(message, settings, lang) {
    return settings.anonymous_expand === true
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
}

function isVideoMedia(media) {
    if (!media) return false;
    if (String(media.typeName || '').includes('Video')) return true;
    return videoExtensions.includes(mediaUrlExtension(media.url));
}

function mediaUrlExtension(rawUrl) {
    const cleanUrl = String(rawUrl || '').split(/[?#]/)[0];
    const ext = cleanUrl.split('.').pop()?.toLowerCase();
    return /^[a-z0-9]{1,10}$/.test(ext || '') ? ext : '';
}

function hasDirectVideoUrl(media) {
    return isVideoMedia(media) && videoExtensions.includes(mediaUrlExtension(media?.url));
}

function mediaFilePayload(media, index) {
    const ext = mediaUrlExtension(media?.url) || (isVideoMedia(media) ? 'mp4' : 'jpg');
    return {
        attachment: media.url,
        // Instagram's signed CDN URLs do not always give Discord a useful
        // filename. A stable extension is required for native video rendering.
        name: `instagram-${index + 1}.${ext}`,
    };
}

function resolveCaptionMaxLength(value, settings = {}) {
    if (value === undefined || value === null || value === '') {
        return resolveDensityMaxLength(settings, 'instagram_caption_max_length', CAPTION_MAX_LENGTH, {
            compact: 200,
            detail: CAPTION_MAX_LENGTH,
            hardMax: CAPTION_MAX_LENGTH,
        });
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return CAPTION_MAX_LENGTH;
    return Math.max(0, Math.min(CAPTION_MAX_LENGTH, Math.round(n)));
}

function resolveMediaLimit(value, settings = {}) {
    const n = Number(value);
    if (n === 1 || n === 4) return n;
    if (resolveDisplayDensity(settings) === 'compact') return 1;
    return MAX_MEDIA_PER_MESSAGE;
}

function selectMedias(medias, mediaIndex, limit = MAX_MEDIA_PER_MESSAGE) {
    if (!Array.isArray(medias) || medias.length === 0) return [];
    if (mediaIndex && mediaIndex > 0) {
        const index = Math.min(mediaIndex, medias.length) - 1;
        return [medias[index]];
    }
    return medias.slice(0, Math.max(1, Math.min(MAX_MEDIA_PER_MESSAGE, limit)));
}

function displayRange(total, selectedCount, mediaIndex) {
    if (total <= 1) return '';
    if (mediaIndex && mediaIndex > 0) return `${Math.min(mediaIndex, total)} / ${total}`;
    return selectedCount === total ? `1-${total} / ${total}` : `1-${selectedCount} / ${total}`;
}

function uniqueTextMatches(text, pattern, limit = 10) {
    if (!text) return '';
    const seen = new Set();
    const values = [];
    for (const match of String(text).matchAll(pattern)) {
        const value = match[0];
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(value);
        if (values.length >= limit) break;
    }
    return values.join(' ');
}

function formatDurationSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const total = Math.round(n);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
    return `${minutes}:${seconds}`;
}

function audioSummary(data) {
    return [data.audioTitle, data.audioArtist].filter(Boolean).join(' - ');
}

function addField(fields, name, value, inline = true) {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: String(value), inline });
}

function buildBaseEmbed(data, canonicalUrl, lang, requesterName, selectedCount, mediaIndex, s) {
    const caption = truncate(data.caption || '', resolveCaptionMaxLength(s?.instagram_caption_max_length, s));
    let description = [caption, `[${tr(STR.viewLink, lang)}](${canonicalUrl})`].filter(Boolean).join('\n\n');
    description = truncate(description, DESCRIPTION_MAX_LENGTH);

    const title = data.username ? `@${data.username}` : 'Instagram';
    const embed = {
        title,
        url: canonicalUrl,
        description,
        color: EMBED_COLOR,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - Instagram` },
    };

    if (data.username) {
        embed.author = {
            name: `@${data.username}`,
            url: `https://www.instagram.com/${data.username}/`,
        };
    }
    if (data.timestamp) embed.timestamp = new Date(data.timestamp);

    const fields = [];
    const range = shouldShowOutputItem(s, 'media_range') ? displayRange(data.medias.length, selectedCount, mediaIndex) : '';
    addField(fields, tr(STR.mediaField, lang), range);
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), formatDurationSeconds(data.videoDuration));
    if (shouldShowOutputItem(s, 'audio')) addField(fields, tr(STR.audioField, lang), audioSummary(data));
    if (shouldShowOutputItem(s, 'likes')) addField(fields, tr(STR.likesField, lang), formatCount(data.likeCount, lang));
    if (shouldShowOutputItem(s, 'comments')) addField(fields, tr(STR.commentsField, lang), formatCount(data.commentCount, lang));
    if (shouldShowOutputItem(s, 'location')) addField(fields, tr(STR.locationField, lang), data.locationName);
    if (shouldShowOutputItem(s, 'hashtags')) addField(fields, tr(STR.hashtagsField, lang), uniqueTextMatches(data.caption, /#[\p{L}\p{N}_]+/gu), false);
    if (shouldShowOutputItem(s, 'mentions')) addField(fields, tr(STR.mentionsField, lang), uniqueTextMatches(data.caption, /@[A-Za-z0-9._]+/g), false);
    if (fields.length > 0) embed.fields = fields;
    return embed;
}

function formatCount(value, lang) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() || null;
    return new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US').format(value);
}

function buildProfilePayload(profile, canonicalUrl, lang, requesterName, s) {
    const descriptionParts = [];
    if (profile.biography) descriptionParts.push(truncate(profile.biography, 1200));
    if (profile.externalUrl) descriptionParts.push(`[${tr(STR.websiteLink, lang)}](${profile.externalUrl})`);
    descriptionParts.push(`[${tr(STR.viewLink, lang)}](${canonicalUrl})`);

    const title = profile.fullName
        ? `${profile.fullName} (@${profile.username})`
        : `@${profile.username}`;

    /** @type {any} */
    const embed = {
        title,
        url: canonicalUrl,
        description: truncate(descriptionParts.filter(Boolean).join('\n\n'), DESCRIPTION_MAX_LENGTH),
        color: EMBED_COLOR,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - Instagram` },
    };

    if (profile.profilePicUrl) embed.thumbnail = { url: profile.profilePicUrl };

    const fields = [];
    const posts = formatCount(profile.posts, lang);
    const followers = formatCount(profile.followers, lang);
    const following = formatCount(profile.following, lang);
    if (shouldShowOutputItem(s, 'profile_counts')) {
        if (posts !== null) fields.push({ name: tr(STR.postsField, lang), value: posts, inline: true });
        if (followers !== null) fields.push({ name: tr(STR.followersField, lang), value: followers, inline: true });
        if (following !== null) fields.push({ name: tr(STR.followingField, lang), value: following, inline: true });
    }
    if (shouldShowOutputItem(s, 'profile_status')) {
        const status = [
            profile.isVerified ? tr(STR.verifiedStatus, lang) : '',
            profile.isPrivate ? tr(STR.privateStatus, lang) : '',
        ].filter(Boolean).join(' / ');
        addField(fields, tr(STR.profileStatusField, lang), status);
    }
    if (fields.length > 0) embed.fields = fields;

    const payload = {
        embeds: [embed],
        files: [],
        components: buildButtons(lang, 'profile', false),
    };
    return applyMediaDisplayToStep(payload, s, profile.profilePicUrl, 'Image');
}

function buildButtons(lang, mediaMode, includeSwitcher) {
    const rows = [];
    if (includeSwitcher) {
        const customId = mediaMode === 'attachments' ? 'showAttachmentsAsEmbedsImage' : 'showMediaAsAttachments';
        const label = mediaMode === 'attachments'
            ? tr(STR.showAttachmentsAsEmbedButton, lang)
            : tr(STR.showMediaAsAttachmentsButton, lang);
        rows.push({
            type: ComponentType.ActionRow,
            components: [new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(label).setCustomId(customId)],
        });
    }

    rows.push({
        type: ComponentType.ActionRow,
        components: [
            new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'),
            new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete:instagram'),
        ],
    });
    return rows;
}

function buildMediaPayload(data, canonicalUrl, lang, requesterName, s, mediaIndex) {
    const selected = selectMedias(data.medias, mediaIndex, resolveMediaLimit(s.instagram_media_limit, s));
    if (selected.length === 0) return null;

    const baseEmbed = buildBaseEmbed(data, canonicalUrl, lang, requesterName, selected.length, mediaIndex, s);
    const indexed = selected.map((media, index) => ({ media, index }));
    const directVideos = indexed.filter(({ media }) => hasDirectVideoUrl(media));
    const shouldUseAttachments = directVideos.length > 0
        || selected.length > 4
        || s.sendMediaAsAttachmentsAsDefault === true;

    if (shouldUseAttachments) {
        const files = indexed.map(({ media, index }) => mediaFilePayload(media, index));
        // Keeping a mixed carousel in one ordered attachment sequence is the
        // only Discord layout that preserves the source order around videos.
        const canSwitchBack = directVideos.length === 0 && selected.length <= 4;
        const payload = {
            embeds: [baseEmbed],
            files,
            components: buildButtons(lang, 'attachments', canSwitchBack),
        };
        return applyMediaDisplayToStep(payload, s, selected.map(media => media.url), 'Media');
    }

    const embeds = selected.map((media, index) => {
        /** @type {any} */
        const embed = index === 0
            ? { ...baseEmbed }
            : { url: canonicalUrl, color: EMBED_COLOR };
        embed.image = { url: media.url };
        return embed;
    });

    const payload = {
        embeds,
        files: [],
        components: buildButtons(lang, 'embeds', selected.length > 0),
    };
    return applyMediaDisplayToStep(payload, s, selected.map(media => media.url), 'Media');
}

module.exports = {
    requesterNameFor,
    buildProfilePayload,
    buildMediaPayload,
    selectMedias,
    resolveMediaLimit,
};
