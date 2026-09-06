'use strict';

// A DB-independent write-ahead log. Event IDs survive retries; the agent must
// acknowledge durable ingestion before a segment is removed.
const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();
const bootId = crypto.randomUUID();
let sequence = 0;
let timer;
let spoolWorker;
let spoolFailure = null;
let spoolHealth = { durableSequence: 0, pendingSequence: 0, diskBytes: 0, rejectedEvents: 0 };
let queuedBytes = 0;
const queuedSizes = new Map();
const pendingTasks = new Set();
const root = () => path.resolve(process.env.ADMIN_TELEMETRY_DIR || path.join(__dirname, '../../logs/admin-telemetry'));
const enabled = () => Boolean(process.env.ADMIN_AGENT_TOKEN || process.env.ADMIN_TELEMETRY_ENABLED === '1');


function serializable(value) {
    if (value === undefined) return null;
    const ancestors = [];
    return JSON.parse(JSON.stringify(value, function (key, item) {
        if (/^(authorization|cookie|set-cookie|token|password|secret)$/i.test(key)) return '[credential omitted]';
        if (typeof item === 'bigint') return String(item);
        if (typeof item === 'function') return undefined;
        if (item instanceof Error) return errorData(item);
        if (item && typeof item === 'object') {
            while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.includes(item)) return '[circular]';
            ancestors.push(item);
        }
        return item;
    }));
}
function errorData(error, depth = 0) {
    if (!error) return null;
    return { name: error.name || 'Error', message: String(error.message || error), code: error.code,
        status: error.status || error.statusCode, stack: error.stack,
        rawError: error.rawError, originalError: error.originalError, reconciliation: error.reconciliation,
        cause: depth < 4 && error.cause ? errorData(error.cause, depth + 1) : undefined };
}
function contextFromMessage(message) {
    const interaction = Boolean(message?.customId || message?.commandName || message?.isChatInputCommand);
    return { guild_id: message?.guildId || message?.guild?.id || null,
        channel_id: message?.channelId || message?.channel?.id || null,
        user_id: message?.author?.id || message?.user?.id || null,
        message_id: interaction ? message?.message?.id || null : message?.id || null,
        interaction_id: interaction ? message?.id : null, guild_name: message?.guild?.name,
        channel_name: message?.channel?.name, user_name: message?.author?.username || message?.user?.username };
}
function current() { return storage.getStore(); }
function run(context, fn) {
    const parent = current();
    return storage.run({ ...parent, ...context, trace_id: context.trace_id || parent?.trace_id || crypto.randomUUID(),
        operation_id: context.operation_id || parent?.operation_id || crypto.randomUUID() }, fn);
}
function event(stage, kind, details = {}, extra = {}) {
    const context = current() || {};
    const row = serializable({ event_id: crypto.randomUUID(), trace_id: context.trace_id || crypto.randomUUID(),
        operation_id: context.operation_id, request_id: context.request_id,
        parent_span_id: context.parent_span_id, span_id: extra.span_id || crypto.randomUUID(),
        sequence: ++sequence, stage, kind, occurred_at: new Date().toISOString(),
        boot_id: bootId, build_revision: process.env.BOT_BUILD_REVISION || 'unknown', instrumentation_version: 1,
        fleet_node: process.env.CBTE_FLEET_NODE, fleet_epoch: process.env.CBTE_FLEET_EPOCH,
        trigger_type: context.trigger_type || 'user', guild_id: context.guild_id, channel_id: context.channel_id,
        user_id: context.user_id, message_id: context.message_id, provider_id: context.provider_id,
        interaction_id: context.interaction_id,
        url: context.url, ...extra, actor_id: context.actor_id, initiated_via: context.initiated_via, details });
    Object.assign(row, { eventId: row.event_id, runId: row.request_id || row.trace_id, requestId: row.request_id,
        guildId: row.guild_id, channelId: row.channel_id, userId: row.user_id, provider: row.provider_id,
        triggerType: row.trigger_type, occurredAt: row.occurred_at, actorId: row.actor_id, initiatedVia: row.initiated_via });
    if (context.events) context.events.push(row);
    if (context.parentEvents && context.parentEvents !== context.events) context.parentEvents.push(row);
    if (context.preview) return row;
    if (enabled()) {
        try {
            if (!spoolWorker) {
                spoolWorker = new Worker(path.join(__dirname, 'telemetrySpool.js'), { workerData: { root: root(), bootId } });
                spoolWorker.on('message', message => {
                    if (message.type === 'health') {
                        spoolHealth = { ...spoolHealth, ...message };
                        spoolFailure = message.error;
                        for (const [seq, bytes] of queuedSizes) if (seq <= message.durableSequence) { queuedBytes -= bytes; queuedSizes.delete(seq); }
                    }
                    if (message.type === 'rejected') {
                        spoolHealth.rejectedEvents++;
                        queuedBytes -= queuedSizes.get(message.sequence) || 0;
                        queuedSizes.delete(message.sequence);
                        spoolFailure = message.error;
                    }
                });
                spoolWorker.on('error', error => { spoolFailure = errorData(error); spoolWorker = null; });
                spoolWorker.unref();
            }
            const bytes = Buffer.byteLength(JSON.stringify(row));
            if (queuedBytes + bytes > 16 * 1024 * 1024) {
                spoolHealth.rejectedEvents++;
                spoolFailure = 'Telemetry writer backlog exceeded 16 MiB; evidence was not persisted.';
            } else {
                queuedSizes.set(row.sequence, bytes); queuedBytes += bytes;
                spoolWorker.postMessage({ type: 'event', row });
            }
        } catch (error) { spoolFailure = errorData(error); spoolHealth.rejectedEvents++; }
    }
    return row;
}
function pending(promise) {
    pendingTasks.add(promise);
    promise.finally(() => pendingTasks.delete(promise)).catch(() => {});
    return promise;
}
function deferCapture(finalize) {
    const context = current();
    if (!context) return;
    context.captureFinalizers ||= new Set();
    context.captureFinalizers.add(finalize);
}
async function settle() {
    const finalizers = current()?.captureFinalizers;
    if (finalizers?.size) {
        const callbacks = [...finalizers]; finalizers.clear();
        await Promise.allSettled(callbacks.map(callback => callback()));
    }
    await Promise.allSettled([...pendingTasks]);
}
async function flush() { spoolWorker?.postMessage({ type: 'flush' }); }
async function stop() {
    clearInterval(timer); timer = null;
    const worker = spoolWorker;
    if (!worker) return;
    await new Promise(resolve => {
        const timeout = setTimeout(resolve, 6000);
        worker.on('message', message => { if (message.type === 'stopped') { clearTimeout(timeout); resolve(); } });
        worker.postMessage({ type: 'stop' });
    });
    await worker.terminate(); spoolWorker = null;
}
function start(client) {
    if (timer || !enabled()) return;
    event('runtime', 'started', { pid: process.pid, node: process.version });
    for (const name of ['shardDisconnect', 'shardReconnecting', 'shardResume', 'invalidated', 'error', 'warn']) {
        client?.on(name, (...args) => event('gateway', name, { args: args.map(item => item instanceof Error ? errorData(item) : item) }));
    }
    timer = setInterval(() => {
        event('runtime', 'heartbeat', { pid: process.pid, uptime_seconds: process.uptime(), memory: process.memoryUsage(),
            gateway_ping_ms: client?.ws?.ping, ready: client?.isReady?.(), recording_failure: spoolFailure, recording_health: { ...spoolHealth, queuedBytes, durabilityWindowMs: 50 },
            queue: require('../workQueue').messageWorkQueue.snapshot() });
        void flush();
    }, 15000);
    timer.unref();
    void flush();
}
function markOutcome(outcome, reason, details = {}) {
    const context = current();
    if (context?.resultState) Object.assign(context.resultState, { outcome, reason });
    return event('decision', outcome, { reason_code: reason, ...details });
}
function planEffect(type, input, execute) {
    event('effect', current()?.preview ? 'planned' : 'started', { type, input });
    if (current()?.preview) {
        current().plannedEffects?.push({ type, input });
        return null;
    }
    return execute();
}
module.exports = { run, current, event, start, stop, flush, settle, deferCapture, pending, enabled, markOutcome, planEffect,
    contextFromMessage, errorData, serializable, bootId };
