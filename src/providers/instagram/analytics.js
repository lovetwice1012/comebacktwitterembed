'use strict';

const { createProviderAnalytics, facet, tagFacets } = require('../../analytics/providerMetrics');

function instagramTextTags(text, regex) {
    return [...new Set([...String(text || '').matchAll(regex)].map(match => String(match[1] || match[0]).replace(/^[@#]/, '').toLowerCase()))];
}

function buildInstagramProfileAnalytics(profile, canonicalUrl) {
    return createProviderAnalytics({
        content: {
            accountKey: profile.username,
            contentId: profile.username,
            contentType: 'profile',
            contentUrl: canonicalUrl,
            title: profile.fullName || profile.username,
            descriptionPreview: profile.biography,
            authorName: profile.username,
            mediaCount: 1,
        },
        metrics: {
            followers: profile.followers,
            following: profile.following,
            posts: profile.posts,
        },
        facets: [
            facet('verified', profile.isVerified ? 'yes' : 'no'),
            facet('private', profile.isPrivate ? 'yes' : 'no'),
            facet('has_external_url', profile.externalUrl ? 'yes' : 'no'),
        ],
    });
}

function buildInstagramMediaAnalytics(data, canonicalUrl, selected, parsed) {
    return createProviderAnalytics({
        content: {
            accountKey: data.username,
            contentId: data.shortcode || data.id || parsed?.shortcode || parsed?.id,
            contentType: data.videoDuration ? 'video' : 'media',
            contentUrl: canonicalUrl,
            title: data.username ? `@${data.username}` : 'Instagram',
            descriptionPreview: data.caption,
            authorName: data.username,
            publishedAtMs: data.timestamp ? Date.parse(data.timestamp) : null,
            mediaCount: Array.isArray(data.medias) ? data.medias.length : selected.length,
            durationSeconds: data.videoDuration,
        },
        metrics: {
            likes: data.likeCount,
            comments: data.commentCount,
            views: data.viewCount || data.playCount,
            followers: data.ownerFollowers,
            media: Array.isArray(data.medias) ? data.medias.length : selected.length,
            duration_seconds: data.videoDuration,
        },
        facets: [
            ...tagFacets('hashtag', instagramTextTags(data.caption, /#([\p{L}\p{N}_]+)/gu)),
            ...tagFacets('mention', instagramTextTags(data.caption, /@([A-Za-z0-9._]+)/g)),
            facet('type', data.videoDuration ? 'video' : 'image'),
            facet('location', data.locationName),
            facet('audio', [data.audioTitle, data.audioArtist].filter(Boolean).join(' - ')),
        ],
    });
}

module.exports = {
    buildInstagramProfileAnalytics,
    buildInstagramMediaAnalytics,
};
