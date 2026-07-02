'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TABLES, SCHEMA_STATEMENTS } = require('../../src/db_schema');
const {
    accountKeyFromUrl,
    classifyErrorType,
    endpointKeyFromUrl,
    normalizeUrlForStorage,
    _internal,
} = require('../../src/errorTracking');

test('error tracking schema declares event and bucket tables', () => {
    assert.equal(TABLES.botErrorEvents, 'bot_error_events');
    assert.equal(TABLES.botErrorBuckets, 'bot_error_buckets');
    assert.equal(TABLES.botMetricBuckets, 'bot_metric_buckets');
    assert.equal(TABLES.botAnalyticsEvents, 'bot_analytics_events');
    assert.equal(TABLES.botProviderContentEvents, 'bot_provider_content_events');
    assert.equal(TABLES.botProviderContentFacets, 'bot_provider_content_facets');
    assert.equal(TABLES.botProviderHourlyAggregates, 'bot_provider_hourly_aggregates');
    assert.equal(TABLES.botProviderHourlyUniqueKeys, 'bot_provider_hourly_unique_keys');
    assert.equal(TABLES.botErrorAlerts, 'bot_error_alerts');
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botErrorEvents)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botErrorBuckets)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botMetricBuckets)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botAnalyticsEvents)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botProviderContentEvents)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botProviderContentFacets)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botProviderHourlyAggregates)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botProviderHourlyUniqueKeys)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botErrorAlerts)));
});

test('error tracking normalizes urls and derives endpoint keys', () => {
    assert.equal(
        normalizeUrlForStorage('https://x.com/user/status/123?token=secret#reply'),
        'https://x.com/user/status/123'
    );
    assert.equal(
        endpointKeyFromUrl('https://www.instagram.com/reel/abc/?utm_source=x'),
        'www.instagram.com/reel'
    );
});

test('error tracking derives provider account keys for analytics', () => {
    assert.equal(accountKeyFromUrl('twitter', 'https://x.com/someone/status/123'), 'someone');
    assert.equal(accountKeyFromUrl('youtube', 'https://www.youtube.com/@example/videos'), '@example');
    assert.equal(accountKeyFromUrl('github', 'https://github.com/openai/codex'), 'openai');
    assert.equal(accountKeyFromUrl('booth', 'https://shop-name.booth.pm/items/123'), 'shop-name');
});

test('error tracking classifies json decode, http, and Discord permission errors', () => {
    assert.equal(classifyErrorType(new SyntaxError('Unexpected token < in JSON')), 'provider_api_json_decode_error');
    assert.equal(classifyErrorType(new Error('phixiv api 503 for https://example.test')), 'provider_api_http_error');
    assert.equal(classifyErrorType({ code: 50013, rawError: { message: 'Missing Permissions' } }), 'discord_missing_permissions');
});

test('provider analytics enrichment jobs are collected from send steps without running during extraction', () => {
    const job = () => ({ metrics: { current_players: 1 } });
    job.analyticsMetadata = {
        source: 'test.analytics.enrichment',
        schemaVersion: 'test.v1',
        timeoutMs: 1234,
        maxAttempts: 2,
        retryBackoffMs: 5,
        rateLimitMs: 7,
    };
    const jobs = _internal.providerAnalyticsEnrichmentJobs([
        { analytics: { metrics: { price: 1 } }, analyticsEnrichers: [job] },
        { providerAnalyticsEnricher: job },
        { analyticsEnrichers: ['not-a-function'] },
    ]);

    assert.deepEqual(jobs, [job, job]);
    assert.deepEqual(_internal.providerAnalyticsEnrichmentJobMetadata(job, 7), {
        index: 7,
        source: 'test.analytics.enrichment',
        schemaVersion: 'test.v1',
        timeoutMs: 1234,
        stage: 'enriched',
        maxAttempts: 2,
        retryBackoffMs: 5,
        rateLimitMs: 7,
    });
    assert.deepEqual(_internal.normalizeProviderAnalyticsEnrichmentResult({ analytics: { metrics: { current_players: 1 } } }).blocks, [
        { metrics: { current_players: 1 } },
    ]);
});

test('provider analytics enrichment queue retries without blocking extraction', async () => {
    let attempts = 0;
    const job = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary provider analytics failure');
        return { analytics: { metrics: { current_players: 42 } } };
    };
    job.analyticsMetadata = {
        source: 'test.analytics.queue',
        schemaVersion: 'test.queue.v1',
        timeoutMs: 100,
        maxAttempts: 2,
        retryBackoffMs: 1,
        rateLimitMs: 1,
    };

    const before = _internal.providerAnalyticsEnrichmentQueueState();
    const blocks = await _internal.runProviderAnalyticsEnrichers({
        providerId: 'steam',
        accountKey: 'valve',
        url: 'https://store.steampowered.com/app/10',
    }, [job]);
    const after = _internal.providerAnalyticsEnrichmentQueueState();

    assert.equal(attempts, 2);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].metrics, { current_players: 42 });
    assert.equal(blocks[0].metadata.source, 'test.analytics.queue');
    assert.equal(blocks[0].metadata.schemaVersion, 'test.queue.v1');
    assert.equal(blocks[0].metadata.stage, 'enriched');
    assert.equal(blocks[0].metadata.timeoutMs, 100);
    assert.equal(blocks[0].metadata.success, true);
    assert.ok(Number.isFinite(blocks[0].metadata.collectedAtMs));
    assert.equal(after.queued, before.queued);
});

test('provider analytics enrichment classifies parse failures separately', () => {
    assert.equal(_internal.enrichmentFailureOutcome(new SyntaxError('Unexpected token < in JSON')), 'parse_failure');
    assert.equal(_internal.enrichmentFailureOutcome(new Error('provider response JSON parse failed')), 'parse_failure');
    assert.equal(_internal.enrichmentFailureOutcome(new Error('temporary provider analytics failure')), 'error');
});

test('analytics event rows include user, account, success, and duration context', () => {
    const row = _internal.createAnalyticsEventRow('provider_extract', {
        source: 'test',
        providerId: 'twitter',
        url: 'https://x.com/someone/status/123',
        success: true,
        durationMs: 42,
        message: {
            id: 'message-1',
            author: { id: 'user-1' },
            guildId: 'guild-1',
            guild: { id: 'guild-1', name: 'Guild Name' },
            channelId: 'channel-1',
            channel: { id: 'channel-1', name: 'general' },
        },
    });

    assert.equal(row.event_type, 'provider_extract');
    assert.equal(row.provider_id, 'twitter');
    assert.equal(row.account_key, 'someone');
    assert.equal(row.raw_url, 'https://x.com/someone/status/123');
    assert.equal(row.normalized_url, 'https://x.com/someone/status/123');
    assert.ok(row.url_hash);
    assert.equal(row.guild_id, 'guild-1');
    assert.equal(row.author_user_id, 'user-1');
    assert.equal(row.success, 1);
    assert.equal(row.duration_ms, 42);
});

test('hourly aggregate rows separate extract and enrichment duration from raw analytics events', () => {
    const enrichment = _internal.createAnalyticsEventRow('provider_analytics_enrichment', {
        source: 'steam.analytics.enrichment',
        providerId: 'steam',
        accountKey: 'valve',
        guildId: 'guild-1',
        authorUserId: 'user-1',
        url: 'https://store.steampowered.com/app/10',
        success: true,
        durationMs: 321,
        occurredAtMs: 3600 * 1000 + 123,
        details: { schema_version: 'steam.v1' },
    });
    const aggregate = _internal.createAnalyticsHourlyAggregateRow(enrichment);

    assert.equal(aggregate.bucket_start_ms, 3600 * 1000);
    assert.equal(aggregate.provider_id, 'steam');
    assert.equal(aggregate.account_key, 'valve');
    assert.equal(aggregate.event_type, 'provider_analytics_enrichment');
    assert.equal(aggregate.schema_version, 'steam.v1');
    assert.equal(aggregate.analytics_events, 1);
    assert.equal(aggregate.enrichment_jobs, 1);
    assert.equal(aggregate.enrichment_successes, 1);
    assert.equal(aggregate.enrichment_duration_sum_ms, 321);
    assert.equal(aggregate.enrichment_duration_count, 1);
    assert.equal(aggregate.analytics_duration_sum_ms, 321);

    const uniqueRows = _internal.createProviderHourlyUniqueRows(enrichment, enrichment.event_type);
    assert.equal(uniqueRows.length, 3);
    assert.ok(uniqueRows.every(row => row.key_hash && !String(row.key_hash).includes('user-1')));
});

test('hourly aggregate rows summarize provider content without raw identifiers', () => {
    const aggregate = _internal.createContentHourlyAggregateRow({
        occurred_at_ms: 7200 * 1000 + 10,
        provider_id: 'youtube',
        account_key: '@example',
        guild_id: 'guild-1',
        content_type: 'video',
        media_count: 2,
        duration_seconds: 180,
        sensitive: 0,
    });

    assert.equal(aggregate.bucket_start_ms, 7200 * 1000);
    assert.equal(aggregate.event_type, 'provider_content');
    assert.equal(aggregate.content_type, 'video');
    assert.equal(aggregate.content_events, 1);
    assert.equal(aggregate.media_count_sum, 2);
    assert.equal(aggregate.duration_seconds_sum, 180);
    assert.equal(aggregate.duration_seconds_count, 1);
});

test('error event rows include trace context without dropping investigation fields', () => {
    const row = _internal.createErrorEventRow(new SyntaxError('Unexpected end of JSON input'), {
        fallbackType: 'provider_extract_failed',
        source: 'provider.extract',
        providerId: 'twitter',
        endpointKey: 'api.vxtwitter.com/status',
        url: 'https://x.com/someone/status/123?tracking=1',
        message: {
            id: 'message-1',
            author: { id: 'user-1' },
            guildId: 'guild-1',
            guild: { id: 'guild-1', name: 'Guild Name' },
            channelId: 'channel-1',
            channel: { id: 'channel-1', name: 'general' },
        },
    });

    assert.equal(row.error_type, 'provider_api_json_decode_error');
    assert.equal(row.provider_id, 'twitter');
    assert.equal(row.endpoint_key, 'api.vxtwitter.com/status');
    assert.equal(row.raw_url, 'https://x.com/someone/status/123?tracking=1');
    assert.equal(row.normalized_url, 'https://x.com/someone/status/123');
    assert.equal(row.author_user_id, 'user-1');
    assert.equal(row.guild_id, 'guild-1');
    assert.equal(row.guild_name_snapshot, 'Guild Name');
    assert.equal(row.channel_id, 'channel-1');
    assert.equal(row.channel_name_snapshot, 'general');
    assert.equal(row.message_id, 'message-1');
    assert.ok(row.url_hash);
    assert.ok(row.stack_hash);
    assert.ok(row.expires_at_ms > row.occurred_at_ms);
});
