'use strict';

// Discord embeds, controls, and SendStep construction from normalized metadata.
const { ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { applyMediaDisplayToStep, shouldShowOutputItem } = require('../_output_controls');
const { absoluteUrl, pickThumbnail, videoUrl, channelUrl } = require('./youtubeSourceParser');
const {
    DESCRIPTION_MAX_LENGTH,
    STR,
    tr,
    normalizeLang,
    truncate,
    truncateYouTubeDescription,
    showYouTubeStats,
    resolveYouTubeVideoListLimit,
    formatNumber,
    videoDuration,
    publishedText,
    videoType,
} = require('./format');

const EMBED_COLOR = 0xff0000;

const FIELD_MAX_LENGTH = 1024;

const YOUTUBE_ICON = 'https://www.youtube.com/s/desktop/3748dff5/img/favicon_144x144.png';

function requesterFooter(message, lang, anonymous) {
    const requester = anonymous
        ? tr(STR.anonymousRequester, lang)
        : `${message.author?.username ?? message.user?.username}(id:${message.author?.id ?? message.user?.id})`;
    return `${tr(STR.requesterPrefix, lang)}${requester} · YouTube`;
}

function addField(fields, name, value, inline = true) {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: truncate(String(value), FIELD_MAX_LENGTH), inline });
}

function buildVideoEmbed(info, parsed, baseUrl, message, s) {
    const lang = normalizeLang(s);
    const thumbnail = pickThumbnail(info.videoThumbnails, baseUrl);
    const authorUrl = channelUrl(info.authorUrl, info.authorId);
    const fields = [];
    if (showYouTubeStats(s)) {
        addField(fields, tr(STR.views, lang), formatNumber(info.viewCount));
        addField(fields, tr(STR.likes, lang), formatNumber(info.likeCount));
        addField(fields, tr(STR.subscribers, lang), info.subCountText);
    }
    if (shouldShowOutputItem(s, 'type')) addField(fields, tr(STR.type, lang), videoType(info, parsed, lang));
    if (shouldShowOutputItem(s, 'duration')) addField(fields, tr(STR.duration, lang), videoDuration(info));
    if (shouldShowOutputItem(s, 'uploaded')) addField(fields, tr(STR.uploaded, lang), publishedText(info, lang));

    const titlePrefix = info.liveNow ? `${tr(STR.liveNow, lang)} · ` : '';
    const description = truncateYouTubeDescription(info.description, s);
    const requester = requesterFooter(message, lang, s?.anonymous_expand === true);
    const embed = {
        author: {
            name: info.author || tr(STR.video, lang),
            url: authorUrl,
            icon_url: pickThumbnail(info.authorThumbnails, baseUrl) || undefined,
        },
        title: titlePrefix + (info.title || parsed.id),
        url: parsed.originalUrl || videoUrl(parsed.id),
        description: description || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requester, icon_url: YOUTUBE_ICON },
    };
    if (thumbnail) embed.image = { url: thumbnail };
    return embed;
}

function buildPlaylistDescription(info, lang, s) {
    const lines = [];
    const description = truncateYouTubeDescription(info.description, s);
    if (description) lines.push(description);

    const limit = resolveYouTubeVideoListLimit(s);
    const videos = limit > 0 && Array.isArray(info.videos)
        ? info.videos.filter(v => v?.title && v.title !== '[Private video]').slice(0, limit)
        : [];
    if (videos.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`${tr(STR.videos, lang)}:`);
        videos.forEach((video, index) => lines.push(`${index + 1}. ${video.title}`));
    }

    return truncate(lines.join('\n'), DESCRIPTION_MAX_LENGTH);
}

function buildPlaylistEmbed(info, parsed, baseUrl, message, s) {
    const lang = normalizeLang(s);
    const fields = [];
    addField(fields, tr(STR.channel, lang), info.author ? `[${info.author}](${channelUrl(info.authorUrl, info.authorId)})` : null);
    if (showYouTubeStats(s)) {
        addField(fields, tr(STR.views, lang), formatNumber(info.viewCount));
        addField(fields, tr(STR.videos, lang), formatNumber(info.videoCount));
    }
    if (info.updated) addField(fields, tr(STR.updated, lang), `<t:${Number(info.updated)}:d>`);

    const embed = {
        author: { name: tr(STR.playlist, lang), icon_url: YOUTUBE_ICON },
        title: info.title || parsed.id,
        url: parsed.originalUrl || `https://www.youtube.com/playlist?list=${parsed.id}`,
        description: buildPlaylistDescription(info, lang, s) || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requesterFooter(message, lang, s?.anonymous_expand === true), icon_url: YOUTUBE_ICON },
    };

    const thumbnail = absoluteUrl(info.playlistThumbnail, baseUrl)
        || pickThumbnail(info.videos?.[0]?.videoThumbnails, baseUrl);
    if (thumbnail) embed.image = { url: thumbnail };
    return embed;
}

function buildChannelDescription(info, lang, s) {
    const lines = [];
    const description = truncateYouTubeDescription(info.descriptionHtml || info.description, s);
    if (description) lines.push(description);

    const limit = resolveYouTubeVideoListLimit(s);
    const videos = limit > 0 && Array.isArray(info.latestVideos)
        ? info.latestVideos.filter(v => v?.title && v.title !== '[Private video]').slice(0, limit)
        : [];
    if (videos.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`${tr(STR.latestVideos, lang)}:`);
        videos.forEach((video, index) => lines.push(`${index + 1}. ${video.title}`));
    }

    return truncate(lines.join('\n'), DESCRIPTION_MAX_LENGTH);
}

function buildChannelEmbed(info, parsed, baseUrl, message, s) {
    const lang = normalizeLang(s);
    const fields = [];
    if (showYouTubeStats(s)) {
        addField(fields, tr(STR.subscribers, lang), formatNumber(info.subCount));
        addField(fields, tr(STR.views, lang), formatNumber(info.totalViews));
    }

    const url = channelUrl(info.authorUrl, info.authorId || parsed.id);
    const embed = {
        author: { name: tr(STR.channel, lang), icon_url: YOUTUBE_ICON },
        title: `${info.author || parsed.id}${info.authorVerified ? ' ✓' : ''}`,
        url,
        description: buildChannelDescription(info, lang, s) || undefined,
        color: EMBED_COLOR,
        fields,
        footer: { text: requesterFooter(message, lang, s?.anonymous_expand === true), icon_url: YOUTUBE_ICON },
    };

    const thumbnail = pickThumbnail(info.authorThumbnails, baseUrl);
    if (thumbnail) embed.thumbnail = { url: thumbnail };
    const banner = pickThumbnail(info.authorBanners, baseUrl);
    if (banner) embed.image = { url: banner };
    return embed;
}

function createStepBuilder(youtubeDownloadStore) {
    function buildComponents(lang, includeDownload) {
        const components = [
            new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(tr(STR.translateButton, lang)).setCustomId('translate'),
        ];
        if (includeDownload && youtubeDownloadStore.isDownloadButtonEnabled()) {
            components.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Download').setCustomId('downloadYouTubeVideo'));
        }
        components.push(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(tr(STR.deleteButton, lang)).setCustomId('delete:youtube'));

        return [{ type: ComponentType.ActionRow, components }];
    }

    function buildStep(embed, message, url, s, lang, includeDownload = false, analytics = null) {
        /** @type {import('../_types').SendStep} */
        const step = {
            embeds: [embed],
            components: buildComponents(lang, includeDownload),
            allowedMentions: { repliedUser: false },
            send: s.alwaysreplyifpostedtweetlink === true ? 'reply-source' : 'channel',
            suppressSourceEmbeds: true,
            analytics,
        };

        if (s.deletemessageifonlypostedtweetlink === true && message.content.trim() === url) {
            step.deleteSource = true;
        }
        return applyMediaDisplayToStep(step, s, null, 'Thumbnail');
    }

    return buildStep;
}

module.exports = {
    buildVideoEmbed,
    buildPlaylistEmbed,
    buildChannelEmbed,
    createStepBuilder,
};
