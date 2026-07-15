'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { TABLES } = require('./db_schema');
const { discordErrorCode } = require('./utils');
const { summarizeProviderContent } = require('./analytics/providerContent');

const DEFAULT_BUCKET_SIZE_SECONDS = 60;
const DEFAULT_EVENT_RETENTION_DAYS = 30;
const DEFAULT_FLUSH_DELAY_MS = 5000;
const DEFAULT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROVIDER_ANALYTICS_ENRICHMENT_TIMEOUT_MS = 3000;
const PROVIDER_AGGREGATE_BUCKET_SECONDS = 60 * 60;
const PROVIDER_ANALYTICS_ENRICHMENT_CONCURRENCY = 2;
const PROVIDER_ANALYTICS_ENRICHMENT_MAX_ATTEMPTS = 3;
const PROVIDER_ANALYTICS_ENRICHMENT_BACKOFF_MS = 1000;
const PROVIDER_ANALYTICS_ENRICHMENT_RATE_LIMIT_MS = 5000;
const MAX_EVENT_QUEUE = 5000;
const MAX_DETAILS_LENGTH = 12000;
const MAX_INPUT_PREVIEW_LENGTH = 1000;
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const NETWORK_ERROR_CODES = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
]);

const errorContextStore = new AsyncLocalStorage();
const eventQueue = [];
const analyticsEventQueue = [];
const providerContentQueue = [];
const providerAnalyticsEnrichmentQueue = [];
const providerAnalyticsEnrichmentRateLimits = new Map();
const bucketIncrements = new Map();

let flushTimer = null;
let enrichmentQueueTimer = null;
let enrichmentQueueTimerDueAt = 0;
let activeProviderAnalyticsEnrichments = 0;
let providerAnalyticsEnrichmentSequence = 0;
let flushInProgress = false;
let lastFlushWarningAt = 0;
let lastPruneAt = 0;

function nowMs() {
    return Date.now();
}

function toDbString(value, maxLength = null) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return maxLength && text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeSeverity(value) {
    const severity = String(value || 'error').toLowerCase();
    return SEVERITIES.has(severity) ? severity : 'error';
}

function blankForBucket(value, maxLength = null) {
    const text = toDbString(value, maxLength);
    return text ?? '';
}

function hashValue(value) {
    if (value === undefined || value === null || value === '') return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeJsonStringify(value) {
    if (value === undefined || value === null) return null;
    const seen = new WeakSet();
    const json = JSON.stringify(value, (_key, current) => {
        if (typeof current === 'bigint') return String(current);
        if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`;
        if (current && typeof current === 'object') {
            if (seen.has(current)) return '[Circular]';
            seen.add(current);
        }
        return current;
    });
    if (!json) return null;
    return json.length > MAX_DETAILS_LENGTH ? json.slice(0, MAX_DETAILS_LENGTH) : json;
}

function truncateForDetails(value, maxLength = MAX_INPUT_PREVIEW_LENGTH) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeUrlForStorage(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return String(rawUrl).split(/[?#]/)[0] || String(rawUrl);
    }
}

function endpointKeyFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        const firstSegment = url.pathname.split('/').filter(Boolean)[0];
        return firstSegment ? `${url.hostname}/${firstSegment}` : url.hostname;
    } catch {
        return null;
    }
}

function accountKeyFromUrl(providerId, rawUrl) {
    if (!rawUrl) return null;
    try {
        const url = new URL(String(rawUrl));
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        const segments = url.pathname.split('/').filter(Boolean);
        const first = segments[0] || '';
        const second = segments[1] || '';
        const provider = String(providerId || '').toLowerCase();

        if ((provider === 'twitter' || host === 'x.com' || host === 'twitter.com') && first && !['i', 'intent', 'share', 'search', 'home'].includes(first)) {
            return first.replace(/^@/, '').toLowerCase();
        }
        if (provider === 'instagram' && first && !['p', 'reel', 'tv', 'stories', 'explore'].includes(first)) return first.toLowerCase();
        if (provider === 'tiktok' && first.startsWith('@')) return first.slice(1).toLowerCase();
        if (provider === 'youtube') {
            if (first.startsWith('@')) return first.toLowerCase();
            if (['channel', 'user', 'c'].includes(first) && second) return `${first}/${second}`;
        }
        if (provider === 'github' && first) return first.toLowerCase();
        if (provider === 'twitch' && first && !['videos', 'directory'].includes(first)) return first.toLowerCase();
        if (provider === 'booth') {
            const boothHost = host.endsWith('.booth.pm') ? host.replace(/\.booth\.pm$/, '') : '';
            if (boothHost && boothHost !== 'booth') return boothHost;
        }
        if (provider === 'pixiv' && first === 'users' && second) return `users/${second}`;
        if (provider === 'niconico' && first === 'user' && second) return `user/${second}`;
        if (provider === 'steam' && first === 'developer' && second) return `developer/${second}`;
        if (provider === 'spotify' && ['artist', 'show'].includes(first) && second) return `${first}/${second}`;
        if (provider === 'amazon' && second && ['dp', 'gp'].includes(first)) return `${first}/${second}`;
        return endpointKeyFromUrl(rawUrl);
    } catch {
        return null;
    }
}

function httpStatusFromError(err) {
    const direct = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
    if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;

    const message = String(err?.message || '');
    const match = message.match(/\b([1-5][0-9]{2})\b/);
    if (!match) return null;
    const status = Number(match[1]);
    return status >= 100 && status <= 599 ? status : null;
}

function isJsonDecodeError(err) {
    const message = String(err?.message || '');
    return err?.name === 'SyntaxError'
        || err instanceof SyntaxError
        || /JSON|Unexpected token|Unexpected end of JSON/i.test(message);
}

function isNetworkTransportError(err) {
    const code = String(err?.code ?? err?.cause?.code ?? '');
    if (NETWORK_ERROR_CODES.has(code)) return true;
    const message = String(err?.message || '');
    return /connect timeout|handshake has timed out|socket hang up|before secure TLS|network socket/i.test(message);
}

function classifyErrorType(err, fallbackType = 'unknown') {
    const code = discordErrorCode(err);
    if (code === 10008) return 'discord_unknown_message';
    if (code === 10062) return 'discord_unknown_interaction';
    if (code === 40060) return 'discord_interaction_already_acknowledged';
    if (code === 50001 || code === 50013) return 'discord_missing_permissions';
    if (code === 20028 || code === 31001 || code === 429) return 'discord_rate_limited';
    if (isNetworkTransportError(err)) return 'network_transport_error';
    if (isJsonDecodeError(err)) return 'provider_api_json_decode_error';
    if (httpStatusFromError(err)) return 'provider_api_http_error';
    return fallbackType;
}

function extractMessageContext(message) {
    if (!message) return {};
    return {
        authorUserId: message.author?.id ?? message.user?.id ?? null,
        guildId: message.guildId ?? message.guild?.id ?? null,
        guildNameSnapshot: message.guild?.name ?? null,
        channelId: message.channelId ?? message.channel?.id ?? null,
        channelNameSnapshot: message.channel?.name ?? null,
        messageId: message.id ?? null,
    };
}

function extractInteractionContext(interaction) {
    if (!interaction) return {};
    const messageContext = extractMessageContext(interaction.message);
    return {
        ...messageContext,
        authorUserId: interaction.user?.id ?? messageContext.authorUserId ?? null,
        guildId: interaction.guildId ?? interaction.guild?.id ?? messageContext.guildId ?? null,
        guildNameSnapshot: interaction.guild?.name ?? messageContext.guildNameSnapshot ?? null,
        channelId: interaction.channelId ?? interaction.channel?.id ?? messageContext.channelId ?? null,
        channelNameSnapshot: interaction.channel?.name ?? messageContext.channelNameSnapshot ?? null,
        commandName: interaction.commandName ?? null,
        componentId: typeof interaction.customId === 'string' ? interaction.customId : null,
    };
}

function simplifyInteractionOption(option) {
    if (!option || typeof option !== 'object') return null;
    return {
        name: truncateForDetails(option.name, 128),
        type: option.type ?? null,
        value: option.value === undefined ? null : truncateForDetails(option.value, 1000),
        options: Array.isArray(option.options)
            ? option.options.map(simplifyInteractionOption).filter(Boolean)
            : [],
    };
}

function extractInteractionOptions(interaction) {
    const options = interaction?.options?.data;
    if (!Array.isArray(options) || options.length === 0) return null;
    return options.map(simplifyInteractionOption).filter(Boolean);
}

function currentErrorContext() {
    return { ...(errorContextStore.getStore() || {}) };
}

/**
 * @param {Record<string, any>} context
 * @returns {Record<string, any>}
 */
function mergeContext(context = {}) {
    const storeContext = currentErrorContext();
    const combined = {
        ...storeContext,
        ...context,
    };
    const messageContext = extractMessageContext(combined.message);
    const interactionContext = extractInteractionContext(combined.interaction);
    return {
        ...messageContext,
        ...interactionContext,
        ...storeContext,
        ...context,
    };
}

function runWithErrorContext(context, fn) {
    const merged = mergeContext(context);
    return errorContextStore.run(merged, fn);
}

function createInputDetails(merged, rawUrl, normalizedUrl) {
    const details = {};
    if (rawUrl) {
        details.url = rawUrl;
        if (normalizedUrl && normalizedUrl !== rawUrl) details.normalized_url = normalizedUrl;
    }

    const inputValue = merged.input
        ?? merged.inputValue
        ?? merged.inputText
        ?? merged.messageContent
        ?? merged.message?.content
        ?? merged.interaction?.message?.content;
    if (inputValue !== undefined && inputValue !== null) {
        const inputText = String(inputValue);
        details.message_content_preview = truncateForDetails(inputText);
        details.message_content_length = inputText.length;
        details.message_content_hash = hashValue(inputText);
    }

    const commandOptions = merged.commandOptions ?? extractInteractionOptions(merged.interaction);
    if (commandOptions) details.command_options = commandOptions;

    return Object.keys(details).length > 0 ? details : null;
}

function createErrorEventRow(err, context = {}) {
    const merged = mergeContext(context);
    const occurredAtMs = Number.isFinite(merged.occurredAtMs) ? Math.floor(merged.occurredAtMs) : nowMs();
    const retentionDays = Number.isFinite(merged.retentionDays) ? merged.retentionDays : DEFAULT_EVENT_RETENTION_DAYS;
    const rawUrl = toDbString(merged.url ?? merged.rawUrl);
    const normalizedUrl = toDbString(merged.normalizedUrl ?? normalizeUrlForStorage(rawUrl));
    const errorMessage = err?.message ? String(err.message) : String(err ?? '');
    const inputDetails = createInputDetails(merged, rawUrl, normalizedUrl);
    const details = {
        ...(merged.details && typeof merged.details === 'object' ? merged.details : {}),
        error_name: err?.name ?? null,
        error_message: errorMessage || null,
        error_code: err?.code ?? err?.rawError?.code ?? null,
    };
    if (inputDetails && details.input === undefined) details.input = inputDetails;
    const rawDiscordCode = discordErrorCode(err);
    const discordCode = Number(rawDiscordCode);

    return {
        occurred_at_ms: occurredAtMs,
        expires_at_ms: retentionDays > 0 ? occurredAtMs + retentionDays * 24 * 60 * 60 * 1000 : null,
        error_type: toDbString(merged.errorType ?? classifyErrorType(err, merged.fallbackType ?? 'unknown'), 96) || 'unknown',
        severity: normalizeSeverity(merged.severity),
        source: toDbString(merged.source, 96),
        provider_id: toDbString(merged.providerId ?? merged.provider_id, 64),
        endpoint_key: toDbString(merged.endpointKey ?? endpointKeyFromUrl(rawUrl), 191),
        raw_url: rawUrl,
        normalized_url: normalizedUrl,
        url_hash: hashValue(rawUrl || normalizedUrl),
        author_user_id: toDbString(merged.authorUserId ?? merged.author_user_id, 32),
        guild_id: toDbString(merged.guildId ?? merged.guild_id, 32),
        guild_name_snapshot: toDbString(merged.guildNameSnapshot ?? merged.guild_name_snapshot, 255),
        channel_id: toDbString(merged.channelId ?? merged.channel_id, 32),
        channel_name_snapshot: toDbString(merged.channelNameSnapshot ?? merged.channel_name_snapshot, 255),
        message_id: toDbString(merged.messageId ?? merged.message_id, 32),
        command_name: toDbString(merged.commandName ?? merged.command_name, 64),
        component_id: toDbString(merged.componentId ?? merged.component_id, 191),
        discord_code: Number.isInteger(discordCode) ? discordCode : null,
        http_status: merged.httpStatus ?? httpStatusFromError(err),
        stack_hash: hashValue(err?.stack || errorMessage),
        message_hash: hashValue(errorMessage),
        details_json: safeJsonStringify(details),
    };
}

function bucketStartMs(occurredAtMs, bucketSizeSeconds = DEFAULT_BUCKET_SIZE_SECONDS) {
    const sizeMs = bucketSizeSeconds * 1000;
    return Math.floor(occurredAtMs / sizeMs) * sizeMs;
}

function bucketKey(table, row) {
    return [
        table,
        row.bucket_start_ms,
        row.bucket_size_seconds,
        row.error_type || row.metric_name,
        row.severity || '',
        row.provider_id,
        row.guild_id,
        row.endpoint_key,
    ].join('\u0001');
}

function enqueueBucket(table, row) {
    const key = bucketKey(table, row);
    const current = bucketIncrements.get(key);
    if (current) {
        current.count += row.count;
        return;
    }
    bucketIncrements.set(key, { table, row: { ...row } });
}

function enqueueEvent(row) {
    if (eventQueue.length >= MAX_EVENT_QUEUE) eventQueue.shift();
    eventQueue.push(row);
}

function enqueueAnalyticsEvent(row) {
    if (analyticsEventQueue.length >= MAX_EVENT_QUEUE) analyticsEventQueue.shift();
    analyticsEventQueue.push(row);
}

function enqueueProviderContent(item) {
    if (providerContentQueue.length >= MAX_EVENT_QUEUE) providerContentQueue.shift();
    providerContentQueue.push(item);
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushErrorTrackingQueue().catch(warnFlushFailure);
    }, DEFAULT_FLUSH_DELAY_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function clearBackgroundWorkForTest() {
    if (flushTimer) clearTimeout(flushTimer);
    if (enrichmentQueueTimer) clearTimeout(enrichmentQueueTimer);
    flushTimer = null;
    enrichmentQueueTimer = null;
    enrichmentQueueTimerDueAt = 0;
    activeProviderAnalyticsEnrichments = 0;
    eventQueue.length = 0;
    analyticsEventQueue.length = 0;
    providerContentQueue.length = 0;
    providerAnalyticsEnrichmentQueue.length = 0;
    providerAnalyticsEnrichmentRateLimits.clear();
    bucketIncrements.clear();
}

function warnFlushFailure(err) {
    const timestamp = nowMs();
    if (timestamp - lastFlushWarningAt < 60000) return;
    lastFlushWarningAt = timestamp;
    console.warn('[errorTracking] Failed to flush error tracking queue:', err?.message || err);
}

function incrementErrorBucket(row) {
    enqueueBucket(TABLES.botErrorBuckets, {
        bucket_start_ms: bucketStartMs(row.occurred_at_ms),
        bucket_size_seconds: DEFAULT_BUCKET_SIZE_SECONDS,
        error_type: row.error_type,
        severity: row.severity,
        provider_id: blankForBucket(row.provider_id, 64),
        guild_id: blankForBucket(row.guild_id, 32),
        endpoint_key: blankForBucket(row.endpoint_key, 191),
        count: 1,
    });
}

function recordMetric(metricName, context = {}, count = 1) {
    if (!metricName || !Number.isFinite(count) || count <= 0) return;
    const merged = mergeContext(context);
    const occurredAtMs = Number.isFinite(merged.occurredAtMs) ? Math.floor(merged.occurredAtMs) : nowMs();
    enqueueBucket(TABLES.botMetricBuckets, {
        bucket_start_ms: bucketStartMs(occurredAtMs),
        bucket_size_seconds: DEFAULT_BUCKET_SIZE_SECONDS,
        metric_name: toDbString(metricName, 96),
        provider_id: blankForBucket(merged.providerId ?? merged.provider_id, 64),
        guild_id: blankForBucket(merged.guildId ?? merged.guild_id, 32),
        endpoint_key: blankForBucket(merged.endpointKey ?? endpointKeyFromUrl(merged.url ?? merged.rawUrl), 191),
        count: Math.floor(count),
    });
    scheduleFlush();
}

function createAnalyticsEventRow(eventType, context = {}) {
    const merged = mergeContext(context);
    const occurredAtMs = Number.isFinite(merged.occurredAtMs) ? Math.floor(merged.occurredAtMs) : nowMs();
    const rawUrl = toDbString(merged.url ?? merged.rawUrl);
    const normalizedUrl = toDbString(merged.normalizedUrl ?? normalizeUrlForStorage(rawUrl));
    const providerId = toDbString(merged.providerId ?? merged.provider_id, 64);
    const durationMs = Number(merged.durationMs ?? merged.duration_ms);
    const count = Number(merged.count);
    const success = merged.success;
    return {
        occurred_at_ms: occurredAtMs,
        event_type: toDbString(eventType, 64) || 'unknown',
        source: toDbString(merged.source, 96),
        provider_id: providerId,
        account_key: toDbString(merged.accountKey ?? merged.account_key ?? accountKeyFromUrl(providerId, rawUrl), 191),
        endpoint_key: toDbString(merged.endpointKey ?? merged.endpoint_key ?? endpointKeyFromUrl(rawUrl), 191),
        raw_url: rawUrl,
        normalized_url: normalizedUrl,
        url_hash: hashValue(rawUrl || normalizedUrl),
        guild_id: toDbString(merged.guildId ?? merged.guild_id, 32),
        guild_name_snapshot: toDbString(merged.guildNameSnapshot ?? merged.guild_name_snapshot, 255),
        channel_id: toDbString(merged.channelId ?? merged.channel_id, 32),
        channel_name_snapshot: toDbString(merged.channelNameSnapshot ?? merged.channel_name_snapshot, 255),
        author_user_id: toDbString(merged.authorUserId ?? merged.author_user_id, 32),
        message_id: toDbString(merged.messageId ?? merged.message_id, 32),
        command_name: toDbString(merged.commandName ?? merged.command_name, 64),
        component_id: toDbString(merged.componentId ?? merged.component_id, 191),
        success: typeof success === 'boolean' ? (success ? 1 : 0) : null,
        duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? Math.floor(durationMs) : null,
        count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1,
        details_json: safeJsonStringify(merged.details),
    };
}

function recordAnalyticsEvent(eventType, context = {}) {
    try {
        enqueueAnalyticsEvent(createAnalyticsEventRow(eventType, context));
        scheduleFlush();
    } catch (err) {
        warnFlushFailure(err);
    }
}

function providerAnalyticsEnrichmentJobs(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.flatMap(step => {
        const jobs = [
            step?.analyticsEnricher,
            step?.providerAnalyticsEnricher,
            ...(Array.isArray(step?.analyticsEnrichers) ? step.analyticsEnrichers : []),
            ...(Array.isArray(step?.providerAnalyticsEnrichers) ? step.providerAnalyticsEnrichers : []),
        ];
        return jobs.filter(job => typeof job === 'function');
    });
}

function providerAnalyticsEnrichmentJobMetadata(job, index = 0) {
    const metadata = (job?.analyticsMetadata && typeof job.analyticsMetadata === 'object' ? job.analyticsMetadata : null)
        || (job?.metadata && typeof job.metadata === 'object' ? job.metadata : null)
        || {};
    const rawTimeout = Number(metadata.timeoutMs ?? metadata.timeout_ms ?? job?.timeoutMs ?? PROVIDER_ANALYTICS_ENRICHMENT_TIMEOUT_MS);
    const rawMaxAttempts = Number(metadata.maxAttempts ?? metadata.max_attempts ?? job?.maxAttempts ?? PROVIDER_ANALYTICS_ENRICHMENT_MAX_ATTEMPTS);
    const rawBackoffMs = Number(metadata.retryBackoffMs ?? metadata.retry_backoff_ms ?? metadata.backoffMs ?? job?.retryBackoffMs ?? PROVIDER_ANALYTICS_ENRICHMENT_BACKOFF_MS);
    const rawRateLimitMs = Number(metadata.rateLimitMs ?? metadata.rate_limit_ms ?? job?.rateLimitMs ?? PROVIDER_ANALYTICS_ENRICHMENT_RATE_LIMIT_MS);
    return {
        index,
        source: toDbString(metadata.source ?? job?.analyticsSource ?? job?.source ?? 'provider.analytics.enrichment', 96),
        schemaVersion: toDbString(metadata.schemaVersion ?? metadata.schema_version ?? job?.analyticsSchemaVersion ?? job?.schemaVersion, 64),
        timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : PROVIDER_ANALYTICS_ENRICHMENT_TIMEOUT_MS,
        stage: toDbString(metadata.stage ?? job?.analyticsStage ?? 'enriched', 32),
        maxAttempts: Number.isFinite(rawMaxAttempts) && rawMaxAttempts > 0 ? Math.min(Math.floor(rawMaxAttempts), 5) : PROVIDER_ANALYTICS_ENRICHMENT_MAX_ATTEMPTS,
        retryBackoffMs: Number.isFinite(rawBackoffMs) && rawBackoffMs >= 0 ? Math.floor(rawBackoffMs) : PROVIDER_ANALYTICS_ENRICHMENT_BACKOFF_MS,
        rateLimitMs: Number.isFinite(rawRateLimitMs) && rawRateLimitMs >= 0 ? Math.floor(rawRateLimitMs) : PROVIDER_ANALYTICS_ENRICHMENT_RATE_LIMIT_MS,
    };
}

function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function isProviderAnalyticsBlock(value) {
    return value && typeof value === 'object' && (
        value.content !== undefined
        || value.metrics !== undefined
        || value.facets !== undefined
        || value.event !== undefined
    );
}

function normalizeProviderAnalyticsEnrichmentResult(value) {
    if (!value) return { blocks: [], metadata: null };
    if (Array.isArray(value)) {
        const blocks = [];
        const metadata = [];
        for (const item of value) {
            const normalized = normalizeProviderAnalyticsEnrichmentResult(item);
            blocks.push(...normalized.blocks);
            if (normalized.metadata) metadata.push(normalized.metadata);
        }
        return { blocks, metadata: metadata.length ? metadata : null };
    }
    if (value && typeof value === 'object') {
        const resultMetadata = value.metadata ?? value.analyticsMetadata ?? null;
        const rawBlocks = Array.isArray(value.blocks)
            ? value.blocks
            : Array.isArray(value.analyticsBlocks)
                ? value.analyticsBlocks
                : value.analytics || value.providerAnalytics
                    ? [value.analytics || value.providerAnalytics]
                    : isProviderAnalyticsBlock(value)
                        ? [value]
                        : [];
        return {
            blocks: rawBlocks.filter(isProviderAnalyticsBlock),
            metadata: resultMetadata,
        };
    }
    return { blocks: [], metadata: null };
}

function enrichProviderAnalyticsBlocks(blocks, metadata, resultMetadata, timing = {}) {
    return blocks.map(block => ({
        ...block,
        metadata: {
            ...(block?.metadata && typeof block.metadata === 'object' ? block.metadata : {}),
            ...(resultMetadata && !Array.isArray(resultMetadata) && typeof resultMetadata === 'object' ? resultMetadata : {}),
            source: metadata.source,
            schemaVersion: metadata.schemaVersion,
            stage: metadata.stage,
            timeoutMs: metadata.timeoutMs,
            success: timing.success !== false,
            collectedAtMs: timing.collectedAtMs ?? nowMs(),
            durationMs: timing.durationMs ?? null,
        },
    }));
}

function retryAfterMsFromError(reason) {
    const direct = Number(reason?.retryAfter ?? reason?.retry_after ?? reason?.response?.retryAfter ?? reason?.response?.retry_after);
    if (Number.isFinite(direct) && direct > 0) return direct < 1000 ? Math.floor(direct * 1000) : Math.floor(direct);
    const header = reason?.headers?.get?.('retry-after') ?? reason?.response?.headers?.get?.('retry-after') ?? reason?.headers?.['retry-after'] ?? reason?.response?.headers?.['retry-after'];
    const numeric = Number(header);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
    const dateMs = Date.parse(String(header || ''));
    return Number.isFinite(dateMs) && dateMs > nowMs() ? dateMs - nowMs() : 0;
}

function enrichmentFailureOutcome(reason) {
    if (/timed out/i.test(String(reason?.message || reason))) return 'timeout';
    if (httpStatusFromError(reason) === 429 || /rate.?limit|too many requests/i.test(String(reason?.message || reason))) return 'rate_limited';
    if (reason?.name === 'SyntaxError' || /json|parse|unexpected token|unexpected end/i.test(String(reason?.message || reason))) return 'parse_failure';
    return 'error';
}

function providerAnalyticsEnrichmentRateLimitKey(context, metadata) {
    return [
        context.providerId || context.provider_id || '',
        context.accountKey || context.account_key || accountKeyFromUrl(context.providerId || context.provider_id, context.url || context.rawUrl) || '',
        metadata.source || '',
    ].join('\u0001');
}

function providerAnalyticsEnrichmentRetryDelayMs(reason, metadata, attempt) {
    const retryAfterMs = retryAfterMsFromError(reason);
    const backoff = metadata.retryBackoffMs * (2 ** Math.max(0, attempt - 1));
    return Math.min(Math.max(retryAfterMs, backoff), 30000);
}

function scheduleProviderAnalyticsEnrichmentQueue(delayMs = 0) {
    const dueAt = nowMs() + Math.max(0, delayMs);
    if (enrichmentQueueTimer) {
        if (enrichmentQueueTimerDueAt <= dueAt) return;
        clearTimeout(enrichmentQueueTimer);
        enrichmentQueueTimer = null;
    }
    enrichmentQueueTimerDueAt = dueAt;
    enrichmentQueueTimer = setTimeout(() => {
        enrichmentQueueTimer = null;
        enrichmentQueueTimerDueAt = 0;
        drainProviderAnalyticsEnrichmentQueue();
    }, Math.max(0, delayMs));
}

function nextProviderAnalyticsEnrichmentDelay() {
    const timestamp = nowMs();
    let nextAt = Infinity;
    for (const item of providerAnalyticsEnrichmentQueue) {
        const rateLimitUntil = providerAnalyticsEnrichmentRateLimits.get(item.rateLimitKey) || 0;
        nextAt = Math.min(nextAt, Math.max(item.nextRunAt, rateLimitUntil));
    }
    return Number.isFinite(nextAt) ? Math.max(0, nextAt - timestamp) : 0;
}

function dequeueRunnableProviderAnalyticsEnrichment() {
    const timestamp = nowMs();
    for (const [key, until] of providerAnalyticsEnrichmentRateLimits.entries()) {
        if (until <= timestamp) providerAnalyticsEnrichmentRateLimits.delete(key);
    }
    for (let index = 0; index < providerAnalyticsEnrichmentQueue.length; index += 1) {
        const item = providerAnalyticsEnrichmentQueue[index];
        const rateLimitUntil = providerAnalyticsEnrichmentRateLimits.get(item.rateLimitKey) || 0;
        if (item.nextRunAt > timestamp || rateLimitUntil > timestamp) continue;
        providerAnalyticsEnrichmentQueue.splice(index, 1);
        return item;
    }
    return null;
}

function drainProviderAnalyticsEnrichmentQueue() {
    while (activeProviderAnalyticsEnrichments < PROVIDER_ANALYTICS_ENRICHMENT_CONCURRENCY) {
        const item = dequeueRunnableProviderAnalyticsEnrichment();
        if (!item) break;
        activeProviderAnalyticsEnrichments += 1;
        void processProviderAnalyticsEnrichmentQueueItem(item).finally(() => {
            activeProviderAnalyticsEnrichments -= 1;
            if (providerAnalyticsEnrichmentQueue.length > 0) scheduleProviderAnalyticsEnrichmentQueue(nextProviderAnalyticsEnrichmentDelay());
        });
    }
    if (providerAnalyticsEnrichmentQueue.length > 0 && activeProviderAnalyticsEnrichments < PROVIDER_ANALYTICS_ENRICHMENT_CONCURRENCY) {
        scheduleProviderAnalyticsEnrichmentQueue(nextProviderAnalyticsEnrichmentDelay());
    }
}

function enqueueProviderAnalyticsEnrichmentJob(context, job, index) {
    const metadata = providerAnalyticsEnrichmentJobMetadata(job, index);
    return new Promise((resolve) => {
        const item = {
            id: ++providerAnalyticsEnrichmentSequence,
            context,
            job,
            metadata,
            rateLimitKey: providerAnalyticsEnrichmentRateLimitKey(context, metadata),
            attempt: 0,
            enqueuedAt: nowMs(),
            nextRunAt: nowMs(),
            resolve,
        };
        providerAnalyticsEnrichmentQueue.push(item);
        scheduleProviderAnalyticsEnrichmentQueue(0);
    });
}

async function processProviderAnalyticsEnrichmentQueueItem(item) {
    item.attempt += 1;
    const startedAt = nowMs();
    const { context, metadata } = item;
    const queueWaitMs = startedAt - item.enqueuedAt;
    try {
        const value = await withTimeout(
            Promise.resolve().then(() => item.job(context)),
            metadata.timeoutMs,
            `provider analytics enrichment ${metadata.index}`,
        );
        const durationMs = nowMs() - startedAt;
        const normalized = normalizeProviderAnalyticsEnrichmentResult(value);
        const enrichedBlocks = enrichProviderAnalyticsBlocks(normalized.blocks, metadata, normalized.metadata, {
            success: true,
            collectedAtMs: nowMs(),
            durationMs,
        });
        recordAnalyticsEvent('provider_analytics_enrichment', {
            ...context,
            source: metadata.source,
            providerId: context.providerId,
            success: true,
            durationMs,
            details: {
                job_index: metadata.index,
                queue_job_id: item.id,
                attempt: item.attempt,
                max_attempts: metadata.maxAttempts,
                schema_version: metadata.schemaVersion,
                stage: metadata.stage,
                timeout_ms: metadata.timeoutMs,
                queue_wait_ms: queueWaitMs,
                rate_limit_key_hash: hashValue(item.rateLimitKey),
                outcome: 'success',
                block_count: normalized.blocks.length,
                result_metadata: normalized.metadata,
            },
        });
        item.resolve(enrichedBlocks);
    } catch (reason) {
        const durationMs = nowMs() - startedAt;
        const outcome = enrichmentFailureOutcome(reason);
        const retryDelayMs = providerAnalyticsEnrichmentRetryDelayMs(reason, metadata, item.attempt);
        const willRetry = item.attempt < metadata.maxAttempts;
        if (outcome === 'rate_limited') {
            providerAnalyticsEnrichmentRateLimits.set(item.rateLimitKey, nowMs() + Math.max(metadata.rateLimitMs, retryDelayMs));
        }
        recordAnalyticsEvent('provider_analytics_enrichment', {
            ...context,
            source: metadata.source,
            providerId: context.providerId,
            success: false,
            durationMs,
            details: {
                job_index: metadata.index,
                queue_job_id: item.id,
                attempt: item.attempt,
                max_attempts: metadata.maxAttempts,
                schema_version: metadata.schemaVersion,
                stage: metadata.stage,
                timeout_ms: metadata.timeoutMs,
                queue_wait_ms: queueWaitMs,
                retry_delay_ms: willRetry ? retryDelayMs : 0,
                rate_limit_key_hash: hashValue(item.rateLimitKey),
                outcome,
                will_retry: willRetry,
                error_name: reason?.name ?? null,
                error_message: reason?.message ?? String(reason),
            },
        });
        recordError(reason, {
            fallbackType: outcome === 'rate_limited'
                ? 'provider_analytics_enrichment_rate_limited'
                : outcome === 'timeout'
                    ? 'provider_analytics_enrichment_timeout'
                    : outcome === 'parse_failure'
                        ? 'provider_analytics_enrichment_parse_failure'
                    : 'provider_analytics_enrichment_failed',
            severity: willRetry ? 'warn' : 'error',
            source: metadata.source,
            providerId: context.providerId,
            message: context.message,
            url: context.url,
            httpStatus: httpStatusFromError(reason),
            details: {
                job_index: metadata.index,
                queue_job_id: item.id,
                attempt: item.attempt,
                max_attempts: metadata.maxAttempts,
                schema_version: metadata.schemaVersion,
                stage: metadata.stage,
                timeout_ms: metadata.timeoutMs,
                retry_delay_ms: willRetry ? retryDelayMs : 0,
                outcome,
                will_retry: willRetry,
            },
        });
        if (willRetry) {
            item.nextRunAt = nowMs() + retryDelayMs;
            providerAnalyticsEnrichmentQueue.push(item);
            scheduleProviderAnalyticsEnrichmentQueue(retryDelayMs);
            return;
        }
        item.resolve([]);
    }
}

async function runProviderAnalyticsEnrichers(context, jobs) {
    const results = await Promise.all(jobs.map((job, index) => enqueueProviderAnalyticsEnrichmentJob(context, job, index)));
    return results.flat();
}

function providerAnalyticsEnrichmentQueueState() {
    return {
        queued: providerAnalyticsEnrichmentQueue.length,
        active: activeProviderAnalyticsEnrichments,
        rateLimitedKeys: providerAnalyticsEnrichmentRateLimits.size,
    };
}

function recordProviderContentEventNow(context = {}) {
    try {
        const item = summarizeProviderContent(context);
        if (!item?.event?.provider_id) return;
        if (!item.hasNativeAnalytics) {
            const err = new Error(`Provider analytics metadata is required for ${item.event.provider_id}.`);
            recordError(err, {
                fallbackType: 'provider_analytics_missing',
                severity: 'error',
                source: 'provider.analytics.required',
                providerId: item.event.provider_id,
                message: context.message,
                url: context.url,
                guildId: context.guildId,
                channelId: context.channelId,
                authorUserId: context.authorUserId,
                details: {
                    step_count: Array.isArray(context.steps) ? context.steps.length : null,
                    reason: 'provider_success_without_native_analytics',
                },
            });
            recordMetric('provider_analytics_missing', {
                providerId: item.event.provider_id,
                message: context.message,
                url: context.url,
            });
            return;
        }
        enqueueProviderContent(item);
        scheduleFlush();
    } catch (err) {
        warnFlushFailure(err);
    }
}

function recordProviderContentEvent(context = {}) {
    const jobs = providerAnalyticsEnrichmentJobs(context.steps);
    if (jobs.length === 0) {
        recordProviderContentEventNow(context);
        return;
    }

    void (async () => {
        const enrichedBlocks = await runProviderAnalyticsEnrichers(context, jobs);
        const enrichedSteps = enrichedBlocks.length > 0
            ? [...(Array.isArray(context.steps) ? context.steps : []), ...enrichedBlocks.map(block => ({ analytics: block }))]
            : context.steps;
        recordProviderContentEventNow({ ...context, steps: enrichedSteps });
    })();
}

function parseDetailsJson(detailsJson) {
    if (!detailsJson || typeof detailsJson !== 'string') return {};
    try {
        const parsed = JSON.parse(detailsJson);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function aggregateDuration(value) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : 0;
}

function emptyProviderHourlyAggregate(base = {}) {
    return {
        bucket_start_ms: base.bucket_start_ms,
        bucket_size_seconds: PROVIDER_AGGREGATE_BUCKET_SECONDS,
        provider_id: blankForBucket(base.provider_id, 64),
        account_key: blankForBucket(base.account_key, 191),
        guild_id: blankForBucket(base.guild_id, 32),
        content_type: blankForBucket(base.content_type, 64),
        event_type: blankForBucket(base.event_type, 64),
        schema_version: blankForBucket(base.schema_version, 64),
        content_events: 0,
        analytics_events: 0,
        extract_events: 0,
        extract_successes: 0,
        extract_failures: 0,
        send_events: 0,
        send_successes: 0,
        send_failures: 0,
        enrichment_jobs: 0,
        enrichment_successes: 0,
        enrichment_failures: 0,
        analytics_duration_sum_ms: 0,
        analytics_duration_count: 0,
        analytics_duration_max_ms: 0,
        enrichment_duration_sum_ms: 0,
        enrichment_duration_count: 0,
        enrichment_duration_max_ms: 0,
        media_count_sum: 0,
        duration_seconds_sum: 0,
        duration_seconds_count: 0,
        sensitive_events: 0,
    };
}

function createAnalyticsHourlyAggregateRow(row) {
    const details = parseDetailsJson(row.details_json);
    const count = Number.isFinite(Number(row.count)) && Number(row.count) > 0 ? Math.floor(Number(row.count)) : 1;
    const duration = aggregateDuration(row.duration_ms);
    const eventType = row.event_type || '';
    const aggregate = emptyProviderHourlyAggregate({
        bucket_start_ms: bucketStartMs(row.occurred_at_ms, PROVIDER_AGGREGATE_BUCKET_SECONDS),
        provider_id: row.provider_id,
        account_key: row.account_key,
        guild_id: row.guild_id,
        event_type: eventType,
        schema_version: details.schema_version,
    });
    aggregate.analytics_events = count;
    if (duration > 0) {
        aggregate.analytics_duration_sum_ms = duration * count;
        aggregate.analytics_duration_count = count;
        aggregate.analytics_duration_max_ms = duration;
    }
    if (eventType === 'provider_extract') {
        aggregate.extract_events = count;
        if (row.success === 1) aggregate.extract_successes = count;
        if (row.success === 0) aggregate.extract_failures = count;
    }
    if (eventType === 'discord_send') {
        aggregate.send_events = count;
        if (row.success === 1) aggregate.send_successes = count;
        if (row.success === 0) aggregate.send_failures = count;
    }
    if (eventType === 'provider_analytics_enrichment') {
        aggregate.enrichment_jobs = count;
        if (row.success === 1) aggregate.enrichment_successes = count;
        if (row.success === 0) aggregate.enrichment_failures = count;
        if (duration > 0) {
            aggregate.enrichment_duration_sum_ms = duration * count;
            aggregate.enrichment_duration_count = count;
            aggregate.enrichment_duration_max_ms = duration;
        }
    }
    return aggregate;
}

function createContentHourlyAggregateRow(row) {
    const mediaCount = Number(row.media_count);
    const durationSeconds = Number(row.duration_seconds);
    const aggregate = emptyProviderHourlyAggregate({
        bucket_start_ms: bucketStartMs(row.occurred_at_ms, PROVIDER_AGGREGATE_BUCKET_SECONDS),
        provider_id: row.provider_id,
        account_key: row.account_key,
        guild_id: row.guild_id,
        content_type: row.content_type,
        event_type: 'provider_content',
    });
    aggregate.content_events = 1;
    if (Number.isFinite(mediaCount) && mediaCount > 0) aggregate.media_count_sum = Math.floor(mediaCount);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        aggregate.duration_seconds_sum = Math.floor(durationSeconds);
        aggregate.duration_seconds_count = 1;
    }
    if (row.sensitive === 1 || row.sensitive === true) aggregate.sensitive_events = 1;
    return aggregate;
}

function createProviderHourlyUniqueRows(row, eventType, contentType = '') {
    const base = {
        bucket_start_ms: bucketStartMs(row.occurred_at_ms, PROVIDER_AGGREGATE_BUCKET_SECONDS),
        provider_id: blankForBucket(row.provider_id, 64),
        account_key: blankForBucket(row.account_key, 191),
        guild_id: blankForBucket(row.guild_id, 32),
        content_type: blankForBucket(contentType, 64),
        event_type: blankForBucket(eventType, 64),
    };
    return [
        row.author_user_id ? { ...base, key_type: 'author_user', key_hash: hashValue(row.author_user_id) } : null,
        row.guild_id ? { ...base, key_type: 'guild', key_hash: hashValue(row.guild_id) } : null,
        row.url_hash ? { ...base, key_type: 'url', key_hash: row.url_hash } : null,
    ].filter(Boolean);
}

function recordError(err, context = {}) {
    try {
        const row = createErrorEventRow(err, context);
        enqueueEvent(row);
        incrementErrorBucket(row);
        recordMetric(`error.${row.error_type}`, {
            occurredAtMs: row.occurred_at_ms,
            providerId: row.provider_id,
            guildId: row.guild_id,
            endpointKey: row.endpoint_key,
        });
        scheduleFlush();
    } catch (recordErr) {
        warnFlushFailure(recordErr);
    }
}

function recordProviderError(providerId, err, message, url, context = {}) {
    recordError(err, {
        fallbackType: 'provider_extract_failed',
        source: 'provider.extract',
        providerId,
        message,
        url,
        ...context,
    });
    recordMetric('provider_extract_error', {
        providerId,
        message,
        url,
        endpointKey: context.endpointKey,
    });
}

async function insertErrorEvent(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botErrorEvents} (
            occurred_at_ms, expires_at_ms, error_type, severity, source, provider_id, endpoint_key,
            raw_url, normalized_url, url_hash, author_user_id, guild_id, guild_name_snapshot,
            channel_id, channel_name_snapshot, message_id, command_name, component_id,
            discord_code, http_status, stack_hash, message_hash, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.occurred_at_ms,
            row.expires_at_ms,
            row.error_type,
            row.severity,
            row.source,
            row.provider_id,
            row.endpoint_key,
            row.raw_url,
            row.normalized_url,
            row.url_hash,
            row.author_user_id,
            row.guild_id,
            row.guild_name_snapshot,
            row.channel_id,
            row.channel_name_snapshot,
            row.message_id,
            row.command_name,
            row.component_id,
            row.discord_code,
            row.http_status,
            row.stack_hash,
            row.message_hash,
            row.details_json,
        ],
    );
}

async function insertErrorEvents(queryDatabase, rows) {
    if (rows.length === 0) return;
    if (rows.length === 1) return await insertErrorEvent(queryDatabase, rows[0]);
    const values = rows.map(row => [
        row.occurred_at_ms, row.expires_at_ms, row.error_type, row.severity, row.source, row.provider_id,
        row.endpoint_key, row.raw_url, row.normalized_url, row.url_hash, row.author_user_id, row.guild_id,
        row.guild_name_snapshot, row.channel_id, row.channel_name_snapshot, row.message_id, row.command_name,
        row.component_id, row.discord_code, row.http_status, row.stack_hash, row.message_hash, row.details_json,
    ]);
    await queryDatabase(
        `INSERT INTO ${TABLES.botErrorEvents} (
            occurred_at_ms, expires_at_ms, error_type, severity, source, provider_id, endpoint_key,
            raw_url, normalized_url, url_hash, author_user_id, guild_id, guild_name_snapshot,
            channel_id, channel_name_snapshot, message_id, command_name, component_id,
            discord_code, http_status, stack_hash, message_hash, details_json
        ) VALUES ?`,
        [values],
    );
}

async function insertAnalyticsEvent(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botAnalyticsEvents} (
            occurred_at_ms, event_type, source, provider_id, account_key, endpoint_key,
            raw_url, normalized_url, url_hash, guild_id, guild_name_snapshot, channel_id, channel_name_snapshot, author_user_id,
            message_id, command_name, component_id, success, duration_ms, count, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.occurred_at_ms,
            row.event_type,
            row.source,
            row.provider_id,
            row.account_key,
            row.endpoint_key,
            row.raw_url,
            row.normalized_url,
            row.url_hash,
            row.guild_id,
            row.guild_name_snapshot,
            row.channel_id,
            row.channel_name_snapshot,
            row.author_user_id,
            row.message_id,
            row.command_name,
            row.component_id,
            row.success,
            row.duration_ms,
            row.count,
            row.details_json,
        ],
    );
    await upsertProviderHourlyAggregate(queryDatabase, createAnalyticsHourlyAggregateRow(row));
    for (const uniqueRow of createProviderHourlyUniqueRows(row, row.event_type)) {
        await insertProviderHourlyUniqueKey(queryDatabase, uniqueRow);
    }
}

async function insertAnalyticsEvents(queryDatabase, rows) {
    if (rows.length === 0) return;
    if (rows.length === 1) return await insertAnalyticsEvent(queryDatabase, rows[0]);
    const values = rows.map(row => [
        row.occurred_at_ms, row.event_type, row.source, row.provider_id, row.account_key, row.endpoint_key,
        row.raw_url, row.normalized_url, row.url_hash, row.guild_id, row.guild_name_snapshot, row.channel_id,
        row.channel_name_snapshot, row.author_user_id, row.message_id, row.command_name, row.component_id,
        row.success, row.duration_ms, row.count, row.details_json,
    ]);
    await queryDatabase(
        `INSERT INTO ${TABLES.botAnalyticsEvents} (
            occurred_at_ms, event_type, source, provider_id, account_key, endpoint_key,
            raw_url, normalized_url, url_hash, guild_id, guild_name_snapshot, channel_id, channel_name_snapshot,
            author_user_id, message_id, command_name, component_id, success, duration_ms, count, details_json
        ) VALUES ?`,
        [values],
    );
    for (const row of rows) {
        await upsertProviderHourlyAggregate(queryDatabase, createAnalyticsHourlyAggregateRow(row));
        for (const uniqueRow of createProviderHourlyUniqueRows(row, row.event_type)) {
            await insertProviderHourlyUniqueKey(queryDatabase, uniqueRow);
        }
    }
}

async function insertProviderContentEvent(queryDatabase, item) {
    const row = item.event;
    const result = await queryDatabase(
        `INSERT INTO ${TABLES.botProviderContentEvents} (
            occurred_at_ms, provider_id, account_key, content_id, content_type, content_url,
            normalized_url, url_hash, title, description_preview, author_name, language,
            published_at_ms, \`sensitive\`, media_count, duration_seconds, guild_id, channel_id,
            author_user_id, source, raw_metrics_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.occurred_at_ms,
            row.provider_id,
            row.account_key,
            row.content_id,
            row.content_type,
            row.content_url,
            row.normalized_url,
            row.url_hash,
            row.title,
            row.description_preview,
            row.author_name,
            row.language,
            row.published_at_ms,
            row.sensitive,
            row.media_count,
            row.duration_seconds,
            row.guild_id,
            row.channel_id,
            row.author_user_id,
            row.source,
            row.raw_metrics_json,
        ],
    );
    const contentEventId = result?.insertId;
    if (!contentEventId) return;
    for (const facet of item.facets || []) {
        await queryDatabase(
            `INSERT INTO ${TABLES.botProviderContentFacets} (
                content_event_id, provider_id, account_key, facet_key, facet_value,
                numeric_value, json_value, metric_stage, metric_source, collected_at_ms,
                schema_version, collection_success, collection_timeout_ms, occurred_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                contentEventId,
                row.provider_id,
                row.account_key,
                facet.facet_key,
                facet.facet_value,
                facet.numeric_value,
                facet.json_value,
                facet.metric_stage,
                facet.metric_source,
                facet.collected_at_ms,
                facet.schema_version,
                facet.collection_success,
                facet.collection_timeout_ms,
                row.occurred_at_ms,
            ],
        );
    }
    await upsertProviderHourlyAggregate(queryDatabase, createContentHourlyAggregateRow(row));
    for (const uniqueRow of createProviderHourlyUniqueRows(row, 'provider_content', row.content_type)) {
        await insertProviderHourlyUniqueKey(queryDatabase, uniqueRow);
    }
}

async function upsertProviderHourlyAggregate(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botProviderHourlyAggregates} (
            bucket_start_ms, bucket_size_seconds, provider_id, account_key, guild_id, content_type, event_type, schema_version,
            content_events, analytics_events, extract_events, extract_successes, extract_failures,
            send_events, send_successes, send_failures, enrichment_jobs, enrichment_successes, enrichment_failures,
            analytics_duration_sum_ms, analytics_duration_count, analytics_duration_max_ms,
            enrichment_duration_sum_ms, enrichment_duration_count, enrichment_duration_max_ms,
            media_count_sum, duration_seconds_sum, duration_seconds_count, sensitive_events
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            content_events = content_events + VALUES(content_events),
            analytics_events = analytics_events + VALUES(analytics_events),
            extract_events = extract_events + VALUES(extract_events),
            extract_successes = extract_successes + VALUES(extract_successes),
            extract_failures = extract_failures + VALUES(extract_failures),
            send_events = send_events + VALUES(send_events),
            send_successes = send_successes + VALUES(send_successes),
            send_failures = send_failures + VALUES(send_failures),
            enrichment_jobs = enrichment_jobs + VALUES(enrichment_jobs),
            enrichment_successes = enrichment_successes + VALUES(enrichment_successes),
            enrichment_failures = enrichment_failures + VALUES(enrichment_failures),
            analytics_duration_sum_ms = analytics_duration_sum_ms + VALUES(analytics_duration_sum_ms),
            analytics_duration_count = analytics_duration_count + VALUES(analytics_duration_count),
            analytics_duration_max_ms = GREATEST(analytics_duration_max_ms, VALUES(analytics_duration_max_ms)),
            enrichment_duration_sum_ms = enrichment_duration_sum_ms + VALUES(enrichment_duration_sum_ms),
            enrichment_duration_count = enrichment_duration_count + VALUES(enrichment_duration_count),
            enrichment_duration_max_ms = GREATEST(enrichment_duration_max_ms, VALUES(enrichment_duration_max_ms)),
            media_count_sum = media_count_sum + VALUES(media_count_sum),
            duration_seconds_sum = duration_seconds_sum + VALUES(duration_seconds_sum),
            duration_seconds_count = duration_seconds_count + VALUES(duration_seconds_count),
            sensitive_events = sensitive_events + VALUES(sensitive_events),
            updated_at = CURRENT_TIMESTAMP`,
        [
            row.bucket_start_ms,
            row.bucket_size_seconds,
            row.provider_id,
            row.account_key,
            row.guild_id,
            row.content_type,
            row.event_type,
            row.schema_version,
            row.content_events,
            row.analytics_events,
            row.extract_events,
            row.extract_successes,
            row.extract_failures,
            row.send_events,
            row.send_successes,
            row.send_failures,
            row.enrichment_jobs,
            row.enrichment_successes,
            row.enrichment_failures,
            row.analytics_duration_sum_ms,
            row.analytics_duration_count,
            row.analytics_duration_max_ms,
            row.enrichment_duration_sum_ms,
            row.enrichment_duration_count,
            row.enrichment_duration_max_ms,
            row.media_count_sum,
            row.duration_seconds_sum,
            row.duration_seconds_count,
            row.sensitive_events,
        ],
    );
}

async function insertProviderHourlyUniqueKey(queryDatabase, row) {
    await queryDatabase(
        `INSERT IGNORE INTO ${TABLES.botProviderHourlyUniqueKeys} (
            bucket_start_ms, provider_id, account_key, guild_id, content_type, event_type, key_type, key_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.bucket_start_ms,
            row.provider_id,
            row.account_key,
            row.guild_id,
            row.content_type,
            row.event_type,
            row.key_type,
            row.key_hash,
        ],
    );
}

async function upsertErrorBucket(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botErrorBuckets} (
            bucket_start_ms, bucket_size_seconds, error_type, severity, provider_id, guild_id, endpoint_key, count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE count = count + VALUES(count), updated_at = CURRENT_TIMESTAMP`,
        [
            row.bucket_start_ms,
            row.bucket_size_seconds,
            row.error_type,
            row.severity,
            row.provider_id,
            row.guild_id,
            row.endpoint_key,
            row.count,
        ],
    );
}

async function upsertMetricBucket(queryDatabase, row) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botMetricBuckets} (
            bucket_start_ms, bucket_size_seconds, metric_name, provider_id, guild_id, endpoint_key, count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE count = count + VALUES(count), updated_at = CURRENT_TIMESTAMP`,
        [
            row.bucket_start_ms,
            row.bucket_size_seconds,
            row.metric_name,
            row.provider_id,
            row.guild_id,
            row.endpoint_key,
            row.count,
        ],
    );
}

async function upsertBuckets(queryDatabase, table, rows) {
    if (rows.length === 0) return;
    if (rows.length === 1) {
        if (table === TABLES.botErrorBuckets) return await upsertErrorBucket(queryDatabase, rows[0].row);
        return await upsertMetricBucket(queryDatabase, rows[0].row);
    }
    const isError = table === TABLES.botErrorBuckets;
    const columns = isError
        ? 'bucket_start_ms, bucket_size_seconds, error_type, severity, provider_id, guild_id, endpoint_key, count'
        : 'bucket_start_ms, bucket_size_seconds, metric_name, provider_id, guild_id, endpoint_key, count';
    const values = rows.map(({ row }) => isError
        ? [row.bucket_start_ms, row.bucket_size_seconds, row.error_type, row.severity, row.provider_id, row.guild_id, row.endpoint_key, row.count]
        : [row.bucket_start_ms, row.bucket_size_seconds, row.metric_name, row.provider_id, row.guild_id, row.endpoint_key, row.count]);
    await queryDatabase(
        `INSERT INTO ${table} (${columns}) VALUES ?
         ON DUPLICATE KEY UPDATE count = count + VALUES(count), updated_at = CURRENT_TIMESTAMP`,
        [values],
    );
}

async function pruneExpiredErrorEvents(queryDatabase, timestampMs = nowMs()) {
    await queryDatabase(
        `DELETE FROM ${TABLES.botErrorEvents}
        WHERE expires_at_ms IS NOT NULL AND expires_at_ms < ?
        LIMIT 1000`,
        [timestampMs],
    );
}

async function flushErrorTrackingQueue() {
    if (flushInProgress) return;
    if (eventQueue.length === 0 && analyticsEventQueue.length === 0 && providerContentQueue.length === 0 && bucketIncrements.size === 0) return;

    flushInProgress = true;
    const events = eventQueue.splice(0, eventQueue.length);
    const analyticsEvents = analyticsEventQueue.splice(0, analyticsEventQueue.length);
    const providerContentEvents = providerContentQueue.splice(0, providerContentQueue.length);
    const buckets = [...bucketIncrements.values()];
    bucketIncrements.clear();

    try {
        const { queryDatabase } = require('./db');
        await insertErrorEvents(queryDatabase, events);
        await insertAnalyticsEvents(queryDatabase, analyticsEvents);
        for (const item of providerContentEvents) await insertProviderContentEvent(queryDatabase, item);
        await upsertBuckets(queryDatabase, TABLES.botErrorBuckets, buckets.filter(item => item.table === TABLES.botErrorBuckets));
        await upsertBuckets(queryDatabase, TABLES.botMetricBuckets, buckets.filter(item => item.table === TABLES.botMetricBuckets));
        const timestamp = nowMs();
        if (timestamp - lastPruneAt > DEFAULT_PRUNE_INTERVAL_MS) {
            lastPruneAt = timestamp;
            await pruneExpiredErrorEvents(queryDatabase, timestamp);
        }
    } catch (err) {
        warnFlushFailure(err);
    } finally {
        flushInProgress = false;
        if (eventQueue.length > 0 || analyticsEventQueue.length > 0 || providerContentQueue.length > 0 || bucketIncrements.size > 0) scheduleFlush();
    }
}

module.exports = {
    accountKeyFromUrl,
    classifyErrorType,
    endpointKeyFromUrl,
    flushErrorTrackingQueue,
    normalizeUrlForStorage,
    pruneExpiredErrorEvents,
    recordAnalyticsEvent,
    recordError,
    recordMetric,
    recordProviderContentEvent,
    recordProviderError,
    currentErrorContext,
    runWithErrorContext,
    _internal: {
        bucketStartMs,
        createAnalyticsEventRow,
        createAnalyticsHourlyAggregateRow,
        createContentHourlyAggregateRow,
        createErrorEventRow,
        createProviderHourlyUniqueRows,
        createInputDetails,
        httpStatusFromError,
        isJsonDecodeError,
        isNetworkTransportError,
        providerAnalyticsEnrichmentJobMetadata,
        providerAnalyticsEnrichmentJobs,
        providerAnalyticsEnrichmentQueueState,
        enrichProviderAnalyticsBlocks,
        enrichmentFailureOutcome,
        normalizeProviderAnalyticsEnrichmentResult,
        runProviderAnalyticsEnrichers,
        safeJsonStringify,
        clearBackgroundWorkForTest,
    },
};
