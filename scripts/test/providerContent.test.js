'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeProviderContent } = require('../../src/analytics/providerContent');

test('provider content summary does not infer marketing metrics from embed fields', () => {
    const item = summarizeProviderContent({
        providerId: 'twitter',
        url: 'https://x.com/example/status/123',
        steps: [{
            embeds: [{
                title: 'embed title',
                description: '#ai @someone',
                fields: [
                    { name: 'Likes', value: '999' },
                    { name: 'Reposts', value: '111' },
                ],
            }],
        }],
    });

    assert.equal(item.hasNativeAnalytics, false);
    assert.equal(item.facets.length, 0);
    assert.equal(item.event.raw_metrics_json, null);
});

test('provider content summary records URL query parameter keys without values', () => {
    const item = summarizeProviderContent({
        providerId: 'youtube',
        url: 'https://www.youtube.com/watch?v=abc123&utm_source=newsletter&token=secret-token&email=user@example.com#player?ref=share&session=hidden',
        occurredAtMs: 123456,
        steps: [],
    });

    assert.equal(item.hasNativeAnalytics, false);
    const queryFacets = item.facets.filter(facet => facet.facet_key === 'url.query_param');
    assert.deepEqual(queryFacets.map(facet => facet.facet_value).sort(), ['email', 'ref', 'session', 'token', 'utm_source', 'v']);
    assert.ok(queryFacets.every(facet => facet.metric_source === 'url.query_param.extract'));
    assert.ok(queryFacets.every(facet => facet.schema_version === 'url-query-param-v1'));
    assert.ok(queryFacets.every(facet => facet.collection_success === 1));

    const serializedFacets = JSON.stringify(queryFacets);
    assert.doesNotMatch(serializedFacets, /secret-token/);
    assert.doesNotMatch(serializedFacets, /newsletter/);
    assert.doesNotMatch(serializedFacets, /user@example\.com/);
    assert.doesNotMatch(serializedFacets, /hidden/);
    assert.match(queryFacets.find(facet => facet.facet_value === 'token')?.json_value || '', /"privacy_sensitivity":"high"/);
    assert.match(queryFacets.find(facet => facet.facet_value === 'email')?.json_value || '', /"privacy_sensitivity":"medium"/);
    assert.match(queryFacets.find(facet => facet.facet_value === 'utm_source')?.json_value || '', /"privacy_sensitivity":"marketing"/);
});

test('provider content summary stores native provider analytics with provider prefixes', () => {
    const item = summarizeProviderContent({
        providerId: 'twitter',
        url: 'https://x.com/example/status/123',
        source: 'test.provider.extract',
        occurredAtMs: 123456,
        guildId: 'guild-1',
        authorUserId: 'user-1',
        steps: [{
            analytics: {
                content: {
                    accountKey: 'example',
                    contentId: '123',
                    contentType: 'tweet',
                    contentUrl: 'https://x.com/example/status/123',
                    title: 'native title',
                    authorName: 'example',
                    mediaCount: 2,
                },
                metrics: {
                    likes: 42,
                    reposts: 7,
                },
                facets: [
                    { key: 'hashtag', value: 'ai' },
                    { key: 'media_type', value: 'image' },
                ],
            },
        }],
    });

    assert.equal(item.hasNativeAnalytics, true);
    assert.equal(item.event.account_key, 'example');
    assert.equal(item.event.content_id, '123');
    assert.equal(item.event.content_type, 'tweet');
    assert.equal(item.event.raw_metrics_json, JSON.stringify({ likes: 42, reposts: 7 }));
    assert.ok(item.facets.some(facet => facet.facet_key === 'twitter.likes' && facet.numeric_value === 42));
    assert.ok(item.facets.some(facet => facet.facet_key === 'twitter.reposts' && facet.numeric_value === 7));
    assert.ok(item.facets.some(facet => facet.facet_key === 'twitter.hashtag' && facet.facet_value === 'ai'));
    assert.ok(item.facets.some(facet => facet.facet_key === 'twitter.media_type' && facet.facet_value === 'image'));
    assert.ok(item.facets.every(facet => facet.metric_stage === 'initial'));
    assert.ok(item.facets.every(facet => facet.metric_source === 'test.provider.extract'));
    assert.ok(item.facets.every(facet => facet.collected_at_ms === 123456));
    assert.ok(item.facets.every(facet => facet.collection_success === 1));
});

test('provider content summary stores enriched provider metric observation metadata', () => {
    const item = summarizeProviderContent({
        providerId: 'steam',
        url: 'https://store.steampowered.com/app/10',
        occurredAtMs: 1000,
        source: 'messageCreate.providerExtract',
        steps: [{
            analytics: {
                content: { accountKey: 'valve', contentType: 'app', contentUrl: 'https://store.steampowered.com/app/10' },
                metrics: { current_players: 1234 },
                metadata: {
                    stage: 'enriched',
                    source: 'steam.analytics.enrichment',
                    schemaVersion: 'steam.v1',
                    timeoutMs: 1500,
                    collectedAtMs: 2500,
                    success: true,
                },
            },
        }],
    });

    const currentPlayers = item.facets.find(facet => facet.facet_key === 'steam.current_players');
    assert.ok(currentPlayers);
    assert.equal(currentPlayers.metric_stage, 'enriched');
    assert.equal(currentPlayers.metric_source, 'steam.analytics.enrichment');
    assert.equal(currentPlayers.schema_version, 'steam.v1');
    assert.equal(currentPlayers.collection_timeout_ms, 1500);
    assert.equal(currentPlayers.collected_at_ms, 2500);
    assert.equal(currentPlayers.collection_success, 1);
});
