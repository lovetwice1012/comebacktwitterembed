'use strict';

const storeDefault = require('./store');
const {
    fetchSource: fetchSourceDefault,
    initialCursor,
    isHistoricalAtBaseline,
    monitorConfig,
} = require('./index');
const fetchDefault = require('../../providerFetch').withDeadline(require('node-fetch'));
const { recordError } = require('../../errorTracking');
const recoveryBootstrap = require('../../recoveryBootstrap');

const MINUTE = 60 * 1000;
const DEFAULT_TICK_MS = 30 * 1000;
const DEFAULT_START_DELAY_MS = 15 * 1000;
// Pixiv profiles can legitimately contain thousands of public artworks. Keep
// enough IDs to seed ordinary large accounts without replaying their history.
const MAX_CURSOR_IDS = 5000;
const MAX_DEFERRED_IDS = 5000;
// cursor_json is MEDIUMTEXT. Leave room for the bounded seen-ID window and
// cursor metadata; reject an observation atomically rather than lose its tail.
const MAX_DEFERRED_BYTES = 12 * 1024 * 1024;
const MAX_NEW_ITEMS_PER_SOURCE = 20;

let timer = null;
let running = false;
let activeClient = null;

function integer(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return fallback;
    return number;
}

function parseCursor(raw) {
    try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const seenContentIds = Array.isArray(value?.seenContentIds)
            ? value.seenContentIds.map(String).filter(Boolean).slice(0, MAX_CURSOR_IDS)
            : [];
        const deferredObservations = Array.isArray(value?.deferredObservations) ? value.deferredObservations : [];
        if (deferredObservations.length > MAX_DEFERRED_IDS || deferredObservations.some(entry => !Array.isArray(entry)
            || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 255
            || !Number.isSafeInteger(entry[1]) || entry[1] < 0)) throw new Error('Invalid deferred observations');
        const deferredItems = Array.isArray(value?.deferredItems) ? value.deferredItems : [];
        if (deferredItems.length > MAX_DEFERRED_IDS || deferredItems.some(item => !item || typeof item.contentId !== 'string'
            || !item.contentId || typeof item.url !== 'string' || !item.url
            || !Number.isSafeInteger(item.discoveredAtMs) || item.discoveredAtMs < 0)
            || Buffer.byteLength(JSON.stringify(deferredItems)) > MAX_DEFERRED_BYTES) throw new Error('Invalid deferred items');
        /** @type {{ seenContentIds: string[], admissionVersion?: number, deferredObservations?: Array<[string, number]>, deferredItems?: any[], nextRemoteCheckAtMs?: number, baselineMaxNumericContentId?: string }} */
        const cursor = { seenContentIds, ...(deferredObservations.length ? { deferredObservations } : {}) };
        if (deferredItems.length) cursor.deferredItems = deferredItems;
        if (value?.nextRemoteCheckAtMs !== undefined) {
            if (!Number.isSafeInteger(value.nextRemoteCheckAtMs) || value.nextRemoteCheckAtMs < 0) throw new Error('Invalid remote observation schedule');
            cursor.nextRemoteCheckAtMs = value.nextRemoteCheckAtMs;
        }
        if (value?.admissionVersion === 1) cursor.admissionVersion = 1;
        if (/^\d{1,20}$/.test(String(value?.baselineMaxNumericContentId || ''))) {
            cursor.baselineMaxNumericContentId = String(value.baselineMaxNumericContentId);
        }
        return cursor;
    } catch (error) {
        if (typeof raw === 'string' && raw.includes('"deferredItems"') || raw && typeof raw === 'object' && Object.hasOwn(raw, 'deferredItems')) {
            throw Object.assign(new Error('The durable discovery backlog could not be read.', { cause: error }), { code: 'AUTO_WATCH_INVALID_BACKLOG' });
        }
        return { seenContentIds: [] };
    }
}

function normalizeItems(items) {
    const ids = new Set();
    return (Array.isArray(items) ? items : []).filter(item => {
        const id = String(item?.contentId || '');
        const url = String(item?.url || '');
        if (!id || !url || ids.has(id)) return false;
        ids.add(id);
        return true;
    });
}

function advanceCursor(cursor, observed, acknowledged, { seed = false } = {}) {
    const old = new Set(cursor.seenContentIds);
    const accepted = new Set((acknowledged || []).map(item => String(item.contentId)));
    const ids = [];
    const seen = new Set();
    const add = id => {
        // Keep the same first-seen order and final window without accumulating
        // the full history or scanning the growing array for each observation.
        if (!id || ids.length >= MAX_CURSOR_IDS || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    for (const item of observed) {
        const id = String(item.contentId);
        if (seed || old.has(id) || accepted.has(id)) add(id);
    }
    for (const id of cursor.seenContentIds) add(String(id));
    return { ...cursor, seenContentIds: ids };
}

function sourceRetryAt(source, now, error) {
    const retryAfterMs = Number(error?.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return now + retryAfterMs;
    const failures = Math.max(0, Number(source.failure_count || 0));
    const delay = Math.min(6 * 60 * MINUTE, MINUTE * (2 ** Math.min(failures, 8)));
    return now + delay;
}

function deliveryRetryAt(delivery, now, error) {
    const retryAfterMs = Number(error?.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return now + retryAfterMs;
    const attempts = Math.max(0, Number(delivery.attempt_count || 0));
    return now + Math.min(60 * MINUTE, 30 * 1000 * (2 ** Math.min(attempts, 8)));
}

function retryAfterFromResponse(response, payload) {
    const header = response?.headers?.get?.('retry-after');
    const seconds = Number(header);
    if (header !== null && header !== undefined && header !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    // Discord's JSON body uses seconds, whereas some upstream APIs use a
    // millisecond number. This path is only for Discord webhook delivery.
    const bodySeconds = Number(payload?.retry_after);
    return Number.isFinite(bodySeconds) && bodySeconds >= 0 ? Math.ceil(bodySeconds * 1000) : 60 * 1000;
}

async function processSource(source, context) {
    const { now, store, config, fetch, fetchSource, sourceCounts } = context;
    // A complete durable observation is already independent of upstream health
    // and request budgets. Drain it before attempting any new remote operation.
    let durableCursor;
    try { durableCursor = parseCursor(source.cursor_json); }
    catch (error) {
        await store.failSource(source, { error, nextCheckAtMs: sourceRetryAt(source, now, error), checkedAtMs: now });
        recordError(error, { errorType: 'auto_watch_source_failed', source: 'autoWatchMonitor.processSource', providerId: source.provider_id, sourceId: source.id });
        return { status: 'failed', providerId: source.provider_id, sourceId: source.id, errorCode: error.code };
    }
    if (durableCursor.deferredItems?.length) return drainBacklog(source, durableCursor, context);
    const activeCount = sourceCounts.get(source.provider_id) || 1;
    const pollIntervalMs = store.computedPollInterval(source, activeCount, config);
    const standardNextCheck = now + pollIntervalMs;
    const permit = await store.reserveProviderRequest(source.provider_id, store.policyFor(source.provider_id, config), now);
    if (!permit.allowed) {
        await store.rescheduleSource(source, Math.max(now + 1000, permit.nextCheckAtMs));
        return { status: 'paced', providerId: source.provider_id, sourceId: source.id };
    }

    try {
        const cursor = durableCursor;
        // Legacy ID-only admission checkpoints still need a full observation.
        // Old cursors may already carry a validator for a partially admitted
        // response. Repair them with one full observation at the normal poll.
        const needsFullObservation = !source.initialized_at_ms || cursor.admissionVersion !== 1 || !!cursor.deferredObservations?.length || !!cursor.deferredItems?.length;
        const result = await fetchSource(needsFullObservation
            ? { ...source, etag: null, last_modified: null } : source, { config, fetch, isolate: context.isolateFetch });
        await store.recordProviderRateLimit(source.provider_id, result.rateLimit, now);
        const observed = normalizeItems(result.items);
        const baselineItems = normalizeItems(result.baselineItems);
        const baselineIds = new Set(baselineItems.map(item => String(item.contentId)));
        const isFirstObservation = !source.initialized_at_ms;
        if (result.notModified && needsFullObservation) {
            throw Object.assign(new Error('An unconditional observation cannot establish or drain its baseline from HTTP 304.'), { code: 'AUTO_WATCH_INCOMPLETE_NOT_MODIFIED' });
        }
        if (isFirstObservation) {
            const seededCursor = {
                ...advanceCursor(cursor, observed, observed, { seed: true }),
                ...initialCursor(source.provider_id, observed),
                admissionVersion: 1,
            };
            await store.completeSource(source, {
                state: result.state,
                cursor: seededCursor,
                etag: result.etag,
                lastModified: result.lastModified,
                initializedAtMs: now,
                nextCheckAtMs: standardNextCheck,
                checkedAtMs: now,
            });
            return { status: 'seeded', providerId: source.provider_id, sourceId: source.id, itemCount: observed.length };
        }
        if (result.notModified) {
            await store.completeSource(source, {
                state: result.state,
                cursor,
                etag: result.etag ?? source.etag,
                lastModified: result.lastModified ?? source.last_modified,
                initializedAtMs: now,
                nextCheckAtMs: standardNextCheck,
                checkedAtMs: now,
            });
            return { status: 'not_modified', providerId: source.provider_id, sourceId: source.id };
        }
        const known = new Set(cursor.seenContentIds);
        // A rolling upstream index is not a durable queue. Keep complete first
        // observations locally until admission, even after they leave that index.
        // Old ID-only checkpoints retain their original observation timestamp.
        const previousObservations = new Map(cursor.deferredObservations || []);
        for (const item of cursor.deferredItems || []) previousObservations.set(String(item.contentId), item.discoveredAtMs);
        const pending = normalizeItems([...(cursor.deferredItems || []), ...observed]).filter(item => !known.has(String(item.contentId)) && !baselineIds.has(String(item.contentId))
            && !isHistoricalAtBaseline(source.provider_id, cursor, item));
        const accepted = pending.slice(0, integer(process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE, MAX_NEW_ITEMS_PER_SOURCE, 1, 100));
        const firstObserved = item => previousObservations.get(String(item.contentId)) ?? now;
        const deferredItems = pending.slice(accepted.length).map(item => ({ ...item, contentId: String(item.contentId), discoveredAtMs: firstObserved(item) }));
        const deferredObservations = deferredItems.map(item => [String(item.contentId), item.discoveredAtMs]);
        if (deferredObservations.length > MAX_DEFERRED_IDS) throw Object.assign(new Error('Too many unadmitted discoveries in one observation.'), { code: 'AUTO_WATCH_BACKLOG_LIMIT' });
        if (Buffer.byteLength(JSON.stringify(deferredItems)) > MAX_DEFERRED_BYTES) throw Object.assign(new Error('Unadmitted discoveries exceed their durable metadata budget.'), { code: 'AUTO_WATCH_BACKLOG_LIMIT' });
        const admitted = accepted.map(item => ({ ...item, discoveredAtMs: firstObserved(item) }));
        const nextCursor = advanceCursor(cursor, [...observed, ...accepted, ...baselineItems], [...accepted, ...baselineItems]);
        nextCursor.admissionVersion = 1;
        delete nextCursor.deferredObservations;
        delete nextCursor.deferredItems;
        delete nextCursor.nextRemoteCheckAtMs;
        if (deferredObservations.length) nextCursor.deferredObservations = deferredObservations;
        if (deferredItems.length) { nextCursor.deferredItems = deferredItems; nextCursor.nextRemoteCheckAtMs = standardNextCheck; }
        if (Buffer.byteLength(JSON.stringify(nextCursor)) > 15 * 1024 * 1024) throw Object.assign(new Error('Discovery cursor exceeds its durable metadata budget.'), { code: 'AUTO_WATCH_BACKLOG_LIMIT' });
        if (admitted.length && !store.atomicSourceCompletion) await store.createItemsAndDeliveries(source, admitted, now);
        await store.completeSource(source, {
            items: admitted,
            state: result.state,
            cursor: nextCursor,
            etag: deferredObservations.length ? null : result.etag,
            lastModified: deferredObservations.length ? null : result.lastModified,
            initializedAtMs: now,
            nextCheckAtMs: standardNextCheck,
            checkedAtMs: now,
        });
        return { status: 'processed', providerId: source.provider_id, sourceId: source.id, newItemCount: accepted.length, deferredItemCount: pending.length - accepted.length };
    } catch (error) {
        const retryAt = sourceRetryAt(source, now, error);
        if (error?.code === 'AUTO_WATCH_RATE_LIMITED') await store.cooldownProvider(source.provider_id, retryAt);
        await store.failSource(source, { error, nextCheckAtMs: retryAt, checkedAtMs: now });
        recordError(error, { errorType: 'auto_watch_source_failed', source: 'autoWatchMonitor.processSource', providerId: source.provider_id, sourceId: source.id });
        return { status: 'failed', providerId: source.provider_id, sourceId: source.id, errorCode: error?.code || 'AUTO_WATCH_UPSTREAM_ERROR' };
    }
}

async function drainBacklog(source, cursor, context) {
    const { now, store } = context;
    const delay = integer(process.env.AUTO_WATCH_TICK_MS, DEFAULT_TICK_MS, 5000, 10 * MINUTE);
    try {
        if (typeof store.completeBacklog !== 'function') throw Object.assign(new Error('The atomic discovery backlog store is unavailable.'), { code: 'AUTO_WATCH_BACKLOG_STORE_REQUIRED' });
        const known = new Set(cursor.seenContentIds);
        const pending = normalizeItems(cursor.deferredItems).filter(item => !known.has(String(item.contentId)) && !isHistoricalAtBaseline(source.provider_id, cursor, item));
        const admitted = pending.slice(0, integer(process.env.AUTO_WATCH_MAX_NEW_ITEMS_PER_SOURCE, MAX_NEW_ITEMS_PER_SOURCE, 1, 100));
        if (admitted.some(item => item.discoveredAtMs > now)) throw Object.assign(new Error('The original discovery time is ahead of the local clock.'), { code: 'AUTO_WATCH_BACKLOG_CLOCK_NOT_READY' });
        const remaining = pending.slice(admitted.length), nextCursor = advanceCursor(cursor, admitted, admitted);
        const remoteAt = cursor.nextRemoteCheckAtMs ?? integer(source.next_check_at_ms, now, 0);
        delete nextCursor.deferredItems; delete nextCursor.deferredObservations; delete nextCursor.nextRemoteCheckAtMs;
        if (remaining.length) {
            nextCursor.deferredItems = remaining;
            nextCursor.deferredObservations = remaining.map(item => [String(item.contentId), item.discoveredAtMs]);
            nextCursor.nextRemoteCheckAtMs = remoteAt;
        }
        await store.completeBacklog(source, { items: admitted, cursor: nextCursor, processedAtMs: now,
            nextCheckAtMs: remaining.length ? now + delay : Math.max(now + delay, remoteAt),
            // Retained validators describe the last real HTTP observation.
            etag: source.etag, lastModified: source.last_modified });
        return { status: 'processed', providerId: source.provider_id, sourceId: source.id, newItemCount: admitted.length,
            deferredItemCount: remaining.length, backlogOnly: true, remoteChecked: false };
    } catch (error) {
        // A local transaction failure is not a failed/successful remote check.
        // Preserve the upstream diagnostic and poll/baseline receipts for retry.
        await store.rescheduleSource(source, now + delay);
        recordError(error, { errorType: 'auto_watch_backlog_failed', source: 'autoWatchMonitor.drainBacklog', providerId: source.provider_id, sourceId: source.id });
        return { status: 'failed', providerId: source.provider_id, sourceId: source.id, errorCode: error?.code || 'AUTO_WATCH_BACKLOG_STORE_FAILED', backlogOnly: true, remoteChecked: false };
    }
}

function recoveryRecordFor(delivery) {
    // Recovery quarantine records are durable diagnostic evidence. Never pass
    // the signed Discord webhook URL into that record.
    return {
        id: delivery.id,
        item_id: delivery.item_id,
        target_id: delivery.target_id,
        provider_id: delivery.provider_id,
        content_url: delivery.content_url,
    };
}

async function deliverOne(delivery, context) {
    const { now, store } = context;
    const recoveryRecord = recoveryRecordFor(delivery);
    if (!recoveryBootstrap.notificationAllowed('auto_watch_delivery', recoveryRecord, Number(delivery.discovered_at_ms))) {
        await store.markDeliverySuppressed(delivery, now);
        return { status: 'suppressed', deliveryId: delivery.id };
    }
    try {
        if (typeof store.routeAutomation !== 'function') throw Object.assign(new Error('The guarded automation delivery runner is unavailable.'), { code: 'AUTO_WATCH_AUTOMATION_REQUIRED' });
        return { status: (await store.routeAutomation(delivery, now)).state, deliveryId: delivery.id };
    } catch (error) {
        await store.failDelivery(delivery, {
            error,
            status: error?.status,
            permanent: false,
            nextAttemptAtMs: deliveryRetryAt(delivery, now, error),
            atMs: now,
        });
        recordError(error, { errorType: 'auto_watch_delivery_failed', source: 'autoWatchMonitor.deliverOne', providerId: delivery.provider_id, deliveryId: delivery.id });
        return { status: 'failed', deliveryId: delivery.id, errorCode: error?.code || 'AUTO_WATCH_DISCORD_DELIVERY_FAILED' };
    }
}

async function tick(options = {}) {
    const now = integer(options.now, Date.now(), 0);
    const store = options.store || storeDefault;
    const fetch = options.fetch || fetchDefault;
    const config = monitorConfig(options.config);
    const sourceCounts = await store.activeSourceCounts();
    if (store === storeDefault) {
        const currentTime = () => options.now === undefined ? Date.now() : now;
        const sourcesResult = [], deliveriesResult = [];
        const context = { now, store, fetch, client: options.client || activeClient, fetchSource: options.fetchSource || fetchSourceDefault, config, sourceCounts,
            isolateFetch: !options.fetch && !options.fetchSource };
        // Claim only the work we are about to execute. Batch claiming used to
        // spend later items' entire lease while earlier sources were fetched.
        for (let index = 0; index < integer(options.sourceLimit ?? process.env.AUTO_WATCH_SOURCES_PER_TICK, 16, 1, 128); index++) {
            const due = await store.claimDueSources(currentTime(), 1, config);
            if (!due.length) break;
            sourcesResult.push(await processSource(due[0], { ...context, now: currentTime() }));
        }
        for (let index = 0; index < integer(options.deliveryLimit ?? process.env.AUTO_WATCH_DELIVERIES_PER_TICK, 32, 1, 256); index++) {
            const due = await store.claimDueDeliveries(currentTime(), 1);
            if (!due.length) break;
            deliveriesResult.push(await deliverOne(due[0], { ...context, now: currentTime() }));
        }
        return { now, sources: sourcesResult, deliveries: deliveriesResult };
    }
    const sources = await store.claimDueSources(now, integer(options.sourceLimit ?? process.env.AUTO_WATCH_SOURCES_PER_TICK, 16, 1, 128), config);
    const context = { now, store, fetch, client: options.client || activeClient, fetchSource: options.fetchSource || fetchSourceDefault, config, sourceCounts,
        isolateFetch: !options.fetch && !options.fetchSource };
    const sourcesResult = [];
    // Sources stay sequential. The DB lease and provider-wide pacing are the
    // protection against a cold-start burst and multi-instance overlap.
    for (const source of sources) sourcesResult.push(await processSource(source, context));
    const deliveries = await store.claimDueDeliveries(now, integer(options.deliveryLimit ?? process.env.AUTO_WATCH_DELIVERIES_PER_TICK, 32, 1, 256));
    const deliveriesResult = [];
    // Discord applies a bucket per webhook. Serial delivery avoids creating a
    // local burst while each response still drives a precise retry schedule.
    for (const delivery of deliveries) deliveriesResult.push(await deliverOne(delivery, context));
    return { now, sources: sourcesResult, deliveries: deliveriesResult };
}

function schedule(delayMs) {
    timer = setTimeout(async () => {
        try {
            running = true;
            await tick();
        } catch (error) {
            recordError(error, { errorType: 'auto_watch_tick_failed', source: 'autoWatchMonitor.tick' });
            console.error('[autoWatchMonitor] tick failed:', error?.code || error?.message || error);
        } finally {
            running = false;
            if (timer) schedule(integer(process.env.AUTO_WATCH_TICK_MS, DEFAULT_TICK_MS, 5000, 10 * MINUTE));
        }
    }, delayMs);
}

function start(client = null) {
    if (client) activeClient = client;
    if (timer) return;
    schedule(integer(process.env.AUTO_WATCH_START_DELAY_MS, DEFAULT_START_DELAY_MS, 0, 10 * MINUTE));
}

function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
}

module.exports = {
    start,
    stop,
    tick,
    _internal: {
        advanceCursor,
        deliverOne,
        deliveryRetryAt,
        normalizeItems,
        parseCursor,
        processSource,
        recoveryRecordFor,
    retryAfterFromResponse,
    sourceRetryAt,
        state: () => ({ running, scheduled: Boolean(timer) }),
    },
};
