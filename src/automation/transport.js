'use strict';

const { REST, Routes, MessagePayload } = require('discord.js');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { hash } = require('./service');
const { webhookParts } = require('./destinations');
const { createSafety, SafetyError } = require('./safety');
const FILE_LIMIT = 25 * 1024 * 1024;
const failure = (code, status) => Object.assign(new Error(code), { code, status });
const toJSON = value => typeof value?.toJSON === 'function' ? value.toJSON() : structuredClone(value);

function publicAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 88, 168].includes(b)) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
    }
    // Restrict IPv6 to global-unicast space; reject mapped IPv4, loopback,
    // link-local, ULA and other non-global classes.
    return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address) && !/^2002:|^2001:db8:/i.test(address) && !(address.toLowerCase().startsWith('2001:') && parseInt(address.split(':')[1] || '0', 16) < 0x200);
}
async function publicFile(raw, redirects = 0) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || redirects > 3) throw failure('UNSAFE_MEDIA_URL');
    const records = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!records.length || records.some(r => !publicAddress(r.address))) throw failure('UNSAFE_MEDIA_ADDRESS');
    const pinned = records[0];
    const agent = new https.Agent({ lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family) });
    try {
        const response = await require('../providerFetch').withDeadline(require('node-fetch'))(url.href, { agent, redirect: 'manual', size: FILE_LIMIT, timeout: 15000 });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            response.body?.destroy();
            return publicFile(new URL(response.headers.get('location'), url).href, redirects + 1);
        }
        if (!response.ok) throw failure('MEDIA_FETCH_FAILED', response.status);
        return await response.buffer();
    } finally { agent.destroy(); }
}
function splitText(text, size = 1900) {
    const chunks = [];
    for (let remaining = String(text || ''); remaining;) {
        let cut = Math.min(size, remaining.length);
        if (cut < remaining.length && /[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut--;
        chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut);
    }
    return chunks;
}
function filterMedia(payload, mode) {
    if (mode === 'inherit') return payload;
    const links = [];
    const embeds = (payload.embeds || []).map(raw => {
        const embed = toJSON(raw);
        for (const key of ['image', 'thumbnail', 'video']) {
            if (mode === 'links' && /^https:\/\//.test(embed[key]?.url || '')) links.push(embed[key].url);
            delete embed[key];
        }
        return embed;
    });
    for (const file of payload.files || []) {
        const url = typeof file === 'string' ? file : file.fallbackUrl || (typeof file.attachment === 'string' ? file.attachment : '');
        if (mode === 'links' && /^https:\/\//.test(url)) links.push(url);
    }
    return { ...payload, embeds, files: [], content: [payload.content, ...links].filter(Boolean).join('\n').slice(0, 1900) };
}

// Aggregates describe the observations already admitted to the queue. They
// must not fan out into one fresh provider fetch per member at delivery time.
// Rich summaries are built from snapshots; missing media is never invented.
function snapshotSteps(plan, kind, expandedSnapshot = false) {
    const event = plan.event || {}, display = plan.display;
    if (plan.defaultPriceText) return splitText(plan.defaultPriceText).map(content => ({ content, flags: 4 }));
    if (display.format === 'text' || display.format === 'url') return splitText(plan.text).map(content => ({ content, flags: 4 }));
    if (display.format === 'card' || display.format === 'expanded' && (kind === 'price' || expandedSnapshot)) {
        const fields = [];
        if (display.format === 'expanded' && kind === 'price') {
            if (event.priceAmount !== undefined) fields.push({ name: '観測価格', value: `${event.priceAmount} ${event.currency || ''}`, inline: true });
            if (event.priceDelta !== undefined) fields.push({ name: '増減', value: `${event.priceDelta > 0 ? '+' : ''}${event.priceDelta} ${event.currency || ''}`, inline: true });
            if (event.discountPercent !== undefined) fields.push({ name: '割引率', value: `${event.discountPercent}%`, inline: true });
        }
        return [{ embeds: [{ title: (event.title || (kind === 'price' ? '価格通知' : '通知')).slice(0, 256), description: String(plan.text || '').slice(0, 4096),
            ...(fields.length ? { fields } : {}), ...(/^https:\/\//.test(event.url || '') ? { url: event.url } : {}),
            ...(display.format === 'expanded' && Number.isFinite(event.observedAtMs) ? { timestamp: new Date(event.observedAtMs).toISOString() } : {}) }] }];
    }
    return null;
}
function packSnapshotSteps(steps) {
    const packed = [];
    const embedSize = embed => [embed.title, embed.description, embed.author?.name, embed.footer?.text, ...(embed.fields || []).flatMap(field => [field.name, field.value])].reduce((n, value) => n + String(value || '').length, 0);
    for (const step of steps) {
        const last = packed.at(-1);
        if (last && !last.embeds?.length && !step.embeds?.length && last.flags === step.flags && String(last.content || '').length + String(step.content || '').length + 2 <= 1900) last.content += `\n\n${step.content}`;
        else if (last?.embeds?.length && step.embeds?.length && !last.content && !step.content && last.flags === step.flags && last.embeds.length + step.embeds.length <= 10 && [...last.embeds, ...step.embeds].reduce((n, embed) => n + embedSize(embed), 0) <= 6000) last.embeds.push(...step.embeds);
        else packed.push(structuredClone(step));
    }
    return packed;
}

function createTransport(db, destinations, client, options = {}) {
    const safety = options.safety || createSafety();
    const preparedJobs = new WeakMap();
    // Separate REST manager: do not change the main Bot's retry behavior.
    // Rejected rate-limit requests never entered the wire; HTTP 5xx/network
    // failures after submission remain unknown and are never retried here.
    const token = process.env.DISCORD_BOT_TOKEN;
    const rest = options.rest || new REST({ retries: 0, timeout: 20000, rejectOnRateLimit: () => true }).setToken(token || 'unconfigured');
    async function prepare(job, destination) {
        if (!options.rest && !token) throw failure('DISCORD_BOT_TOKEN_REQUIRED');
        let channelId, webhook = null, channelNsfw = false, member = null, recipient = null;
        if (destination.kind === 'dm') {
            if (destination.dm_user_id !== job.owner_user_id) throw failure('DM_OWNER_MISMATCH', 403);
            const dm = await rest.post(Routes.userChannels(), { body: { recipient_id: destination.dm_user_id } });
            channelId = dm.id; recipient = dm.recipients?.find(user => user.id === job.owner_user_id) || null;
        } else {
            const endpoints = await db.queryDatabase('SELECT webhook_url FROM webhook_endpoints WHERE id=?', [destination.webhook_endpoint_id]);
            if (!endpoints[0]) throw failure('WEBHOOK_DELETED', 404);
            webhook = webhookParts(endpoints[0].webhook_url);
            const current = await rest.get(Routes.webhook(webhook.id, webhook.token), { auth: false });
            channelId = job.destination_id ? destination.channel_id : current.channel_id;
            if (current.channel_id !== channelId || current.guild_id !== destination.guild_id || current.type !== 1) throw failure('WEBHOOK_MOVED', 403);
            const verified = await destinations.verifyChannel({ userId: job.owner_user_id }, destination.guild_id, channelId);
            member = verified.member; channelNsfw = verified.channel.nsfw === true;
        }
        const plan = job.plan, event = plan.event;
        let steps;
        if (plan.members) steps = packSnapshotSteps(plan.members.flatMap(entry => {
            const memberPlan = { ...plan, ...entry, display: entry.display || plan.display };
            return snapshotSteps(memberPlan, entry.targetKind || job.target_kind, true).map(step => filterMedia(step, memberPlan.display.media));
        }));
        else steps = snapshotSteps(plan, job.target_kind);
        if (!steps && plan.display.format === 'expanded') {
            const { loadProviders } = require('../providers/_loader');
            const { getProviderSettings, PROVIDER_DEFAULTS } = require('../providers/_provider_settings');
            const provider = loadProviders().find(p => p.id === event.providerId);
            if (!provider) throw failure('PROVIDER_NOT_FOUND');
            if (job.target_kind === 'auto' && !options.skipProviderBudget) {
                const auto = require('../providers/autoWatch');
                const autoStore = require('../providers/autoWatch/store');
                const policy = auto.ratePolicy(event.providerId);
                const permit = await autoStore.reserveProviderRequest(event.providerId, { ...policy, requestCost: 8, globalSpacingMs: Math.max(policy.globalSpacingMs, policy.globalSpacingMs / policy.requestCost * 8) }, Date.now());
                if (!permit.allowed) throw Object.assign(failure('AUTOMATION_PROVIDER_PACED'), { retryAfterMs: Math.max(1000, permit.nextCheckAtMs - Date.now()) });
            } else if (job.target_kind === 'price' && !options.skipProviderBudget) {
                const price = require('../providers/priceWatch');
                const priceStore = require('../providers/priceWatch/store');
                const permit = await priceStore.reserveProvider(event.providerId, price.provider(event.providerId).globalSpacingMs * 8, Date.now());
                if (!permit.allowed) throw Object.assign(failure('AUTOMATION_PROVIDER_PACED'), { retryAfterMs: Math.max(1000, permit.nextCheckAtMs - Date.now()) });
            }
            const renderGuildId = destination.kind === 'dm' ? null : destination.guild_id;
            const settings = renderGuildId ? await getProviderSettings(provider, renderGuildId) : { ...structuredClone(PROVIDER_DEFAULTS), enabled: true, defaultLanguage: plan.context.locale };
            if (renderGuildId && settings.enabled !== true) throw failure('PROVIDER_DISABLED', 403);
            const disabled = settings.disable || {};
            if ((disabled.user || []).includes(job.owner_user_id) || (disabled.channel || []).includes(channelId) || (disabled.role || []).some(role => member?.roles?.includes(role))) throw failure('PROVIDER_TARGET_DISABLED', 403);
            const user = { id: job.owner_user_id, bot: false, username: recipient?.username || member?.user?.username || client?.users?.cache?.get?.(job.owner_user_id)?.username || '自動通知' };
            const noSend = async () => { throw failure('EXTRACTOR_SEND_FORBIDDEN'); };
            const message = { id: '0', client, author: user, user, guildId: renderGuildId, guild: renderGuildId ? { id: renderGuildId } : null,
                channelId, channel: { id: channelId, nsfw: channelNsfw, send: noSend }, content: event.url,
                member: member ? { roles: { cache: new Map(member.roles.map(id => [id, { id }])) } } : null,
                reply: noSend, delete: async () => {}, suppressEmbeds: async () => {} };
            const extracted = await require('./fetch-budget').runBoundedFetches(4, () => provider.extract(message, event.url, settings));
            // null can mean a provider's own content safety filter suppressed
            // the output. Do not bypass that decision with a raw-URL fallback.
            if (!Array.isArray(extracted) || !extracted.length) throw failure('PROVIDER_NO_OUTPUT', 403);
            steps = extracted.map(step => ({ content: step.content, embeds: step.embeds, components: step.components, files: step.files }));
            if (steps[0]) steps[0].content = [plan.text, steps[0].content].filter(Boolean).join('\n').slice(0, 1900);
        }
        if (!steps?.length || steps.length > 128) throw failure('MESSAGE_STEPS_LIMIT');
        const payloads = [];
        for (const rawStep of steps) {
            const step = plan.members ? rawStep : filterMedia(rawStep, plan.display.media);
            const files = [];
            let total = 0;
            for (const file of step.files || []) {
                const value = typeof file === 'string' ? file : file.attachment;
                const buffer = Buffer.isBuffer(value) ? value : typeof value === 'string' && /^https:\/\//.test(value) ? await publicFile(value) : null;
                if (!buffer) throw failure('UNSUPPORTED_ATTACHMENT');
                total += buffer.length;
                if (total > FILE_LIMIT || files.length >= 10) throw failure('ATTACHMENT_LIMIT');
                files.push({ attachment: buffer, name: typeof file === 'object' && file.name ? String(file.name).replace(/[\\/\r\n]/g, '_').slice(0, 120) : `attachment-${files.length}.bin` });
            }
            const target = /** @type {any} */ ({ client });
            const payload = MessagePayload.create(target, { ...step, files, allowedMentions: { parse: [], repliedUser: false }, enforceNonce: false });
            payload.resolveBody(); await payload.resolveFiles();
            const body = /** @type {any} */ (payload.body);
            if (!body.content && !body.embeds?.length && !payload.files?.length) continue;
            payloads.push({ body, files: payload.files });
        }
        if (!payloads.length) throw failure('EMPTY_NOTIFICATION');
        const prepared = { channelId, webhook, payloads, channelNsfw };
        preparedJobs.set(prepared, job.id);
        return prepared;
    }
    async function sendStep(prepared, job, index) {
        if (preparedJobs.get(prepared) !== job.id || !Number.isInteger(index) || !prepared.payloads[index]) throw new SafetyError('SAFETY_UNPREPARED_MESSAGE');
        await require('./package-safety').assertPackageSafety(db.queryDatabase, job);
        // All formats and destinations converge here. Recheck each part so a
        // cached/prepared job is not permission to bypass a changed policy.
        await safety.assertNotification(prepared, job);
        await options.beforeSubmit?.(job);
        require('./delivery-gate').assertWindowOpen(job, (options.clock || Date.now)());
        const payload = prepared.payloads[index];
        if (!prepared.webhook) {
            payload.body.nonce = hash(`${job.id}:${index}`).slice(0, 24);
            payload.body.enforce_nonce = true;
        }
        const ticket = prepared.webhook ? require('./outbound-guard').begin(prepared.webhook.id, prepared.channelId, payload.body) : null;
        try {
            const message = prepared.webhook
                ? await rest.post(Routes.webhook(prepared.webhook.id, prepared.webhook.token), { ...payload, auth: false, query: new URLSearchParams({ wait: 'true' }) })
                : await rest.post(Routes.channelMessages(prepared.channelId), payload);
            if (!/^\d{16,22}$/.test(message?.id || '') || message.channel_id !== prepared.channelId) throw failure('DELIVERY_UNKNOWN');
            ticket?.sent(message.id);
            return message.id;
        } catch (error) {
            const status = Number(error.status);
            ticket?.failed(!(status >= 400 && status < 500) && error.name !== 'RateLimitError');
            throw error;
        }
    }
    return { prepare, sendStep, readiness: () => safety.status ? safety.status().available : true };
}
module.exports = { createTransport, publicAddress, splitText, filterMedia, snapshotSteps, packSnapshotSteps };
