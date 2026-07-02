'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providerDir = path.join(__dirname, '..', '..', 'src', 'providers');
const adminDataPath = path.join(__dirname, '..', '..', 'dashboard', 'lib', 'admin-data.ts');
const expectedProviders = [
    'amazon',
    'booth',
    'github',
    'instagram',
    'niconico',
    'pixiv',
    'spotify',
    'steam',
    'tiktok',
    'twitch',
    'twitter',
    'youtube',
];

test('all production providers attach native analytics metadata', () => {
    const dirs = fs.readdirSync(providerDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
        .map(entry => entry.name)
        .filter(name => fs.existsSync(path.join(providerDir, name, 'index.js')))
        .sort();

    assert.deepEqual(dirs, expectedProviders);

    for (const provider of dirs) {
        const source = fs.readFileSync(path.join(providerDir, provider, 'index.js'), 'utf8');
        assert.match(source, /analytics\/providerMetrics/, `${provider} must import providerMetrics`);
        assert.match(source, /\bcreateProviderAnalytics\b/, `${provider} must build native analytics`);
        assert.match(source, /\banalytics\s*(?::|,)/, `${provider} must attach analytics to a SendStep`);
    }
});

test('provider content analytics no longer exposes embed-field metric extraction', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'analytics', 'providerContent.js'), 'utf8');
    assert.doesNotMatch(source, /\bproviderFacets\b/);
    assert.doesNotMatch(source, /\bfieldFacets\b/);
    assert.doesNotMatch(source, /\bparseDurationSeconds\b/);
});

test('provider-specific analytics include commercial dashboard axes', () => {
    const sources = Object.fromEntries(expectedProviders.map(provider => [
        provider,
        fs.readFileSync(path.join(providerDir, provider, 'index.js'), 'utf8'),
    ]));

    const expectations = {
        twitter: ['has_article', 'has_quote', 'media_type'],
        youtube: ['video_count', 'latest_video_count', "facet('channel'"],
        instagram: ['location', 'audio'],
        tiktok: ['plays', 'shares', "facet('type', photo ? 'photo' : 'video')"],
        github: ['tagFacets', 'topics', "facet('owner'"],
        twitch: ['live_viewers', "facet('broadcaster'"],
        pixiv: ['ugoira_media_count', 'ai_generated', 'x_restrict'],
        niconico: ["facet('genre'", "tagFacets('tag'"],
        booth: ['variation_count', 'sale_status'],
        amazon: ['rating', 'reviews', 'duration_seconds'],
        spotify: ['preview_available', 'track_count', 'release_label'],
        steam: ['discount_percent', 'current_players', 'review_count'],
    };

    for (const [provider, snippets] of Object.entries(expectations)) {
        for (const snippet of snippets) {
            assert.match(sources[provider], new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${provider} should collect ${snippet}`);
        }
    }
});

test('provider-specific marketing axis segments cover every production provider', () => {
    const source = fs.readFileSync(adminDataPath, 'utf8');
    const start = source.indexOf('const PROVIDER_MARKETING_AXIS_SEGMENTS');
    const end = source.indexOf('\n};', start);

    assert.notEqual(start, -1, 'admin data must define PROVIDER_MARKETING_AXIS_SEGMENTS');
    assert.notEqual(end, -1, 'PROVIDER_MARKETING_AXIS_SEGMENTS must be a static object contract');

    const axisSegments = source.slice(start, end);
    assert.match(source, /function getDetailedProviderMarketingSegments/);
    assert.match(source, /analysis_model: "provider_specific_axis_segment"/);

    for (const provider of expectedProviders) {
        assert.match(
            axisSegments,
            new RegExp(`\\b${provider}:\\s*\\[`),
            `${provider} must have a provider marketing axis mapping`,
        );
        assert.doesNotMatch(
            axisSegments,
            new RegExp(`\\b${provider}:\\s*\\[\\s*\\]`),
            `${provider} provider marketing axis mapping must not be empty`,
        );
    }

    for (const metricKey of [
        'instagram.following',
        'instagram.posts',
        'instagram.duration_seconds',
        'instagram.verified',
        'instagram.private',
        'instagram.has_external_url',
        'tiktok.following',
        'tiktok.followers',
        'tiktok.videos',
        'github.state',
        'github.type',
        'twitch.curator',
        'twitch.video_url_available',
        'pixiv.x_restrict',
        'niconico.type',
        'booth.variation_count',
    ]) {
        assert.match(axisSegments, new RegExp(metricKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${metricKey} must be mapped to a provider axis`);
    }

    assert.match(source, /GROUP BY f\.content_event_id, f\.provider_id, f\.account_key, f\.facet_key/);
    assert.match(source, /duration:<15s/);
    assert.match(source, /price:1000-4999/);
    assert.match(source, /audience:1k-9k/);
    assert.match(source, /volume:100-999/);
});

test('provider metric quality denominators are content-type aware', () => {
    const source = fs.readFileSync(adminDataPath, 'utf8');
    const registryStart = source.indexOf('const PROVIDER_METRIC_SCHEMA_REGISTRY');
    const registryEnd = source.indexOf('\n};', registryStart);
    const nullRateStart = source.indexOf('async function getProviderMetricNullRates');
    const nullRateEnd = source.indexOf('\nasync function getProviderMetricObservationQuality', nullRateStart);

    assert.notEqual(registryStart, -1, 'provider metric schema registry must exist');
    assert.notEqual(registryEnd, -1, 'provider metric schema registry must be a static object');
    assert.notEqual(nullRateStart, -1, 'provider metric null rate helper must exist');
    assert.notEqual(nullRateEnd, -1, 'provider metric null rate helper must be isolated');

    const registry = source.slice(registryStart, registryEnd);
    const nullRateSource = source.slice(nullRateStart, nullRateEnd);

    assert.match(source, /appliesToContentTypes\?: string\[\]/);
    assert.match(source, /facetContentTypes\?: Record<string, string\[\]>/);
    assert.match(source, /function sumProviderMetricContentEvents/);
    assert.match(source, /function providerMetricObservedTotals/);
    assert.match(nullRateSource, /JOIN bot_provider_content_events c ON c\.content_event_id = f\.content_event_id/);
    assert.match(nullRateSource, /GROUP BY f\.provider_id, f\.facet_key, c\.content_type/);
    assert.match(nullRateSource, /denominator_scope: spec\.appliesToContentTypes\.length \? "content_type" : "provider"/);
    assert.match(nullRateSource, /applies_to_content_types: spec\.appliesToContentTypes\.length/);

    for (const snippet of [
        'schemaMetric("youtube.duration_seconds", "Duration seconds", "initial", true, YOUTUBE_VIDEO_CONTENT_TYPES)',
        'schemaMetric("youtube.video_count", "Playlist video count", "optional", false, ["playlist"])',
        'schemaMetric("instagram.duration_seconds", "Duration seconds", "optional", false, ["video"])',
        'schemaMetric("tiktok.followers", "Followers", "optional", false, ["profile"])',
        'schemaMetric("twitch.live_viewers", "Live viewers", "optional", false, TWITCH_CHANNEL_CONTENT_TYPES)',
        'schemaMetric("github.stars", "Stars", "initial", true, GITHUB_REPOSITORY_CONTENT_TYPES)',
        'schemaMetric("amazon.price", "Price", "optional", false, AMAZON_PRODUCT_CONTENT_TYPES)',
        'schemaMetric("spotify.track_number", "Track number", "optional", false, ["track"])',
        'schemaMetric("steam.current_players", "Current players", "enriched", false, STEAM_APP_CONTENT_TYPES)',
    ]) {
        assert.match(registry, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${snippet} must declare content-type applicability`);
    }
});
