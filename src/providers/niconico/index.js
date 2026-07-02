'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const niconicoDownloadStore = require('../../niconicoDownloadStore');
const {
    applyEmbedMedia,
    attachmentMediaUrls,
    buildFailureResponse,
    mediaLinksContent,
    resolveDensityMaxLength,
    shouldShowOutputItem,
} = require('../_output_controls');
const {
    fetchWatchData,
    NICONICO_URL_PATTERN,
    niconicoVideoUrl,
    parseNiconicoUrl,
} = require('../../niconicoApi');
const { toApiLocaleFamily } = require('../../discordLocales');
const { createProviderAnalytics, facet, finiteNumber, tagFacets } = require('../../analytics/providerMetrics');

const EMBED_COLOR = 0x252525;
const DESCRIPTION_MAX_LENGTH = 1400;
const FIELD_MAX_LENGTH = 1024;
const NICONICO_ICON = 'https://www.nicovideo.jp/favicon.ico';

const STR = {
    requesterPrefix: { ja: 'Requested by ', en: 'Requested by ' },
    anonymousRequester: { ja: 'Anonymous requester', en: 'Anonymous requester' },
    translateButton: { ja: 'Translate', en: 'Translate' },
    deleteButton: { ja: 'Delete', en: 'Delete' },
    video: { ja: 'Video', en: 'Video' },
    views: { ja: 'Views', en: 'Views' },
    comments: { ja: 'Comments', en: 'Comments' },
    mylists: { ja: 'Mylists', en: 'Mylists' },
    likes: { ja: 'Likes', en: 'Likes' },
    duration: { ja: 'Duration', en: 'Duration' },
    uploaded: { ja: 'Uploaded', en: 'Uploaded' },
    series: { ja: 'Series', en: 'Series' },
    uploader: { ja: 'Uploader', en: 'Uploader' },
    userUploader: { ja: 'User', en: 'User' },
    channelUploader: { ja: 'Channel', en: 'Channel' },
    genre: { ja: 'Genre', en: 'Genre' },
    tags: { ja: 'Tags', en: 'Tags' },
};

function tr(spec, lang) {
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLang(s) {
    return toApiLocaleFamily(s?.defaultLanguage);
}

function decodeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)));
}

function truncate(value, maxLength) {
    const text = String(value ?? '').trim();
    if (maxLength <= 0) return '';
    if (text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3).trimEnd() + '...';
}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n.toLocaleString('en-US');
}

function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return null;
    const rounded = Math.round(total);
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function unixTimestamp(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function requesterFooter(message, lang, anonymous) {
    const requester = anonymous
        ? tr(STR.anonymousRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
    return `${tr(STR.requesterPrefix, lang)}${requester} | Niconico`;
}

function addField(fields, name, value, inline = true) {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: truncate(String(value), FIELD_MAX_LENGTH), inline });
}

function niconicoDescriptionMaxLength(settings) {
    return resolveDensityMaxLength(settings, 'niconico_description_max_length', DESCRIPTION_MAX_LENGTH, {
        compact: 200,
        detail: DESCRIPTION_MAX_LENGTH,
        hardMax: DESCRIPTION_MAX_LENGTH,
    });
}

function thumbnailUrl(thumbnail) {
    return thumbnail?.ogp || thumbnail?.largeUrl || thumbnail?.middleUrl || thumbnail?.url || null;
}

function pathValue(obj, path) {
    let current = obj;
    for (const part of path.split('.')) {
        if (current == null) return undefined;
        current = current[part];
    }
    return current;
}

function firstString(obj, paths) {
    for (const path of paths) {
        const value = pathValue(obj, path);
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function ownerInfo(watchData) {
    if (watchData?.owner) {
        return {
            name: watchData.owner.nickname,
            url: watchData.owner.id ? `https://www.nicovideo.jp/user/${watchData.owner.id}` : undefined,
            iconUrl: watchData.owner.iconUrl,
        };
    }
    if (watchData?.channel) {
        return {
            name: watchData.channel.name,
            url: watchData.channel.id ? `https://ch.nicovideo.jp/${watchData.channel.id}` : undefined,
            iconUrl: watchData.channel.thumbnail?.url,
        };
    }
    return { name: 'Niconico', url: 'https://www.nicovideo.jp/', iconUrl: undefined };
}

function uploaderType(watchData, lang) {
    if (watchData?.channel?.id || watchData?.channel?.name) return tr(STR.channelUploader, lang);
    if (watchData?.owner?.id || watchData?.owner?.nickname) return tr(STR.userUploader, lang);
    return '';
}

function seriesName(watchData) {
    return firstString(watchData, [
        'series.title',
        'series.name',
        'video.series.title',
        'video.series.name',
    ]);
}

function genreName(watchData) {
    return firstString(watchData, [
        'genre.label',
        'genre.name',
        'genre.key',
        'video.genre.label',
        'video.genre.name',
        'video.genre.key',
    ]);
}

function tagSummary(watchData) {
    const tags = watchData?.tag?.items;
    if (!Array.isArray(tags)) return '';
    return tags
        .map(tag => tag?.name)
        .filter(Boolean)
        .slice(0, 8)
        .join(', ');
}

function tagList(watchData) {
    const tags = watchData?.tag?.items;
    if (!Array.isArray(tags)) return [];
    return tags.map(tag => tag?.name).filter(Boolean);
}

function buildVideoEmbed(watchData, parsed, message, s) {
    const lang = normalizeLang(s);
    const video = watchData?.video || {};
    const owner = ownerInfo(watchData);
    const visibleOwner = shouldShowOutputItem(s, 'owner', { hideInCompact: false })
        ? owner
        : { name: 'Niconico', url: 'https://www.nicovideo.jp/', iconUrl: NICONICO_ICON };
    const fields = [];
    if (shouldShowOutputItem(s, 'views')) addField(fields, tr(STR.views, lang), formatNumber(video.count?.view));
    if (shouldShowOutputItem(s, 'comments')) addField(fields, tr(STR.comments, lang), formatNumber(video.count?.comment));
    if (shouldShowOutputItem(s, 'mylists')) addField(fields, tr(STR.mylists, lang), formatNumber(video.count?.mylist));
    if (shouldShowOutputItem(s, 'likes')) addField(fields, tr(STR.likes, lang), formatNumber(video.count?.like));
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.duration, lang), formatDuration(video.duration));
    const uploadedAt = unixTimestamp(video.registeredAt);
    if (shouldShowOutputItem(s, 'uploaded')) addField(fields, tr(STR.uploaded, lang), uploadedAt ? `<t:${uploadedAt}:d>` : null);
    if (shouldShowOutputItem(s, 'series')) addField(fields, tr(STR.series, lang), seriesName(watchData));
    if (shouldShowOutputItem(s, 'uploader')) addField(fields, tr(STR.uploader, lang), uploaderType(watchData, lang));
    if (shouldShowOutputItem(s, 'genre')) addField(fields, tr(STR.genre, lang), genreName(watchData));
    if (shouldShowOutputItem(s, 'tags')) addField(fields, tr(STR.tags, lang), tagSummary(watchData), false);

    const embed = {
        author: {
            name: visibleOwner.name || 'Niconico',
            url: visibleOwner.url,
            icon_url: visibleOwner.iconUrl || undefined,
        },
        title: video.title || parsed.id,
        url: parsed.originalUrl || niconicoVideoUrl(parsed.id),
        description: truncate(decodeHtml(video.description), niconicoDescriptionMaxLength(s)) || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requesterFooter(message, lang, s?.anonymous_expand === true), icon_url: NICONICO_ICON },
    };

    const thumbnail = thumbnailUrl(video.thumbnail);
    applyEmbedMedia(embed, thumbnail, s);
    if (uploadedAt) embed.timestamp = new Date(uploadedAt * 1000).toISOString();
    return embed;
}

function buildComponents(lang, includeDownload) {
    const components = [
        new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'),
    ];
    if (includeDownload && niconicoDownloadStore.isDownloadButtonEnabled()) {
        components.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Download').setCustomId('downloadNiconicoVideo'));
    }
    components.push(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete:niconico'));
    return [{ type: ComponentType.ActionRow, components }];
}

function buildNiconicoAnalytics(watchData, parsed) {
    const video = watchData?.video || {};
    const owner = ownerInfo(watchData);
    const durationSeconds = finiteNumber(video.duration);
    return createProviderAnalytics({
        content: {
            accountKey: watchData?.owner?.id ? `user/${watchData.owner.id}` : (watchData?.channel?.id ? `channel/${watchData.channel.id}` : owner.name),
            contentId: video.id || parsed.id,
            contentType: 'video',
            contentUrl: parsed.originalUrl || niconicoVideoUrl(parsed.id),
            title: video.title,
            descriptionPreview: decodeHtml(video.description),
            authorName: owner.name,
            publishedAtMs: video.registeredAt ? Date.parse(video.registeredAt) : null,
            mediaCount: thumbnailUrl(video.thumbnail) ? 1 : 0,
            durationSeconds,
        },
        metrics: {
            views: finiteNumber(video.count?.view),
            comments: finiteNumber(video.count?.comment),
            mylists: finiteNumber(video.count?.mylist),
            likes: finiteNumber(video.count?.like),
            duration_seconds: durationSeconds,
        },
        facets: [
            facet('type', 'video'),
            facet('uploader_type', watchData?.channel?.id ? 'channel' : (watchData?.owner?.id ? 'user' : null)),
            facet('series', seriesName(watchData)),
            facet('category', genreName(watchData)),
            facet('genre', genreName(watchData)),
            ...tagFacets('tag', tagList(watchData)),
        ],
    });
}

function buildStep(embed, message, url, s, lang, mediaUrls = [], analytics = null) {
    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        components: buildComponents(lang, true),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics,
    };

    const files = attachmentMediaUrls(s, mediaUrls);
    if (files.length > 0) step.files = files;

    const mediaContent = mediaLinksContent(s, mediaUrls, 'Thumbnail');
    if (mediaContent) step.content = mediaContent;

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }
    return step;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const parsed = parseNiconicoUrl(url);
    if (!parsed) return null;

    try {
        const lang = normalizeLang(s);
        const watchData = await fetchWatchData(parsed.id);
        const embed = buildVideoEmbed(watchData, parsed, message, s);
        const mediaUrl = thumbnailUrl(watchData?.video?.thumbnail);
        return [buildStep(embed, message, url, s, lang, mediaUrl ? [mediaUrl] : [], buildNiconicoAnalytics(watchData, parsed))];
    } catch (err) {
        recordProviderError('niconico', err, message, url, { endpointKey: 'nicovideo/watch' });
        return buildFailureResponse('niconico', url, s, err);
    }
}

/** @type {import('../_types').Provider} */
const niconicoProvider = {
    id: 'niconico',
    enabledByDefault: false,
    urlPattern: NICONICO_URL_PATTERN,
    settings: [
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'niconico_description_max_length',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'views', label: { en: 'Views field', ja: 'Views field' } },
                { value: 'comments', label: { en: 'Comments field', ja: 'Comments field' } },
                { value: 'mylists', label: { en: 'Mylists field', ja: 'Mylists field' } },
                { value: 'likes', label: { en: 'Likes field', ja: 'Likes field' } },
                { value: 'duration', label: { en: 'Duration field', ja: 'Duration field' } },
                { value: 'uploaded', label: { en: 'Uploaded field', ja: 'Uploaded field' } },
                { value: 'series', label: { en: 'Series field', ja: 'Series field' } },
                { value: 'owner', label: { en: 'Owner author', ja: 'Owner author' } },
                { value: 'uploader', label: { en: 'Uploader type field', ja: 'Uploader type field' } },
                { value: 'genre', label: { en: 'Genre field', ja: 'Genre field' } },
                { value: 'tags', label: { en: 'Tags field', ja: 'Tags field' } },
            ],
        },
    ],
    extract,
};

module.exports = niconicoProvider;
module.exports._internal = {
    buildVideoEmbed,
    formatDuration,
    parseNiconicoUrl,
};
