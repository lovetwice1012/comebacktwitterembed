'use strict';

const { Events } = require('discord.js');
const { recordMetric } = require('./errorTracking');

// Events.Raw is emitted once for each Gateway Dispatch packet, before discord.js
// converts it into higher-level client events. Heartbeats and local client events
// are intentionally outside this received-event count.

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const TOTAL_METRIC_NAME = 'discord_gateway_event_received';

function normalizeEventType(value) {
    const eventType = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return (eventType || 'UNKNOWN').slice(0, 64);
}

function createDiscordEventMetrics(options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const metricRecorder = typeof options.recordMetric === 'function' ? options.recordMetric : recordMetric;
    // Rolling windows use one-second buckets to keep memory bounded regardless
    // of event volume (at most 86,400 active bucket keys for a 24-hour window).
    const secondBuckets = new Map();
    const eventTypeCounts = new Map();
    const shardCounts = new Map();
    // Gateway dispatches can arrive in bursts.  Keep their analytics counts
    // locally and hand them to the database queue as a small batch instead of
    // doing context normalisation and queue scheduling for every dispatch.
    const pendingMetricCounts = new Map();
    const registrations = new WeakMap();
    const rawStartedAtMs = Number(now());
    const startedAtMs = Number.isFinite(rawStartedAtMs) ? rawStartedAtMs : Date.now();

    let total = 0;
    let lastPrunedSecond = Math.floor(startedAtMs / 1000);
    let lastMetricWarningAt = Number.NEGATIVE_INFINITY;

    function readNowMs() {
        const value = Number(now());
        return Number.isFinite(value) ? value : Date.now();
    }

    function pruneBuckets(nowSecond) {
        const oldestIncludedSecond = nowSecond - DAY_SECONDS + 1;
        for (const second of secondBuckets.keys()) {
            if (second < oldestIncludedSecond) secondBuckets.delete(second);
        }
        lastPrunedSecond = nowSecond;
    }

    function flushAnalytics(timestampMs = readNowMs()) {
        if (pendingMetricCounts.size === 0) return 0;

        const pending = [...pendingMetricCounts.entries()];
        pendingMetricCounts.clear();
        let flushed = 0;
        for (let index = 0; index < pending.length; index += 1) {
            const [eventType, count] = pending[index];
            try {
                // One metric name keeps the admin total compact; endpoint_key retains
                // the Gateway event type for optional drill-down without payload data.
                metricRecorder(TOTAL_METRIC_NAME, {
                    occurredAtMs: timestampMs,
                    endpointKey: eventType,
                }, count);
                flushed += count;
            } catch (err) {
                // Preserve this and later entries without duplicating the entries
                // that were accepted before the recorder failed.
                for (const [pendingEventType, pendingCount] of pending.slice(index)) {
                    pendingMetricCounts.set(pendingEventType, (pendingMetricCounts.get(pendingEventType) || 0) + pendingCount);
                }
                if (timestampMs - lastMetricWarningAt < MINUTE_SECONDS * 1000) return flushed;
                lastMetricWarningAt = timestampMs;
                console.warn('[discordEventMetrics] Failed to record metric:', err?.message || err);
                return flushed;
            }
        }
        return flushed;
    }

    function record(packet, shardId) {
        const timestampMs = readNowMs();
        const second = Math.floor(timestampMs / 1000);
        const eventType = normalizeEventType(packet?.t);
        const shardKey = Number.isInteger(shardId) ? String(shardId) : 'unknown';

        total++;
        secondBuckets.set(second, (secondBuckets.get(second) || 0) + 1);
        eventTypeCounts.set(eventType, (eventTypeCounts.get(eventType) || 0) + 1);
        shardCounts.set(shardKey, (shardCounts.get(shardKey) || 0) + 1);
        pendingMetricCounts.set(eventType, (pendingMetricCounts.get(eventType) || 0) + 1);

        if (second < lastPrunedSecond || second - lastPrunedSecond >= MINUTE_SECONDS) {
            pruneBuckets(second);
        }

    }

    function register(client) {
        if (!client || typeof client.on !== 'function') {
            throw new TypeError('A discord.js Client with an on() method is required.');
        }
        if (registrations.has(client)) return false;

        const listener = (packet, shardId) => record(packet, shardId);
        registrations.set(client, listener);
        client.on(Events.Raw, listener);
        return true;
    }

    function unregister(client) {
        const listener = client && registrations.get(client);
        if (!listener) return false;

        if (typeof client.off === 'function') client.off(Events.Raw, listener);
        else if (typeof client.removeListener === 'function') client.removeListener(Events.Raw, listener);
        registrations.delete(client);
        return true;
    }

    function snapshot(timestampMs = readNowMs()) {
        const normalizedTimestampMs = Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : readNowMs();
        const nowSecond = Math.floor(normalizedTimestampMs / 1000);
        pruneBuckets(nowSecond);

        let lastMinute = 0;
        let lastHour = 0;
        let lastDay = 0;

        for (const [second, count] of secondBuckets) {
            const ageSeconds = nowSecond - second;
            if (ageSeconds < 0) continue;
            if (ageSeconds < DAY_SECONDS) lastDay += count;
            if (ageSeconds < HOUR_SECONDS) lastHour += count;
            if (ageSeconds < MINUTE_SECONDS) lastMinute += count;
        }

        const byEventType = [...eventTypeCounts.entries()]
            .map(([eventType, count]) => ({ eventType, count }))
            .sort((left, right) => right.count - left.count || left.eventType.localeCompare(right.eventType));
        const byShard = [...shardCounts.entries()]
            .map(([shardId, count]) => ({ shardId, count }))
            .sort((left, right) => right.count - left.count || left.shardId.localeCompare(right.shardId));

        return {
            total,
            lastMinute,
            lastHour,
            lastDay,
            startedAt: new Date(startedAtMs).toISOString(),
            byEventType,
            byShard,
        };
    }

    return { record, register, unregister, snapshot, flushAnalytics };
}

const defaultMetrics = createDiscordEventMetrics();

module.exports = {
    ...defaultMetrics,
    createDiscordEventMetrics,
    _internal: {
        DAY_SECONDS,
        HOUR_SECONDS,
        MINUTE_SECONDS,
        TOTAL_METRIC_NAME,
        normalizeEventType,
    },
};
