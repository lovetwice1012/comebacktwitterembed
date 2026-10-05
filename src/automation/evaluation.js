'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { assertWorkflow } = require('./schema');
const { normalizeEvent } = require('./engine');
const MAX_CACHE_BYTES = 480 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;
const isHeavy = payload => (payload.text?.length || 0) > 2 * 1024 * 1024 || ['dictionary', 'before', 'after'].some(key => (payload[key]?.entries?.length || 0) >= 50000);
const busyError = () => Object.assign(new Error('大きな辞書を処理中です。完了後に再試行してください。'), { name: 'AutomationError', code: 'AUTOMATION_WORKER_BUSY', status: 503 });

// One queued editing payload or running compile owns this process-wide slot.
// Matchers wait with references, before loading SQL-decoded dictionaries.
let heavyOwner = null;
const heavyWaiters = [];
function releaseHeavy(token) {
    if (heavyOwner !== token) return;
    heavyOwner = null;
    while (heavyWaiters.length) {
        const waiter = heavyWaiters.shift();
        waiter.signal.removeEventListener('abort', waiter.abort);
        if (waiter.signal.aborted) continue;
        heavyOwner = { owner: waiter.owner }; waiter.resolve(heavyOwner); break;
    }
}
function acquireHeavy(owner, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    // A queued editor may reserve behind earlier matches in this serial queue.
    // Those matches borrow its reservation without overlapping the edit.
    if (heavyOwner?.owner === owner) return Promise.resolve(null);
    if (!heavyOwner) { heavyOwner = { owner }; return Promise.resolve(heavyOwner); }
    return new Promise((resolve, reject) => {
        const waiter = { owner, signal, resolve, reject, abort: null };
        waiter.abort = () => { const index = heavyWaiters.indexOf(waiter); if (index !== -1) heavyWaiters.splice(index, 1); reject(signal.reason); };
        heavyWaiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
    });
}
function abortable(promise, signal) {
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function createEvaluator(loadDictionary, options = {}) {
    const maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES, maxCacheEntries = options.maxCacheEntries ?? MAX_CACHE_ENTRIES;
    const dictionaryLoadTimeoutMs = options.dictionaryLoadTimeoutMs ?? 60000;
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1 || maxCacheBytes > MAX_CACHE_BYTES || !Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 32) throw new Error('DICTIONARY_CACHE_BUDGET');
    if (!Number.isSafeInteger(dictionaryLoadTimeoutMs) || dictionaryLoadTimeoutMs < 1 || dictionaryLoadTimeoutMs > 60000) throw new Error('DICTIONARY_LOAD_BUDGET');
    let worker = null, chain = Promise.resolve(), queued = 0, shutdown = Promise.resolve();
    const owner = {}, pending = new Map(), contexts = new Set(), resident = new Set();
    const counters = { cacheHits: 0, cacheMisses: 0, dictionaryLoads: 0, workerStarts: 0, workerResets: 0, admissionRejected: 0, heavyWaits: 0 };
    const check = context => { if (context.signal.aborted) throw context.signal.reason; };
    function stop(error = new Error('AUTOMATION_WORKER_STOPPED')) {
        const stopped = worker; worker = null; resident.clear();
        for (const controller of contexts) controller.abort(error);
        for (const { reject, timeout } of pending.values()) { clearTimeout(timeout); reject(error); }
        pending.clear();
        if (stopped) { counters.workerResets++; shutdown = Promise.all([shutdown, stopped.terminate()]).then(() => {}); }
        return shutdown;
    }
    async function request(operation, payload, context, budget = 30000) {
        await shutdown; check(context);
        if (!worker) {
            worker = new Worker(path.join(__dirname, 'evaluation-worker.js'), { workerData: { maxCacheBytes, maxCacheEntries } });
            counters.workerStarts++;
            const startedWorker = worker;
            worker.on('message', message => {
                if (worker !== startedWorker) return;
                const entry = pending.get(message.id);
                if (!entry) return;
                resident.clear(); for (const key of message.residentKeys || []) resident.add(key);
                clearTimeout(entry.timeout); pending.delete(message.id);
                if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error)); else entry.resolve(message.result);
            });
            worker.on('error', error => { if (worker === startedWorker) void stop(error); });
            worker.on('exit', () => { if (worker === startedWorker) void stop(new Error('AUTOMATION_WORKER_EXIT')); });
            worker.unref();
        }
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { void stop(new Error('AUTOMATION_WORKER_TIMEOUT')); }, budget);
            pending.set(id, { resolve, reject, timeout });
            try { worker.postMessage({ id, operation, payload }); }
            catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
        });
    }
    function serialize(task, heavy = false) {
        if (queued >= 32) return Promise.reject(new Error('AUTOMATION_WORKER_QUEUE_FULL'));
        if (heavy && heavyOwner) { counters.admissionRejected++; return Promise.reject(busyError()); }
        const reservation = heavy ? (heavyOwner = { owner }) : null;
        const controller = new AbortController(), context = { signal: controller.signal };
        contexts.add(controller); queued++;
        const result = chain.then(() => { check(context); return abortable(task(context), context.signal); }).finally(async () => {
            contexts.delete(controller); queued--;
            if (reservation) { if (context.signal.aborted) await shutdown; releaseHeavy(reservation); }
        });
        chain = result.catch(() => {});
        return result;
    }
    async function heavyMatch(context, work) {
        if (heavyOwner && heavyOwner.owner !== owner) counters.heavyWaits++;
        const token = await acquireHeavy(owner, context.signal);
        try { check(context); return await work(); }
        finally { if (token) { if (context.signal.aborted) await shutdown; releaseHeavy(token); } }
    }
    const ruleKey = ref => 'rule:' + JSON.stringify([ref.id, ref.revision]);
    async function load(key, ref, context, moderation) {
        if (resident.has(key)) { counters.cacheHits++; return; }
        counters.cacheMisses++;
        await heavyMatch(context, async () => {
            let dictionary = null;
            if (ref?.id) {
                counters.dictionaryLoads++;
                let timer;
                try {
                    // A stalled SQL loader must not keep every evaluator's
                    // heavy-work slot forever. Late results are never posted.
                    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AUTOMATION_DICTIONARY_LOAD_TIMEOUT')), dictionaryLoadTimeoutMs); });
                    dictionary = await abortable(Promise.race([loadDictionary(ref.id, ref.revision), timeout]), context.signal);
                } finally { clearTimeout(timer); }
            }
            check(context);
            await request(moderation === undefined ? 'load' : 'load-moderation', { key, dictionary, useStarter: moderation }, context, 60000);
        });
    }
    function evaluate(workflow, input, bindings = {}, now = Date.now()) {
        assertWorkflow(workflow);
        const event = normalizeEvent(input);
        return serialize(async context => {
            const matches = Object.create(null);
            for (const node of workflow.nodes.filter(n => n.type === 'dictionary')) {
                const alias = node.config.dictionary, ref = bindings.dictionaries?.[alias];
                if (!ref) continue;
                const key = ruleKey(ref);
                await load(key, ref, context);
                matches[alias] ||= Object.create(null);
                for (const field of node.config.fields) {
                    const value = event[field];
                    if (value == null) continue;
                    const text = Array.isArray(value) ? value.join('\n') : String(value);
                    if (!Object.hasOwn(matches[alias], text)) matches[alias][text] = await request('match', { key, text, limit: 8 }, context);
                }
            }
            return request('evaluate', { workflow, event, matches, now }, context);
        });
    }
    function match(ref, text) {
        return serialize(async context => { const key = ruleKey(ref); await load(key, ref, context); return request('match', { key, text }, context); });
    }
    function dictionaryTask(payload) { return serialize(context => request('dictionary', payload, context, 60000), isHeavy(payload)); }
    function matchModeration(policy, text) {
        return serialize(async context => {
            const key = 'moderation:' + JSON.stringify([!!policy.useStarter, policy.id || null, policy.revision || 0]);
            await load(key, policy, context, !!policy.useStarter);
            return request('match', { key, text, limit: 5 }, context);
        });
    }
    function stats() {
        return serialize(async context => ({ ...counters, maxCacheBytes, maxCacheEntries, queued: queued - 1,
            worker: worker ? await request('stats', {}, context) : null }));
    }
    return { evaluate, match, stop, dictionaryTask, matchModeration, stats };
}
module.exports = { createEvaluator };
