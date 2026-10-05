'use strict';

// Provider registration and extraction orchestration.
const fetch = require('../../providerFetch').withDeadline(require('node-fetch'));
const { recordProviderError } = require('../../errorTracking');
const youtubeDownloadStore = require('../../youtubeDownloadStore');
const { buildFailureResponse } = require('../_output_controls');
const { YOUTUBE_URL_PATTERN, parseYouTubeUrl, stripTracking } = require('./youtubeSourceParser');
const { normalizeLang } = require('./format');
const { parseInitialData, parseInitialPlayerResponse } = require('./youtubeSourceParser');
const {
    buildVideoEmbed,
    buildPlaylistEmbed,
    buildChannelEmbed,
    createStepBuilder,
} = require('./presentation');
const { buildYouTubeAnalytics } = require('./analytics');
const { createYouTubeClient } = require('./client');

const {
    fetchVideoInfoWithFallback,
    fetchPlaylistInfoWithFallback,
    fetchChannelInfoWithFallback,
    fetchVideoInfoFromYouTubePage,
    fetchVideoInfoFromOEmbed,
    fetchPlaylistInfoFromYouTubePage,
    fetchChannelInfoFromYouTubePage,
} = createYouTubeClient(fetch);
const buildStep = createStepBuilder(youtubeDownloadStore);

/** @type {import('../_types').Extractor} */
async function extract(message, url, s) {
    s = s || {};

    const parsed = parseYouTubeUrl(url);
    if (!parsed) return null;

    try {
        const lang = normalizeLang(s);
        let embed;
        if (parsed.type === 'video') {
            const { json, baseUrl } = await fetchVideoInfoWithFallback(parsed.id);
            if (!json || json.error) return null;
            embed = buildVideoEmbed(json, parsed, baseUrl, message, s);
            return [buildStep(embed, message, url, s, lang, true, buildYouTubeAnalytics(parsed, json, url))];
        } else if (parsed.type === 'playlist') {
            const { json, baseUrl } = await fetchPlaylistInfoWithFallback(parsed.id);
            if (!json || json.error) return null;
            embed = buildPlaylistEmbed(json, parsed, baseUrl, message, s);
            return [buildStep(embed, message, url, s, lang, false, buildYouTubeAnalytics(parsed, json, url))];
        } else if (parsed.type === 'channel') {
            const result = await fetchChannelInfoWithFallback(parsed.id, parsed.resolved);
            if (!result || !result.json || result.json.error) return null;
            embed = buildChannelEmbed(result.json, parsed, result.baseUrl, message, s);
            return [buildStep(embed, message, url, s, lang, false, buildYouTubeAnalytics(parsed, result.json, url))];
        } else {
            return null;
        }
    } catch (err) {
        recordProviderError('youtube', err, message, url, { endpointKey: 'invidious/api' });
        return buildFailureResponse('youtube', url, s, err);
    }
}

/** @type {import('../_types').Provider} */
const youtubeProvider = {
    id: 'youtube',
    enabledByDefault: false,
    urlPattern: new RegExp(YOUTUBE_URL_PATTERN.source, YOUTUBE_URL_PATTERN.flags),
    settings: [
        'anonymous_expand',
        'alwaysreplyifpostedtweetlink',
        'deletemessageifonlypostedtweetlink',
        'display_density',
        'media_display_mode',
        'youtube_video_list_limit',
        'youtube_description_max_length',
        {
            key: 'hidden_output_items',
            outputItems: [
                { value: 'duration', label: { en: 'Duration field', ja: 'Duration field' } },
                { value: 'type', label: { en: 'Video type field', ja: 'Video type field' } },
                { value: 'uploaded', label: { en: 'Uploaded field', ja: 'Uploaded field' } },
                { value: 'stats', label: { en: 'View/like/subscriber counts', ja: '再生数/高評価/登録者数' } },
                { value: 'video_list', label: { en: 'Playlist/channel video list', ja: 'プレイリスト/チャンネルの動画リスト' } },
            ],
        },
    ],
    extract,
};

module.exports = youtubeProvider;
module.exports._internal = {
    buildChannelEmbed,
    buildPlaylistEmbed,
    buildVideoEmbed,
    fetchVideoInfoFromOEmbed,
    fetchVideoInfoFromYouTubePage,
    fetchChannelInfoFromYouTubePage,
    fetchPlaylistInfoFromYouTubePage,
    parseYouTubeUrl,
    parseInitialData,
    parseInitialPlayerResponse,
    stripTracking,
};
