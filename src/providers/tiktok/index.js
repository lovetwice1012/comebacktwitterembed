'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { settings } = require('../../settings');

const TIKTOK_URL_PATTERN =
    /https?:\/\/(?:(?:www|m|vm|vt)\.)?tiktok\.com\/[^\s<>|]+/g;

const EMBED_COLOR = 0xff0050;
const MAX_DESCRIPTION_LENGTH = 900;
const MAX_IMAGES_PER_MESSAGE = 10;
const IMAGES_PER_GROUP = 4;
const AWEME_ID_PATTERN = /^\d{1,25}$/;
const AWEME_LINK_PATTERN = /\/@?([\w\d_.-]+)\/(video|photo)\/(\d{1,25})/;
const PROFILE_LINK_PATTERN = /^\/@([\w\d_.-]+)\/?$/;

const STR = {
    showMediaAsAttachmentsButton: { ja: 'Show media as attachments', en: 'Show media as attachments' },
    translateButton:              { ja: 'Translate',                 en: 'Translate' },
    deleteButton:                 { ja: 'Delete',                    en: 'Delete' },
    requesterPrefix:              { ja: 'Requested by ',             en: 'Requested by ' },
    anonRequester:                { ja: 'Anonymous requester',       en: 'Anonymous requester' },
    statsPlays:                   { ja: 'plays',                     en: 'plays' },
    statsLikes:                   { ja: 'likes',                     en: 'likes' },
    statsComments:                { ja: 'comments',                  en: 'comments' },
    statsShares:                  { ja: 'shares',                    en: 'shares' },
    profileFollowers:             { ja: 'Followers',                 en: 'Followers' },
    profileFollowing:             { ja: 'Following',                 en: 'Following' },
    profileLikes:                 { ja: 'Likes',                     en: 'Likes' },
    profileVideos:                { ja: 'Videos',                    en: 'Videos' },
    imagesField:                  { ja: 'Images',                    en: 'Images' },
    fallbackTitle:                { ja: 'TikTok post',               en: 'TikTok post' },
    fallbackProfileTitle:         { ja: 'TikTok profile',            en: 'TikTok profile' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function truncate(text, maxLength) {
    const value = String(text ?? '').trim();
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength - 3) + '...';
}

function formatNumber(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num) || num < 1000) return String(num || 0);
    const strip = s => s.replace(/\.0$/, '');
    if (num < 1000000) return strip((num / 1000).toFixed(1)) + 'K';
    if (num < 1000000000) return strip((num / 1000000).toFixed(1)) + 'M';
    return strip((num / 1000000000).toFixed(1)) + 'B';
}

function commonHeaders(userAgent) {
    return {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    };
}

function extractJsonFromScript(html, scriptId) {
    const startTag = `<script id="${scriptId}" type="application/json">`;
    const endTag = '</script>';
    const startIndex = html.indexOf(startTag);
    if (startIndex === -1) throw new Error(`Script tag ${scriptId} not found`);
    const jsonStart = startIndex + startTag.length;
    const jsonEnd = html.indexOf(endTag, jsonStart);
    if (jsonEnd === -1) throw new Error(`End tag for ${scriptId} not found`);
    return html.substring(jsonStart, jsonEnd);
}

function parseTikTokUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'tiktok.com' && !hostname.endsWith('.tiktok.com')) return null;

    const awemeMatch = url.pathname.match(AWEME_LINK_PATTERN);
    if (awemeMatch) {
        return {
            needsResolve: false,
            id: awemeMatch[3],
            kind: awemeMatch[2],
            canonicalUrl: `https://www.tiktok.com/@${awemeMatch[1]}/${awemeMatch[2]}/${awemeMatch[3]}`,
        };
    }

    const mobileVideo = url.pathname.match(/^\/v\/(\d{1,25})(?:\.html)?/);
    if (mobileVideo) {
        return {
            needsResolve: false,
            id: mobileVideo[1],
            kind: 'video',
            canonicalUrl: `https://www.tiktok.com/@i/video/${mobileVideo[1]}`,
        };
    }

    const profileMatch = url.pathname.match(PROFILE_LINK_PATTERN);
    if (profileMatch) {
        return {
            needsResolve: false,
            id: profileMatch[1],
            kind: 'profile',
            canonicalUrl: `https://www.tiktok.com/@${profileMatch[1]}`,
        };
    }

    return { needsResolve: true, url: rawUrl };
}

async function resolveTikTokUrl(rawUrl) {
    const parsed = parseTikTokUrl(rawUrl);
    if (!parsed) return null;
    if (!parsed.needsResolve) return parsed;

    const res = await fetch(rawUrl, {
        headers: commonHeaders('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'),
        redirect: 'manual',
    });
    const location = res.headers?.get?.('Location') || res.headers?.get?.('location');
    if (!location) return null;
    const resolved = new URL(location, rawUrl);
    return parseTikTokUrl(resolved.toString());
}

async function fetchVideoData(id) {
    if (!AWEME_ID_PATTERN.test(id)) return null;
    const url = `https://www.tiktok.com/@i/video/${id}`;
    const res = await fetch(url, { headers: commonHeaders() });
    const html = await res.text();
    const jsonText = extractJsonFromScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const json = JSON.parse(jsonText);
    return json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || null;
}

async function fetchProfileData(uniqueId) {
    if (!/^[\w\d_.-]+$/.test(uniqueId)) return null;
    const url = `https://www.tiktok.com/@${uniqueId}`;
    const res = await fetch(url, { headers: commonHeaders() });
    const html = await res.text();
    const jsonText = extractJsonFromScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const json = JSON.parse(jsonText);
    return json?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo || null;
}

function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value) return value;
        if (Array.isArray(value)) {
            const found = value.find(item => typeof item === 'string' && item);
            if (found) return found;
        }
    }
    return '';
}

function pickCoverUrl(data) {
    return pickFirstString(
        data?.video?.cover,
        data?.video?.originCover,
        data?.video?.dynamicCover,
        data?.video?.animatedCover,
        data?.author?.avatarMedium,
        data?.author?.avatarLarger,
        data?.author?.avatarThumb
    );
}

function pickImageUrls(data) {
    const images = data?.imagePost?.images;
    if (!Array.isArray(images)) return [];
    return images
        .map(image => pickFirstString(image?.imageURL?.urlList, image?.imageURL?.urlPrefix, image?.imageURL?.uri))
        .filter(Boolean);
}

function pickVideoUrl(data, hq) {
    const video = data?.video;
    if (!video) return '';
    if (hq) {
        const h265 = video.bitrateInfo?.find(item => String(item?.CodecType || '').includes('h265'));
        const h265Url = pickFirstString(h265?.PlayAddr?.UrlList, h265?.PlayAddr?.UrlList?.[0]);
        if (h265Url) return h265Url;
    }
    return pickFirstString(
        video.PlayAddrStruct?.UrlList,
        video.playAddr,
        video.downloadAddr,
        video.bitrateInfo?.[0]?.PlayAddr?.UrlList
    );
}

async function resolveDirectMediaUrl(mediaUrl) {
    if (!mediaUrl) return '';
    try {
        const res = await fetch(mediaUrl, {
            headers: {
                ...commonHeaders(),
                Accept: '*/*',
            },
            redirect: 'manual',
        });
        if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
            return res.headers?.get?.('Location') || res.headers?.get?.('location') || mediaUrl;
        }
    } catch (err) {
        console.log(err);
    }
    return mediaUrl;
}

function buildStatsLine(data, lang) {
    const stats = data?.stats || {};
    return [
        `${formatNumber(stats.playCount)} ${tr(STR.statsPlays, lang)}`,
        `${formatNumber(stats.diggCount)} ${tr(STR.statsLikes, lang)}`,
        `${formatNumber(stats.commentCount)} ${tr(STR.statsComments, lang)}`,
        `${formatNumber(stats.shareCount)} ${tr(STR.statsShares, lang)}`,
    ].join(' | ');
}

function buildButtons(lang, includeMediaButton) {
    const components = [];
    if (includeMediaButton) {
        components.push({
            type: ComponentType.ActionRow,
            components: [
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel(tr(STR.showMediaAsAttachmentsButton, lang))
                    .setCustomId('showMediaAsAttachments'),
            ],
        });
    }
    components.push({
        type: ComponentType.ActionRow,
        components: [
            new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel(tr(STR.translateButton, lang))
                .setCustomId('translate'),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Danger)
                .setLabel(tr(STR.deleteButton, lang))
                .setCustomId('delete:tiktok'),
        ],
    });
    return components;
}

function buildBaseEmbed(data, canonicalUrl, lang, requesterName) {
    const authorName = data?.author?.nickname || data?.author?.uniqueId || 'TikTok';
    const uniqueId = data?.author?.uniqueId;
    const title = uniqueId ? `${authorName} (@${uniqueId})` : (authorName || tr(STR.fallbackTitle, lang));
    const descriptionParts = [
        truncate(data?.desc || '', MAX_DESCRIPTION_LENGTH),
        buildStatsLine(data, lang),
    ].filter(Boolean);

    /** @type {any} */
    const embed = {
        title,
        url: canonicalUrl,
        description: descriptionParts.join('\n\n'),
        color: EMBED_COLOR,
        author: {
            name: uniqueId ? `@${uniqueId}` : 'TikTok',
            url: uniqueId ? `https://www.tiktok.com/@${uniqueId}` : undefined,
            icon_url: pickFirstString(data?.author?.avatarMedium, data?.author?.avatarThumb),
        },
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - TikTok` },
        timestamp: data?.createTime ? new Date(Number(data.createTime) * 1000) : undefined,
    };

    return embed;
}

function buildProfileEmbed(profile, canonicalUrl, lang, requesterName) {
    const user = profile?.user || {};
    const stats = profile?.stats || {};
    const uniqueId = user.uniqueId || canonicalUrl.split('/@')[1] || '';
    const nickname = user.nickname || uniqueId || tr(STR.fallbackProfileTitle, lang);
    const avatarUrl = pickFirstString(user.avatarMedium, user.avatarLarger, user.avatarThumb);
    const fields = [
        { name: tr(STR.profileFollowers, lang), value: formatNumber(stats.followerCount), inline: true },
        { name: tr(STR.profileFollowing, lang), value: formatNumber(stats.followingCount), inline: true },
        { name: tr(STR.profileLikes, lang), value: formatNumber(stats.heartCount), inline: true },
        { name: tr(STR.profileVideos, lang), value: formatNumber(stats.videoCount), inline: true },
    ];

    /** @type {any} */
    const embed = {
        title: uniqueId ? `${nickname} (@${uniqueId})` : nickname,
        url: canonicalUrl,
        description: truncate(user.signature || '', MAX_DESCRIPTION_LENGTH),
        color: EMBED_COLOR,
        author: {
            name: uniqueId ? `@${uniqueId}` : 'TikTok',
            url: canonicalUrl,
            icon_url: avatarUrl || undefined,
        },
        thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
        fields,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - TikTok` },
    };

    return embed;
}

function isPhotoPost(data) {
    return Array.isArray(data?.imagePost?.images) && data.imagePost.images.length > 0;
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const guildId = message.guild.id;
    const guildLang = s.defaultLanguage ?? settings.defaultLanguage[guildId] ?? 'en';
    const lang = guildLang === 'ja' ? 'ja' : 'en';

    let resolved;
    let data;
    try {
        resolved = await resolveTikTokUrl(url);
        if (!resolved?.id) return null;
        data = resolved.kind === 'profile'
            ? await fetchProfileData(resolved.id)
            : await fetchVideoData(resolved.id);
    } catch (err) {
        console.log(err);
        return null;
    }

    if (!data) return null;

    const isAnon = s.anonymous_expand === true;
    const requesterName = isAnon
        ? tr(STR.anonRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;

    if (resolved.kind === 'profile') {
        const profileUniqueId = data?.user?.uniqueId || resolved.id;
        const canonicalUrl = `https://www.tiktok.com/@${profileUniqueId}`;
        /** @type {import('../_types').SendStep} */
        const step = {
            embeds: [buildProfileEmbed(data, canonicalUrl, lang, requesterName)],
            components: buildButtons(lang, false),
            allowedMentions: { repliedUser: false },
            send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
            suppressSourceEmbeds: true,
        };

        if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
            step.deleteSource = true;
        }

        return [step];
    }

    const canonicalUrl = data?.author?.uniqueId
        ? `https://www.tiktok.com/@${data.author.uniqueId}/${isPhotoPost(data) ? 'photo' : 'video'}/${data.id || resolved.id}`
        : resolved.canonicalUrl;

    const baseEmbed = buildBaseEmbed(data, canonicalUrl, lang, requesterName);
    const embeds = [];
    const files = [];

    if (isPhotoPost(data)) {
        const images = pickImageUrls(data).slice(0, MAX_IMAGES_PER_MESSAGE);
        images.forEach((imageUrl, idx) => {
            const groupIdx = Math.floor(idx / IMAGES_PER_GROUP);
            const groupUrl = groupIdx === 0 ? canonicalUrl : `${canonicalUrl}#g${groupIdx}`;
            if (idx === 0) {
                baseEmbed.url = groupUrl;
                baseEmbed.image = { url: imageUrl };
                if (images.length > 1) {
                    baseEmbed.fields = [
                        { name: tr(STR.imagesField, lang), value: `${images.length} / ${pickImageUrls(data).length}`, inline: true },
                    ];
                }
                embeds.push(baseEmbed);
            } else {
                embeds.push({ url: groupUrl, image: { url: imageUrl }, color: EMBED_COLOR });
            }
        });
    } else {
        const hq = s.tiktok_hq === true;
        const videoUrl = await resolveDirectMediaUrl(pickVideoUrl(data, hq));
        if (videoUrl) files.push(videoUrl);
        const cover = pickCoverUrl(data);
        if (cover) baseEmbed.thumbnail = { url: cover };
        embeds.push(baseEmbed);
    }

    if (embeds.length === 0) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds,
        files,
        components: buildButtons(lang, isPhotoPost(data)),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
    };

    if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
        step.deleteSource = true;
    }

    return [step];
}

/** @type {import('../_types').Provider} */
const tiktokProvider = {
    id: 'tiktok',
    enabledByDefault: false,
    urlPattern: TIKTOK_URL_PATTERN,
    extract,
};

module.exports = tiktokProvider;
module.exports._internal = {
    parseTikTokUrl,
    resolveTikTokUrl,
    extractJsonFromScript,
    pickImageUrls,
    pickVideoUrl,
    formatNumber,
};
