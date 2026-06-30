'use strict';

const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { isOutputHidden } = require('./_output_visibility');

const DISPLAY_DENSITIES = new Set(['compact', 'standard', 'detail']);
const MEDIA_DISPLAY_MODES = new Set(['embed', 'attachment', 'thumbnail_only', 'link_only']);
const FAILURE_DISPLAY_POLICIES = new Set(['silent', 'source_link', 'error_summary']);
const MEDIA_SWITCH_BUTTON_IDS = new Set(['showMediaAsAttachments', 'showAttachmentsAsEmbedsImage']);
const COMPACT_HIDDEN_ITEMS = new Set([
    'artist',
    'audio',
    'availability',
    'album',
    'assets',
    'assignees',
    'author',
    'brand',
    'category',
    'changes',
    'cast',
    'clipped_by',
    'comments',
    'commits',
    'contributions',
    'coupon',
    'current_players',
    'default_branch',
    'developer',
    'discount',
    'duration',
    'date',
    'deal',
    'explicit',
    'files',
    'followers',
    'game',
    'genre',
    'genres',
    'gist_files',
    'hashtags',
    'id',
    'image_count',
    'language',
    'language_breakdown',
    'last_push',
    'likes',
    'license',
    'labels',
    'location',
    'maturity',
    'media_count',
    'media_range',
    'media_type',
    'metacritic',
    'mergeable',
    'mylists',
    'mentions',
    'music',
    'pages',
    'platforms',
    'preview',
    'price',
    'price_range',
    'profile_status',
    'profile_counts',
    'publisher',
    'rating',
    'recommendations',
    'repo_stats',
    'repositories',
    'review_state',
    'review_count',
    'review_summary',
    'release_date',
    'sale_ends',
    'sale_period',
    'seller',
    'season',
    'series',
    'started',
    'stats',
    'status',
    'sha',
    'shipping',
    'size',
    'snippet',
    'state',
    'tags',
    'top_tracks',
    'total_duration',
    'topics',
    'track_number',
    'tracks',
    'type',
    'uploader',
    'uploaded',
    'variations',
    'viewers',
    'views',
    'website',
    'year',
]);

function resolveMaxLength(settings, key, fallback, hardMax = fallback) {
    const raw = settings?.[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.min(hardMax, Math.round(value)));
}

function resolveChoice(settings, key, allowed, fallback) {
    const value = String(settings?.[key] ?? '').trim();
    return allowed.has(value) ? value : fallback;
}

function resolveDisplayDensity(settings) {
    return resolveChoice(settings, 'display_density', DISPLAY_DENSITIES, 'standard');
}

function resolveMediaDisplayMode(settings) {
    return resolveChoice(settings, 'media_display_mode', MEDIA_DISPLAY_MODES, 'embed');
}

function resolveFailureDisplayPolicy(settings) {
    return resolveChoice(settings, 'failure_display_policy', FAILURE_DISPLAY_POLICIES, 'silent');
}

function resolveDensityMaxLength(settings, key, fallback, options = {}) {
    const raw = settings?.[key];
    if (raw !== undefined && raw !== null && raw !== '') {
        return resolveMaxLength(settings, key, fallback, options.hardMax ?? fallback);
    }

    const density = resolveDisplayDensity(settings);
    const hardMax = options.hardMax ?? options.detail ?? fallback;
    if (density === 'compact') return Math.max(0, Math.min(hardMax, options.compact ?? Math.min(fallback, 200)));
    if (density === 'detail') return Math.max(0, Math.min(hardMax, options.detail ?? fallback));
    return Math.max(0, Math.min(hardMax, fallback));
}

function isCompactDisplay(settings) {
    return resolveDisplayDensity(settings) === 'compact';
}

function isDetailDisplay(settings) {
    return resolveDisplayDensity(settings) === 'detail';
}

function shouldShowOutputItem(settings, key, options = {}) {
    if (isOutputHidden(settings, key)) return false;
    if (options.detailOnly === true && !isDetailDisplay(settings)) return false;
    const hideInCompact = options.hideInCompact ?? COMPACT_HIDDEN_ITEMS.has(key);
    if (hideInCompact && isCompactDisplay(settings)) return false;
    return true;
}

function cleanMediaUrls(urls) {
    const values = Array.isArray(urls) ? urls : [urls];
    return values
        .map(url => (typeof url === 'string' ? url.trim() : ''))
        .filter(Boolean);
}

function applyEmbedMedia(embed, url, settings, options = {}) {
    const mediaUrl = cleanMediaUrls(url)[0];
    if (!embed || !mediaUrl) return false;

    const mode = resolveMediaDisplayMode(settings);
    if (mode === 'embed') {
        if (options.asThumbnail === true) embed.thumbnail = { url: mediaUrl };
        else embed.image = { url: mediaUrl };
        return true;
    }
    if (mode === 'thumbnail_only') {
        embed.thumbnail = { url: mediaUrl };
        return true;
    }
    return false;
}

/**
 * @returns {Array<string|import('./_types').FilePayload>}
 */
function attachmentMediaUrls(settings, urls) {
    return resolveMediaDisplayMode(settings) === 'attachment' ? cleanMediaUrls(urls) : [];
}

function mediaButtonAllowed(settings) {
    return resolveMediaDisplayMode(settings) === 'embed';
}

function mediaLinksContent(settings, urls, label = 'Media') {
    const mediaUrls = cleanMediaUrls(urls);
    if (resolveMediaDisplayMode(settings) !== 'link_only' || mediaUrls.length === 0) return '';
    return mediaUrls
        .map((url, index) => `${label}${mediaUrls.length > 1 ? ` ${index + 1}` : ''}: ${url}`)
        .join('\n');
}

function shouldAttachVideoMedia(settings) {
    const mode = resolveMediaDisplayMode(settings);
    return mode === 'embed' || mode === 'attachment';
}

function buttonCustomId(component) {
    return component?.data?.custom_id || component?.custom_id || '';
}

function removeMediaSwitchButtons(components) {
    if (!Array.isArray(components)) return components;
    return components
        .map(row => {
            if (!Array.isArray(row?.components)) return row;
            const filtered = row.components.filter(component => !MEDIA_SWITCH_BUTTON_IDS.has(buttonCustomId(component)));
            return filtered.length === row.components.length ? row : { ...row, components: filtered };
        })
        .filter(row => !Array.isArray(row?.components) || row.components.length > 0);
}

function embeddedMediaUrls(embeds) {
    if (!Array.isArray(embeds)) return [];
    const urls = [];
    for (const embed of embeds) {
        if (embed?.image?.url) urls.push(embed.image.url);
        if (embed?.thumbnail?.url) urls.push(embed.thumbnail.url);
    }
    return cleanMediaUrls(urls);
}

function clearEmbedMedia(embeds) {
    if (!Array.isArray(embeds)) return;
    for (const embed of embeds) {
        if (!embed || typeof embed !== 'object') continue;
        delete embed.image;
        delete embed.thumbnail;
    }
}

function moveEmbedImagesToThumbnails(embeds, urls) {
    if (!Array.isArray(embeds) || embeds.length === 0) return;
    for (const embed of embeds) {
        if (!embed || typeof embed !== 'object') continue;
        if (embed.image?.url) {
            embed.thumbnail = { url: embed.image.url };
            delete embed.image;
        }
    }
    const firstUrl = cleanMediaUrls(urls)[0];
    if (firstUrl && !embeds[0].thumbnail) embeds[0].thumbnail = { url: firstUrl };
}

function appendStepContent(step, content) {
    if (!content) return;
    step.content = [step.content, content].filter(Boolean).join('\n');
}

function fileKey(file) {
    if (typeof file === 'string') return file;
    return file?.attachment || file?.url || file?.fallbackUrl || '';
}

function appendUniqueFiles(existingFiles, mediaUrls) {
    const files = Array.isArray(existingFiles) ? [...existingFiles] : [];
    const seen = new Set(files.map(fileKey).filter(Boolean));
    for (const url of mediaUrls) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        files.push(url);
    }
    return files;
}

function removeMediaFiles(existingFiles, mediaUrls) {
    if (!Array.isArray(existingFiles) || mediaUrls.length === 0) return existingFiles;
    const mediaSet = new Set(mediaUrls);
    const files = existingFiles.filter(file => !mediaSet.has(fileKey(file)));
    return files.length > 0 ? files : undefined;
}

function applyMediaDisplayToStep(step, settings, urls, label = 'Media') {
    if (!step || typeof step !== 'object') return step;
    const mode = resolveMediaDisplayMode(settings);
    const mediaUrls = cleanMediaUrls(urls && cleanMediaUrls(urls).length > 0 ? urls : embeddedMediaUrls(step.embeds));

    if (mode === 'embed') return step;

    step.components = removeMediaSwitchButtons(step.components);

    if (mode === 'thumbnail_only') {
        moveEmbedImagesToThumbnails(step.embeds, mediaUrls);
        step.files = removeMediaFiles(step.files, mediaUrls);
        return step;
    }

    clearEmbedMedia(step.embeds);

    if (mode === 'attachment') {
        if (mediaUrls.length > 0) step.files = appendUniqueFiles(step.files, mediaUrls);
        return step;
    }

    step.files = removeMediaFiles(step.files, mediaUrls);
    appendStepContent(step, mediaLinksContent(settings, mediaUrls, label));
    return step;
}

function failureMessage(providerId, err, settings) {
    const lang = settings?.defaultLanguage === 'ja' ? 'ja' : 'en';
    const raw = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
    const summary = raw ? raw.slice(0, 180) : 'unknown error';
    if (lang === 'ja') return `${providerId} metadata fetch failed: ${summary}`;
    return `${providerId} metadata fetch failed: ${summary}`;
}

function sourceLinkButton(url, settings) {
    const lang = settings?.defaultLanguage === 'ja' ? 'ja' : 'en';
    return {
        type: ComponentType.ActionRow,
        components: [
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel(lang === 'ja' ? 'Open source link' : 'Open source link')
                .setURL(url),
        ],
    };
}

/**
 * @returns {import('./_types').SendStep[] | null}
 */
function buildFailureResponse(providerId, url, settings, err = null) {
    const policy = resolveFailureDisplayPolicy(settings);
    if (policy === 'silent') return null;

    /** @type {import('./_types').SendStep} */
    const step = {
        allowedMentions: { repliedUser: false },
        components: [sourceLinkButton(url, settings)],
        send: settings?.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
    };

    if (policy === 'source_link') {
        step.content = settings?.defaultLanguage === 'ja' ? 'Source link' : 'Source link';
    } else {
        step.content = failureMessage(providerId, err, settings);
    }
    return [step];
}

module.exports = {
    applyEmbedMedia,
    applyMediaDisplayToStep,
    attachmentMediaUrls,
    buildFailureResponse,
    cleanMediaUrls,
    isCompactDisplay,
    isDetailDisplay,
    mediaButtonAllowed,
    mediaLinksContent,
    resolveDensityMaxLength,
    resolveDisplayDensity,
    resolveFailureDisplayPolicy,
    resolveMaxLength,
    resolveMediaDisplayMode,
    shouldAttachVideoMedia,
    shouldShowOutputItem,
};
