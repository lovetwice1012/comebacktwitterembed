'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { recordProviderError } = require('../../errorTracking');
const { settings } = require('../../settings');
const { createProviderAnalytics, facet, tagFacets } = require('../../analytics/providerMetrics');
const {
    applyEmbedMedia,
    attachmentMediaUrls,
    buildFailureResponse,
    mediaButtonAllowed,
    mediaLinksContent,
    resolveDensityMaxLength,
    resolveDisplayDensity,
    resolveMediaDisplayMode,
    shouldAttachVideoMedia,
    shouldShowOutputItem,
} = require('../_output_controls');
const { toApiLocaleFamily } = require('../../discordLocales');

const TIKTOK_URL_PATTERN =
    /https?:\/\/(?:(?:www|m|vm|vt)\.)?tiktok\.com\/[^\s<>|]+/g;

const EMBED_COLOR = 0xff0050;
const MAX_DESCRIPTION_LENGTH = 900;
const MAX_IMAGES_PER_MESSAGE = 10;
const TIKTOK_IMAGE_LIMITS = new Set([1, 4, 10]);
const TIKTOK_VIDEO_FALLBACK_MODES = new Set(['video_url', 'thumbnail_only', 'silent']);
const IMAGES_PER_GROUP = 4;
const MAX_VIDEO_UPLOAD_BYTES = 25 * 1024 * 1024;
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
    durationField:                { ja: 'Duration',                  en: 'Duration' },
    musicField:                   { ja: 'Music',                     en: 'Music' },
    hashtagsField:                { ja: 'Hashtags',                  en: 'Hashtags' },
    profileStatusField:           { ja: 'Status',                    en: 'Status' },
    verifiedStatus:               { ja: 'Verified',                  en: 'Verified' },
    websiteField:                 { ja: 'Website',                   en: 'Website' },
    fallbackTitle:                { ja: 'TikTok post',               en: 'TikTok post' },
    fallbackProfileTitle:         { ja: 'TikTok profile',            en: 'TikTok profile' },
};

function tr(spec, lang) {
    if (typeof spec === 'string') return spec;
    return spec[lang] ?? spec.en ?? '';
}

function truncate(text, maxLength) {
    const value = String(text ?? '').trim();
    if (maxLength <= 0) return '';
    if (value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
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

function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return '';
    const rounded = Math.round(total);
    const mins = Math.floor(rounded / 60);
    const secs = String(rounded % 60).padStart(2, '0');
    return `${mins}:${secs}`;
}

function addField(fields, name, value, inline = true) {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: String(value), inline });
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

function commonHeaders(userAgent) {
    return {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    };
}

function mediaHeaders() {
    return {
        ...commonHeaders(),
        Accept: '*/*',
        Referer: 'https://www.tiktok.com/',
        Range: 'bytes=0-',
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

function pickStrings(...values) {
    const out = [];
    for (const value of values) {
        if (typeof value === 'string' && value) out.push(value);
        if (Array.isArray(value)) {
            out.push(...value.filter(item => typeof item === 'string' && item));
        }
    }
    return out;
}

function pickFirstString(...values) {
    return pickStrings(...values)[0] || '';
}

function dedupeStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function extensionFromContentType(contentType) {
    if (/webm/i.test(contentType || '')) return 'webm';
    if (/quicktime|mov/i.test(contentType || '')) return 'mov';
    return 'mp4';
}

function isTooLargeResponse(res) {
    const length = Number(res.headers?.get?.('content-length') || 0);
    return Number.isFinite(length) && length > MAX_VIDEO_UPLOAD_BYTES;
}

async function downloadVideoCandidate(url, id) {
    const res = await fetch(url, {
        headers: mediaHeaders(),
        redirect: 'follow',
    });
    if (!res.ok || isTooLargeResponse(res)) return null;

    const attachment = await res.buffer();
    if (!attachment || attachment.length === 0 || attachment.length > MAX_VIDEO_UPLOAD_BYTES) return null;

    const contentType = res.headers?.get?.('content-type') || 'video/mp4';
    return {
        attachment,
        name: `tiktok-${id}.${extensionFromContentType(contentType)}`,
    };
}

async function downloadVideoAttachment(data, hq) {
    const candidates = getVideoUrlCandidates(data, hq);
    for (const candidate of candidates) {
        try {
            const file = await downloadVideoCandidate(candidate, data?.id || 'video');
            if (file) return file;
        } catch (err) {
            console.log(err);
        }
    }
    return null;
}

function getVideoUrlCandidates(data, hq) {
    const video = data?.video;
    if (!video) return [];
    const urls = [];
    if (hq) {
        const h265 = video.bitrateInfo?.filter(item => String(item?.CodecType || '').includes('h265')) || [];
        for (const item of h265) urls.push(...pickStrings(item?.PlayAddr?.UrlList));
    }
    urls.push(...pickStrings(video.PlayAddrStruct?.UrlList, video.playAddr, video.downloadAddr));
    for (const item of video.bitrateInfo || []) {
        urls.push(...pickStrings(item?.PlayAddr?.UrlList));
    }
    return dedupeStrings(urls);
}

function pickVideoUrl(data, hq) {
    return getVideoUrlCandidates(data, hq)[0] || '';
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

function buildStatsLine(data, lang) {
    const stats = data?.stats || {};
    return [
        `${formatNumber(stats.playCount)} ${tr(STR.statsPlays, lang)}`,
        `${formatNumber(stats.diggCount)} ${tr(STR.statsLikes, lang)}`,
        `${formatNumber(stats.commentCount)} ${tr(STR.statsComments, lang)}`,
        `${formatNumber(stats.shareCount)} ${tr(STR.statsShares, lang)}`,
    ].join(' | ');
}

function showTikTokStats(s) {
    return shouldShowOutputItem(s, 'stats');
}

function tiktokDescriptionMaxLength(settings) {
    return resolveDensityMaxLength(settings, 'tiktok_description_max_length', MAX_DESCRIPTION_LENGTH, {
        compact: 200,
        detail: MAX_DESCRIPTION_LENGTH,
        hardMax: MAX_DESCRIPTION_LENGTH,
    });
}

function resolveTikTokImageLimit(settings) {
    const explicit = Number(settings?.tiktok_image_limit);
    if (TIKTOK_IMAGE_LIMITS.has(explicit)) return explicit;
    return resolveDisplayDensity(settings) === 'compact' ? 1 : MAX_IMAGES_PER_MESSAGE;
}

function resolveTikTokVideoFallbackMode(settings) {
    const mode = String(settings?.tiktok_video_fallback_mode || '').trim();
    return TIKTOK_VIDEO_FALLBACK_MODES.has(mode) ? mode : 'video_url';
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

function buildBaseEmbed(data, canonicalUrl, lang, requesterName, s) {
    const authorName = data?.author?.nickname || data?.author?.uniqueId || 'TikTok';
    const uniqueId = data?.author?.uniqueId;
    const title = uniqueId ? `${authorName} (@${uniqueId})` : (authorName || tr(STR.fallbackTitle, lang));
    const descriptionParts = [
        truncate(data?.desc || '', tiktokDescriptionMaxLength(s)),
        showTikTokStats(s) ? buildStatsLine(data, lang) : '',
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

    const fields = [];
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.durationField, lang), formatDuration(data?.video?.duration));
    if (shouldShowOutputItem(s, 'music')) {
        const musicTitle = pickFirstString(data?.music?.title, data?.music?.musicName);
        const author = pickFirstString(data?.music?.authorName, data?.music?.author, data?.music?.ownerHandle);
        addField(fields, tr(STR.musicField, lang), [musicTitle, author].filter(Boolean).join(' - '), false);
    }
    if (shouldShowOutputItem(s, 'tags')) {
        addField(fields, tr(STR.hashtagsField, lang), uniqueTextMatches(data?.desc, /#[\p{L}\p{N}_]+/gu), false);
    }
    if (fields.length > 0) embed.fields = fields;

    return embed;
}

function buildProfileEmbed(profile, canonicalUrl, lang, requesterName, s) {
    const user = profile?.user || {};
    const stats = profile?.stats || {};
    const uniqueId = user.uniqueId || canonicalUrl.split('/@')[1] || '';
    const nickname = user.nickname || uniqueId || tr(STR.fallbackProfileTitle, lang);
    const avatarUrl = pickFirstString(user.avatarMedium, user.avatarLarger, user.avatarThumb);
    const fields = showTikTokStats(s)
        ? [
            { name: tr(STR.profileFollowers, lang), value: formatNumber(stats.followerCount), inline: true },
            { name: tr(STR.profileFollowing, lang), value: formatNumber(stats.followingCount), inline: true },
            { name: tr(STR.profileLikes, lang), value: formatNumber(stats.heartCount), inline: true },
            { name: tr(STR.profileVideos, lang), value: formatNumber(stats.videoCount), inline: true },
        ]
        : [];
    if (shouldShowOutputItem(s, 'profile_status') && user.verified === true) {
        addField(fields, tr(STR.profileStatusField, lang), tr(STR.verifiedStatus, lang));
    }
    const website = pickFirstString(user.bioLink?.link, user.bioLink?.url, user.bioUrl, user.externalUrl);
    if (shouldShowOutputItem(s, 'website') && website) {
        addField(fields, tr(STR.websiteField, lang), `[${tr(STR.websiteField, lang)}](${website})`);
    }

    /** @type {any} */
    const embed = {
        title: uniqueId ? `${nickname} (@${uniqueId})` : nickname,
        url: canonicalUrl,
        description: truncate(user.signature || '', tiktokDescriptionMaxLength(s)),
        color: EMBED_COLOR,
        author: {
            name: uniqueId ? `@${uniqueId}` : 'TikTok',
            url: canonicalUrl,
            icon_url: avatarUrl || undefined,
        },
        thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
        footer: { text: `${tr(STR.requesterPrefix, lang)}${requesterName} - TikTok` },
    };
    if (fields.length > 0) embed.fields = fields;

    return embed;
}

function isPhotoPost(data) {
    return Array.isArray(data?.imagePost?.images) && data.imagePost.images.length > 0;
}

function textTags(text, regex) {
    return [...new Set([...String(text || '').matchAll(regex)].map(match => String(match[1] || match[0]).replace(/^[@#]/, '').toLowerCase()))];
}

function buildTikTokProfileAnalytics(data, canonicalUrl) {
    const user = data?.user || {};
    const stats = data?.stats || {};
    const uniqueId = user.uniqueId || canonicalUrl.split('/@')[1] || '';
    return createProviderAnalytics({
        content: {
            accountKey: uniqueId,
            contentId: uniqueId,
            contentType: 'profile',
            contentUrl: canonicalUrl,
            title: user.nickname || uniqueId,
            descriptionPreview: user.signature,
            authorName: uniqueId,
            mediaCount: 1,
        },
        metrics: {
            followers: stats.followerCount,
            following: stats.followingCount,
            likes: stats.heartCount,
            videos: stats.videoCount,
        },
        facets: [
            facet('verified', user.verified ? 'yes' : 'no'),
        ],
    });
}

function buildTikTokContentAnalytics(data, canonicalUrl, resolved) {
    const stats = data?.stats || {};
    const musicTitle = pickFirstString(data?.music?.title, data?.music?.musicName);
    const musicAuthor = pickFirstString(data?.music?.authorName, data?.music?.author, data?.music?.ownerHandle);
    const photo = isPhotoPost(data);
    return createProviderAnalytics({
        content: {
            accountKey: data?.author?.uniqueId,
            contentId: data?.id || resolved.id,
            contentType: photo ? 'photo' : 'video',
            contentUrl: canonicalUrl,
            title: data?.author?.nickname || data?.author?.uniqueId,
            descriptionPreview: data?.desc,
            authorName: data?.author?.uniqueId,
            publishedAtMs: data?.createTime ? Number(data.createTime) * 1000 : null,
            mediaCount: photo ? data.imagePost.images.length : 1,
            durationSeconds: data?.video?.duration,
        },
        metrics: {
            plays: stats.playCount,
            likes: stats.diggCount,
            comments: stats.commentCount,
            shares: stats.shareCount,
            duration_seconds: data?.video?.duration,
        },
        facets: [
            ...tagFacets('hashtag', textTags(data?.desc, /#([\p{L}\p{N}_]+)/gu)),
            ...tagFacets('mention', textTags(data?.desc, /@([A-Za-z0-9_.-]+)/g)),
            facet('music', [musicTitle, musicAuthor].filter(Boolean).join(' - ')),
            facet('type', photo ? 'photo' : 'video'),
        ],
    });
}

function addImageCountField(embed, shownCount, totalCount, lang, s) {
    if (totalCount <= 1 || !shouldShowOutputItem(s, 'image_count')) return;
    if (!Array.isArray(embed.fields)) embed.fields = [];
    addField(embed.fields, tr(STR.imagesField, lang), `${shownCount} / ${totalCount}`);
}

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};
    const guildId = message.guild.id;
    const guildLang = s.defaultLanguage ?? settings.defaultLanguage[guildId] ?? 'en';
    const lang = toApiLocaleFamily(guildLang);

    let resolved;
    let data;
    try {
        resolved = await resolveTikTokUrl(url);
        if (!resolved?.id) return null;
        data = resolved.kind === 'profile'
            ? await fetchProfileData(resolved.id)
            : await fetchVideoData(resolved.id);
    } catch (err) {
        recordProviderError('tiktok', err, message, url, { endpointKey: 'tiktok/webapp' });
        console.log(err);
        return buildFailureResponse('tiktok', url, s, err);
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
            embeds: [buildProfileEmbed(data, canonicalUrl, lang, requesterName, s)],
            components: buildButtons(lang, false),
            allowedMentions: { repliedUser: false },
            send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
            suppressSourceEmbeds: true,
            analytics: buildTikTokProfileAnalytics(data, canonicalUrl),
        };

        if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
            step.deleteSource = true;
        }

        return [step];
    }

    const canonicalUrl = data?.author?.uniqueId
        ? `https://www.tiktok.com/@${data.author.uniqueId}/${isPhotoPost(data) ? 'photo' : 'video'}/${data.id || resolved.id}`
        : resolved.canonicalUrl;

    const baseEmbed = buildBaseEmbed(data, canonicalUrl, lang, requesterName, s);
    const embeds = [];
    const files = [];
    let mediaContent = '';

    if (isPhotoPost(data)) {
        const allImages = pickImageUrls(data);
        const images = allImages.slice(0, resolveTikTokImageLimit(s));
        const mode = resolveMediaDisplayMode(s);
        if (mode === 'embed') {
            images.forEach((imageUrl, idx) => {
                const groupIdx = Math.floor(idx / IMAGES_PER_GROUP);
                const groupUrl = groupIdx === 0 ? canonicalUrl : `${canonicalUrl}#g${groupIdx}`;
                if (idx === 0) {
                    baseEmbed.url = groupUrl;
                    baseEmbed.image = { url: imageUrl };
                    addImageCountField(baseEmbed, images.length, allImages.length, lang, s);
                    embeds.push(baseEmbed);
                } else {
                    embeds.push({ url: groupUrl, image: { url: imageUrl }, color: EMBED_COLOR });
                }
            });
        } else {
            applyEmbedMedia(baseEmbed, images[0], s, { asThumbnail: true });
            addImageCountField(baseEmbed, images.length, allImages.length, lang, s);
            files.push(...attachmentMediaUrls(s, images));
            mediaContent = mediaLinksContent(s, images, 'Media');
            embeds.push(baseEmbed);
        }
    } else {
        const hq = s.tiktok_hq === true;
        const videoUrl = pickVideoUrl(data, hq);
        let forceThumbnailFallback = false;
        if (shouldAttachVideoMedia(s)) {
            const videoFile = await downloadVideoAttachment(data, hq);
            if (videoFile) files.push(videoFile);
            else {
                const fallbackMode = resolveTikTokVideoFallbackMode(s);
                if (fallbackMode === 'video_url' && videoUrl) mediaContent = `Video: ${videoUrl}`;
                else if (fallbackMode === 'thumbnail_only') forceThumbnailFallback = true;
            }
        } else if (resolveMediaDisplayMode(s) === 'link_only' && videoUrl) {
            mediaContent = `Video: ${videoUrl}`;
        }
        const cover = pickCoverUrl(data);
        if (forceThumbnailFallback && cover) baseEmbed.thumbnail = { url: cover };
        else applyEmbedMedia(baseEmbed, cover, s, { asThumbnail: true });
        embeds.push(baseEmbed);
    }

    if (embeds.length === 0) return null;

    /** @type {import('../_types').SendStep} */
    const step = {
        embeds,
        files,
        components: buildButtons(lang, mediaButtonAllowed(s) && isPhotoPost(data)),
        allowedMentions: { repliedUser: false },
        send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
        suppressSourceEmbeds: true,
        analytics: buildTikTokContentAnalytics(data, canonicalUrl, resolved),
    };
    if (mediaContent) step.content = mediaContent;

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
    settings: [
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'tiktok_hq',
        'display_density',
        'media_display_mode',
        'tiktok_description_max_length',
        'tiktok_image_limit',
        'tiktok_video_fallback_mode',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'duration', label: { en: 'Duration field', ja: 'Duration field' } },
                { value: 'music', label: { en: 'Music field', ja: 'Music field' } },
                { value: 'tags', label: { en: 'Hashtags field', ja: 'Hashtags field' } },
                { value: 'profile_status', label: { en: 'Profile status field', ja: 'Profile status field' } },
                { value: 'website', label: { en: 'Profile website field', ja: 'Profile website field' } },
                { value: 'image_count', label: { en: 'Photo count field', ja: 'Photo count field' } },
                { value: 'stats', label: { en: 'Play/like/comment/share counts', ja: '再生/いいね/コメント/シェア数' } },
            ],
        },
    ],
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
