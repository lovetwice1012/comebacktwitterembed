'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const niconicoDownloadStore = require('../../niconicoDownloadStore');
const {
    fetchWatchData,
    NICONICO_URL_PATTERN,
    niconicoVideoUrl,
    parseNiconicoUrl,
} = require('../../niconicoApi');

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
    tags: { ja: 'Tags', en: 'Tags' },
};

function tr(spec, lang) {
    return spec[lang] ?? spec.en ?? '';
}

function normalizeLang(s) {
    const lang = s?.defaultLanguage;
    return lang === 'ja' ? 'ja' : 'en';
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

function thumbnailUrl(thumbnail) {
    return thumbnail?.ogp || thumbnail?.largeUrl || thumbnail?.middleUrl || thumbnail?.url || null;
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

function tagSummary(watchData) {
    const tags = watchData?.tag?.items;
    if (!Array.isArray(tags)) return '';
    return tags
        .map(tag => tag?.name)
        .filter(Boolean)
        .slice(0, 8)
        .join(', ');
}

function buildVideoEmbed(watchData, parsed, message, s) {
    const lang = normalizeLang(s);
    const video = watchData?.video || {};
    const owner = ownerInfo(watchData);
    const fields = [];
    addField(fields, tr(STR.views, lang), formatNumber(video.count?.view));
    addField(fields, tr(STR.comments, lang), formatNumber(video.count?.comment));
    addField(fields, tr(STR.mylists, lang), formatNumber(video.count?.mylist));
    addField(fields, tr(STR.likes, lang), formatNumber(video.count?.like));
    addField(fields, tr(STR.duration, lang), formatDuration(video.duration));
    const uploadedAt = unixTimestamp(video.registeredAt);
    addField(fields, tr(STR.uploaded, lang), uploadedAt ? `<t:${uploadedAt}:d>` : null);
    addField(fields, tr(STR.tags, lang), tagSummary(watchData), false);

    const embed = {
        author: {
            name: owner.name || 'Niconico',
            url: owner.url,
            icon_url: owner.iconUrl || undefined,
        },
        title: video.title || parsed.id,
        url: parsed.originalUrl || niconicoVideoUrl(parsed.id),
        description: truncate(decodeHtml(video.description), DESCRIPTION_MAX_LENGTH) || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requesterFooter(message, lang, s?.anonymous_expand === true), icon_url: NICONICO_ICON },
    };

    const thumbnail = thumbnailUrl(video.thumbnail);
    if (thumbnail) embed.image = { url: thumbnail };
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

function buildStep(embed, message, url, s, lang) {
    /** @type {import('../_types').SendStep} */
    const step = {
        embeds: [embed],
        components: buildComponents(lang, true),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
    };

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
        return [buildStep(embed, message, url, s, lang)];
    } catch (err) {
        recordProviderError('niconico', err, message, url, { endpointKey: 'nicovideo/watch' });
        return null;
    }
}

/** @type {import('../_types').Provider} */
const niconicoProvider = {
    id: 'niconico',
    enabledByDefault: false,
    urlPattern: NICONICO_URL_PATTERN,
    extract,
};

module.exports = niconicoProvider;
module.exports._internal = {
    buildVideoEmbed,
    formatDuration,
    parseNiconicoUrl,
};
