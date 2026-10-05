'use strict';
const { REST, Routes, escapeMarkdown } = require('discord.js');
const { getStore } = require('./store');
const { boothItem, error } = require('./model');
const { parseStock } = require('../providers/booth/boothSourceParser/stock');
const { monitorConfig, requestJson } = require('../providers/autoWatch/_shared');
const HOUR = 3600000;

function messageFor(job) {
    const ja = String(job.locale || 'ja').startsWith('ja');
    const header = job.kind === 'restock' ? (ja ? 'BOOTHの再入荷を確認しました。' : 'A BOOTH item is available again.')
        : (ja ? '見返す時間になりました。' : 'Here is your reminder.');
    const variation = job.kind === 'restock' && job.variation_id !== '*' ? `\n${ja ? 'バリエーション' : 'Variation'}: ${escapeMarkdown(String(job.variation_name || job.variation_id).slice(0, 100))}` : '';
    return { content: `${header}${variation}`, embeds: [{ title: String(job.title || job.url).slice(0, 150), url: job.url }],
        allowed_mentions: { parse: [] }, nonce: BigInt(`0x${job.id.slice(0, 20)}`).toString(), enforce_nonce: true };
}

function createTransport(client, restOverride) {
    const token = process.env.DISCORD_BOT_TOKEN || client?.token;
    const rest = restOverride || new REST({ retries: 0, timeout: 20000, rejectOnRateLimit: () => true }).setToken(token || 'unconfigured');
    return {
        async prepare(job) {
            if (!restOverride && !token) throw error('DISCORD_BOT_TOKEN_REQUIRED');
            const dm = await rest.post(Routes.userChannels(), { body: { recipient_id: job.user_id } });
            if (!/^\d{16,22}$/.test(String(dm?.id))) throw error('INVALID_DM_RESPONSE');
            return dm.id;
        },
        async send(channelId, job) {
            const sent = await rest.post(Routes.channelMessages(channelId), { body: messageFor(job) });
            if (!/^\d{16,22}$/.test(String(sent?.id))) throw error('DELIVERY_UNKNOWN');
            return sent.id;
        },
    };
}

async function fetchStock(source, fetch) {
    const config = monitorConfig();
    if (!config.enableGuestCrawls) throw Object.assign(error('GUEST_CRAWL_DISABLED'), { retryAfterMs: 6 * HOUR });
    const parsed = boothItem(source.url);
    if (parsed.itemId !== source.item_id) throw error('INVALID_BOOTH_LINK');
    const response = await requestJson({ config, fetch }, `${parsed.url}.json`, { headers: { Accept: 'application/json', 'User-Agent': 'ComebackTwitterEmbed/1.0 (public restock monitor)' } });
    if (!response.body || (response.body.variations?.length || 0) > 1000) throw error('INVALID_STOCK_RESPONSE');
    const stock = parseStock(response.body);
    if (stock.state === 'unknown' && stock.variations.every(v => v.state === 'unknown')) throw error('UNKNOWN_STOCK');
    return stock;
}

function createRunner(options = {}) {
    const store = options.store || getStore();
    const clock = options.clock || Date.now;
    const assertAllowed = options.assertAllowed || require('../recoveryLease').assertAllowed;
    const notificationAllowed = options.notificationAllowed || require('../recoveryBootstrap').notificationAllowed;
    const transport = options.transport || createTransport(options.client);
    const isStopping = options.isStopping || (() => false);
    async function deliver() {
        if (isStopping()) return 'stopped';
        assertAllowed();
        const job = await store.claim(clock());
        if (!job) return 'idle';
        let submitted = false;
        try {
            if (!notificationAllowed('personal_link_notification', { id: job.id, kind: job.kind }, Number(job.created_at_ms))) {
                await store.finish(job, 'quarantined', { code: 'RECOVERY_QUARANTINED' });
                return 'quarantined';
            }
            const destination = await transport.prepare(job);
            if (isStopping()) { await store.finish(job, 'pending'); return 'stopped'; }
            assertAllowed();
            if (!await store.beginSend(job, clock())) return 'cancelled';
            assertAllowed();
            if (isStopping()) { await store.finish(job, 'pending'); return 'stopped'; }
            if (!notificationAllowed('personal_link_notification', { id: job.id, kind: job.kind }, Number(job.created_at_ms))) {
                await store.finish(job, 'quarantined', { code: 'RECOVERY_QUARANTINED' }); return 'quarantined';
            }
            submitted = true;
            const messageId = await transport.send(destination, job);
            await store.finish(job, 'sent', { messageId });
            return 'sent';
        } catch (cause) {
            const status = Number(cause.status || cause.statusCode);
            const throttled = status === 429 || cause.name === 'RateLimitError';
            const rejected = status >= 400 && status < 500 && !throttled;
            const unknown = submitted && !throttled && !rejected;
            const state = unknown ? 'unknown' : rejected || Number(job.attempts) >= 7 ? 'failed' : 'pending';
            const code = unknown ? 'DELIVERY_UNKNOWN' : rejected ? 'DM_REJECTED' : throttled ? 'RATE_LIMITED' : 'DELIVERY_PREPARATION_FAILED';
            const delay = throttled ? Math.max(60000, Number(cause.retryAfter || cause.retryAfterMs) || 0)
                : Math.min(HOUR, 30000 * 2 ** Math.min(Number(job.attempts || 0), 7));
            try { await store.finish(job, state, { code, next: clock() + delay }); }
            catch (error) { report(error); } // Expired sending leases become unknown after restart.
            report(cause);
            return state;
        }
    }
    async function pollStock() {
        if (isStopping()) return 'stopped';
        assertAllowed();
        const source = await store.claimSource(clock());
        if (!source) return 'idle';
        try {
            const providerStore = require('../providers/autoWatch/store');
            const permit = await (options.reserveProvider || (now => providerStore.reserveProviderRequest('booth', require('../providers/autoWatch').ratePolicy('booth'), now)))(clock());
            if (!permit.allowed) { await store.postponeSource(source, permit.nextCheckAtMs); return 'paced'; }
            if (isStopping()) { await store.postponeSource(source, clock() + 30000); return 'stopped'; }
            assertAllowed();
            const stock = await (options.fetchStock || fetchStock)(source, options.fetch);
            return await store.observe(source, stock, clock()) ? 'observed' : 'lease_lost';
        } catch (cause) {
            const next = clock() + Math.max(Number(cause.retryAfterMs) || 0, Math.min(6 * HOUR, 60000 * 2 ** Math.min(Number(source.failure_count || 0), 8)));
            if (Number(cause.status) === 429) await (options.cooldownProvider || (until => require('../providers/autoWatch/store').cooldownProvider('booth', until)))(next);
            await store.postponeSource(source, next, String(cause.code || 'STOCK_FETCH_FAILED').slice(0, 64));
            report(cause);
            return 'failed';
        }
    }
    return { deliver, pollStock, tick: async () => ({ delivery: await deliver(), stock: await pollStock() }) };
}

function report(cause) { require('../errorTracking').recordError(cause, { source: 'personalLinks.runner', fallbackType: 'personal_link_notification_failed' }); }
let control;
function start(client) {
    if (control) return;
    const state = { stopped: false, timers: [], active: new Set() };
    const runner = createRunner({ client, isStopping: () => state.stopped });
    const schedule = (work, delay, index) => {
        if (state.stopped) return;
        state.timers[index] = setTimeout(async () => {
            const active = work(); state.active.add(active);
            try { await active; } catch (error) { report(error); }
            finally { state.active.delete(active); schedule(work, delay, index); }
        }, delay);
        state.timers[index].unref?.();
    };
    control = state;
    // Slow source requests do not delay already-due personal reminders.
    schedule(runner.deliver, 1000, 0);
    schedule(runner.pollStock, 2000, 1);
}
async function stop() {
    const state = control;
    if (!state) return;
    state.stopped = true; state.timers.forEach(clearTimeout); control = null;
    let deadline;
    try { if (state.active.size) await Promise.race([Promise.allSettled([...state.active]), new Promise(resolve => { deadline = setTimeout(resolve, 8000); })]); }
    finally { clearTimeout(deadline); }
}
module.exports = { createRunner, createTransport, fetchStock, messageFor, start, stop };
