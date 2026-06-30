'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TABLES, SCHEMA_STATEMENTS } = require('../../src/db_schema');
const {
    classifyErrorType,
    endpointKeyFromUrl,
    normalizeUrlForStorage,
    _internal,
} = require('../../src/errorTracking');

test('error tracking schema declares event and bucket tables', () => {
    assert.equal(TABLES.botErrorEvents, 'bot_error_events');
    assert.equal(TABLES.botErrorBuckets, 'bot_error_buckets');
    assert.equal(TABLES.botMetricBuckets, 'bot_metric_buckets');
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botErrorEvents)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botErrorBuckets)));
    assert.ok(SCHEMA_STATEMENTS.some(statement => statement.includes(TABLES.botMetricBuckets)));
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

test('error tracking classifies json decode, http, and Discord permission errors', () => {
    assert.equal(classifyErrorType(new SyntaxError('Unexpected token < in JSON')), 'provider_api_json_decode_error');
    assert.equal(classifyErrorType(new Error('phixiv api 503 for https://example.test')), 'provider_api_http_error');
    assert.equal(classifyErrorType({ code: 50013, rawError: { message: 'Missing Permissions' } }), 'discord_missing_permissions');
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
