'use strict';

// Provider-native analytics derived from metadata, independent of visible embed fields.
const { createProviderAnalytics, facet } = require('../../analytics/providerMetrics');
const { videoUrl, channelUrl } = require('./youtubeSourceParser');
const { publishedText } = require('./format');

function buildYouTubeAnalytics(parsed, info, sourceUrl) {
    if (parsed.type === 'video') {
        return createProviderAnalytics({
            content: {
                accountKey: info.authorId || info.author || parsed.id,
                contentId: parsed.id,
                contentType: info.liveNow ? 'live_video' : (parsed.isShorts ? 'shorts' : 'video'),
                contentUrl: parsed.originalUrl || videoUrl(parsed.id),
                title: info.title,
                descriptionPreview: info.description,
                authorName: info.author,
                publishedAtMs: info.published ? Number(info.published) * 1000 : null,
                durationSeconds: info.lengthSeconds,
                mediaCount: 1,
            },
            metrics: {
                views: info.viewCount,
                likes: info.likeCount,
                subscribers: info.subCount,
                duration_seconds: info.lengthSeconds,
            },
            facets: [
                facet('type', info.liveNow ? 'live' : (parsed.isShorts ? 'shorts' : 'video')),
                facet('date_label', publishedText(info, 'en')),
                facet('channel', info.author || info.authorId),
            ],
        });
    }
    if (parsed.type === 'playlist') {
        return createProviderAnalytics({
            content: {
                accountKey: info.authorId || info.author || parsed.id,
                contentId: parsed.id,
                contentType: 'playlist',
                contentUrl: parsed.originalUrl || sourceUrl,
                title: info.title,
                descriptionPreview: info.description,
                authorName: info.author,
                publishedAtMs: info.updated ? Number(info.updated) * 1000 : null,
                mediaCount: Array.isArray(info.videos) ? info.videos.length : null,
            },
            metrics: {
                views: info.viewCount,
                video_count: info.videoCount ?? (Array.isArray(info.videos) ? info.videos.length : null),
            },
            facets: [
                facet('type', 'playlist'),
                facet('channel', info.author || info.authorId),
            ],
        });
    }
    return createProviderAnalytics({
        content: {
            accountKey: info.authorId || info.author || parsed.id,
            contentId: info.authorId || parsed.id,
            contentType: 'channel',
            contentUrl: channelUrl(info.authorUrl, info.authorId || parsed.id),
            title: info.author || parsed.id,
            descriptionPreview: info.descriptionHtml || info.description,
            authorName: info.author,
            mediaCount: Array.isArray(info.latestVideos) ? info.latestVideos.length : null,
        },
        metrics: {
            subscribers: info.subCount,
            views: info.totalViews,
            latest_video_count: Array.isArray(info.latestVideos) ? info.latestVideos.length : null,
        },
        facets: [
            facet('type', 'channel'),
            facet('channel', info.author || info.authorId || parsed.id),
            facet('verified', info.authorVerified ? 'yes' : 'no'),
        ],
    });
}

module.exports = {
    buildYouTubeAnalytics,
};
