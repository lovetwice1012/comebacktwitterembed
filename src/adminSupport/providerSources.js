'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const telemetry = require('./telemetry');

const REGISTRY = Object.freeze({
    twitter: Object.freeze({ providerId: 'twitter', defaultSourceId: 'vxtwitter',
        sources: Object.freeze([
            Object.freeze({ id: 'vxtwitter', origin: 'https://api.vxtwitter.com', label: 'VxTwitter API' }),
            Object.freeze({ id: 'fxtwitter', origin: 'https://api.fxtwitter.com', label: 'FxTwitter API' }),
        ]),
        maxTtlSeconds: 86400, defaultTtlSeconds: 900,
    }),
});
let cached = null;
let loadedAt = 0;
let cachedPath = null;
const storagePath = () => path.resolve(process.env.ADMIN_PROVIDER_OVERRIDE_FILE || path.join(process.env.ADMIN_SUPPORT_DATA_DIR || path.resolve(__dirname, '../..'), 'provider-source-overrides.json'));

async function readState(force = false) {
    const file = storagePath();
    if (!force && cached && cachedPath === file && Date.now() - loadedAt < 250) return cached;
    let state;
    try {
        state = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!state || state.version !== 1 || !state.overrides || typeof state.overrides !== 'object') throw new Error('Invalid source override document.');
    } catch (error) {
        if (error.code !== 'ENOENT') throw Object.assign(new Error('Registered provider source overrides could not be read.'), { code: 'SOURCE_OVERRIDE_UNAVAILABLE', cause: error });
        state = { version: 1, revision: 'initial', overrides: {} };
    }
    cached = state; cachedPath = file; loadedAt = Date.now();
    return state;
}

async function writeState(state) {
    const file = storagePath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    }
    cached = state; cachedPath = file; loadedAt = Date.now();
}

async function sources() {
    const state = await readState(true);
    return { registry: REGISTRY, revision: state.revision,
        overrides: Object.fromEntries(Object.entries(state.overrides).map(([providerId, value]) => [providerId, {
            ...value, active: Date.parse(value.expiresAt) > Date.now(),
        }])), observedAt: new Date().toISOString() };
}

async function switchSource(input) {
    const registry = REGISTRY[input.providerId];
    if (!registry) throw new Error('This provider does not support registered source switching.');
    if (input.sourceId !== 'default' && !registry.sources.some(source => source.id === input.sourceId)) throw Object.assign(new Error('Unknown registered source ID; arbitrary endpoint URLs are not accepted.'), { code: 'UNREGISTERED_SOURCE' });
    const ttlSeconds = input.ttlSeconds ?? registry.defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > registry.maxTtlSeconds) throw new Error(`ttlSeconds must be an integer from 1 to ${registry.maxTtlSeconds}.`);
    const state = await readState(true);
    if (input.expectedRevision && input.expectedRevision !== state.revision) throw Object.assign(new Error('The source policy changed; reload its revision before applying.'), { code: 'SOURCE_REVISION_CONFLICT' });
    const before = state.overrides[input.providerId] || null;
    const next = structuredClone(state);
    next.revision = crypto.randomUUID();
    if (input.sourceId === 'default') delete next.overrides[input.providerId];
    else next.overrides[input.providerId] = {
        sourceId: input.sourceId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        actionId: telemetry.current()?.operation_id || null, actorUserId: process.env.ADMIN_OWNER_ID || 'system',
    };
    await writeState(next);
    const after = next.overrides[input.providerId] || null;
    telemetry.event('source_policy', 'changed', { providerId: input.providerId, before, after, revision: next.revision });
    return { providerId: input.providerId, before, override: after, revision: next.revision,
        reflectionStatus: 'Saved. Bot observes the file on subsequent requests within 250 ms; actual used source is recorded in request evidence.' };
}

async function resolvePlan(providerId) {
    const registry = REGISTRY[providerId];
    if (!registry) throw new Error('Provider has no registered sources.');
    const context = telemetry.current();
    let sourceId = context?.providerSourceId;
    if (sourceId === 'default') sourceId = undefined;
    let origin = 'diagnostic';
    let fallback = context?.providerSourceFallback;
    let expiresAt = null;
    let revision = null;
    if (context?.replay && !sourceId) {
        const first = context.replay.find(attempt => registry.sources.some(source => attempt.url?.startsWith(`${source.origin}/`)));
        sourceId = registry.sources.find(source => first?.url?.startsWith(`${source.origin}/`))?.id || registry.defaultSourceId;
        origin = 'saved_http_evidence'; fallback ??= true;
    }
    if (!sourceId) {
        let state;
        try { state = await readState(); }
        catch (error) {
            telemetry.event('source_policy', 'failed', { error: telemetry.errorData(error), fallback: 'registered_default' });
            state = { revision: null, overrides: {} };
            origin = 'default_override_unavailable';
        }
        const override = state.overrides[providerId];
        const active = override && Date.parse(override.expiresAt) > Date.now();
        sourceId = active ? override.sourceId : registry.defaultSourceId;
        expiresAt = active ? override.expiresAt : null;
        revision = state.revision;
        if (origin !== 'default_override_unavailable') origin = active ? 'temporary_override' : 'default';
        fallback ??= true;
    }
    const selected = registry.sources.find(source => source.id === sourceId);
    if (!selected) throw Object.assign(new Error('Source ID is not registered.'), { code: 'UNREGISTERED_SOURCE' });
    const plan = { providerId, sourceId, origin, expiresAt, revision,
        sources: fallback ? [selected, ...registry.sources.filter(source => source.id !== sourceId)] : [selected] };
    if (context) context.sourcePolicy = plan;
    telemetry.event('source_policy', 'evaluated', plan);
    return plan;
}

module.exports = { REGISTRY, sources, switchSource, resolvePlan, storagePath };
