'use strict';

const crypto = require('crypto');
const { PermissionsBitField, Collection } = require('discord.js');
const telemetry = require('./telemetry');
const discord = require('./discord');
const { extractAllUrls, loadProviders } = require('../providers/_loader');
const providerSettings = require('../providers/_provider_settings');

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function defaults(provider) {
    const out = {};
    for (const key of Object.keys(providerSettings.PROVIDER_DEFAULTS)) {
        const value = providerSettings._internal.settingDefault(provider, key);
        if (value !== undefined) out[key] = value;
    }
    out.disable ||= { user: [], channel: [], role: [] };
    out.bannedWords ||= [];
    out.button_invisible ||= {};
    out.button_disabled ||= { user: [], channel: [], role: [] };
    return out;
}
function resolveProvider(input) {
    const url = String(input.url || '').trim();
    if (url.length > 4096) throw new Error('URL is longer than 4096 characters.');
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('A plain HTTP(S) URL is required.');
    const matches = extractAllUrls(url).filter(match => !input.providerId || match.provider.id === input.providerId);
    if (!matches.length) throw Object.assign(new Error('No installed provider recognizes this URL.'), { code: 'UNSUPPORTED_URL' });
    return { provider: matches[0].provider, url: matches[0].url };
}
async function makeContext(input, replay) {
    if (replay && input.context) return input.context;
    const context = { guildId: input.guildId || null, channelId: input.channelId || null, userId: input.userId || null,
        roleIds: [], permissions: '0', nsfw: false, checkedAt: new Date().toISOString(), unevaluated: [] };
    if (replay) {
        context.unevaluated.push('Saved Discord context is missing. Offline replay will not query Discord; channel, member and permission rules cannot be reproduced.');
        return context;
    }
    if (input.guildId && input.channelId) {
        const target = await discord.resolve(input);
        context.guild = target.guild; context.channel = target.channel;
        context.nsfw = target.channel.nsfw === true;
        if (target.channel.parent_id) {
            const parent = await discord.rest(`/channels/${target.channel.parent_id}`);
            context.parent = parent.data;
            context.nsfw ||= parent.data.nsfw === true;
        }
        const [me, roles] = await Promise.all([discord.rest('/users/@me'), discord.rest(`/guilds/${input.guildId}/roles`)]);
        const bot = await discord.rest(`/guilds/${input.guildId}/members/${me.data.id}`);
        const { PermissionFlagsBits } = require('discord.js');
        const ids = [input.guildId, ...bot.data.roles];
        let bits = roles.data.filter(role => ids.includes(role.id)).reduce((value, role) => value | BigInt(role.permissions), 0n);
        const guildPermissions = bits;
        if (!(bits & PermissionFlagsBits.Administrator)) {
            const overwrites = target.channel.permission_overwrites || context.parent?.permission_overwrites || [];
            const everyone = overwrites.find(item => item.type === 0 && item.id === input.guildId);
            if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
            let deny = 0n, allow = 0n;
            for (const item of overwrites.filter(row => row.type === 0 && bot.data.roles.includes(row.id))) { deny |= BigInt(item.deny); allow |= BigInt(item.allow); }
            bits = (bits & ~deny) | allow;
            const member = overwrites.find(item => item.type === 1 && item.id === me.data.id);
            if (member) bits = (bits & ~BigInt(member.deny)) | BigInt(member.allow);
        }
        context.permissions = bits.toString(); context.guildPermissions = guildPermissions.toString();
        context.botUser = me.data; context.botMember = bot.data; context.roles = roles.data;
        if (input.userId) {
            const member = await discord.rest(`/guilds/${input.guildId}/members/${discord.id(input.userId, 'userId')}`);
            context.member = member.data; context.roleIds = member.data.roles; context.user = member.data.user;
        } else context.unevaluated.push('No target user supplied: user and role dependent rules use an unspecified diagnostic user.');
    } else context.unevaluated.push('No complete guild/channel context supplied: channel permissions, NSFW state, member roles and source-message actions are unverified.');
    return context;
}
function makeMessage(context, url, plannedEffects, messageContent = url) {
    const record = (type, input) => { plannedEffects.push({ type, input: telemetry.serializable(input) }); return Promise.resolve(null); };
    const roles = new Collection((context.roleIds || []).map(value => [value, { id: value }]));
    const permission = new PermissionsBitField(context.permissions || '0');
    const author = { id: context.userId || 'diagnostic-user-unspecified', username: context.user?.username || 'diagnostic-user-unspecified', bot: false };
    const channel = { id: context.channelId, name: context.channel?.name, nsfw: context.nsfw,
        parent: context.parent, type: context.channel?.type, send: input => record('send', input),
        permissionsFor: () => permission, isThread: () => [10, 11, 12].includes(context.channel?.type) };
    const message = { id: null, guildId: context.guildId, channelId: context.channelId,
        guild: { id: context.guildId, name: context.guild?.name,
            members: { me: { permissions: new PermissionsBitField(context.guildPermissions || context.permissions || '0') } } },
        member: { roles: { cache: roles }, permissions: permission }, channel, author, user: author,
        content: messageContent, client: { user: context.botUser || { id: 'diagnostic-bot' } },
        reply: input => record('reply', input), delete: () => record('delete_source', {}),
        suppressEmbeds: value => record('suppress_source_embeds', { value }) };
    return message;
}
async function inspect(input, actionId, options = {}) {
    const { provider, url } = resolveProvider(input);
    const httpAttempts = [], events = [], plannedEffects = [], resultState = {};
    const parentEvents = telemetry.current()?.events;
    const replay = options.replay === true;
    const baseSettings = input.guildId && !replay
        ? await providerSettings.getProviderSettings(provider, discord.id(input.guildId, 'guildId')) : defaults(provider);
    let settings = { ...baseSettings, ...(input.settings || {}), ...(input.settingsOverrides || {}) };
    settings = structuredClone(settings);
    const context = await makeContext(input, replay);
    const originalHash = hash(settings);
    return telemetry.run({ trace_id: actionId, operation_id: actionId, request_id: actionId,
        guild_id: input.guildId, channel_id: input.channelId, user_id: input.userId, provider_id: provider.id,
        url, trigger_type: 'diagnostic', preview: true, httpAttempts, events, parentEvents, plannedEffects, resultState,
        providerSourceId: input.sourceId, providerSourceFallback: typeof input.sourceFallback === 'boolean' ? input.sourceFallback : undefined,
        replay: replay ? input.httpAttempts || [] : null, replayState: { consumed: new Set() } }, async () => {
        const started = performance.now();
        telemetry.event('request', 'request.started', { input: url, settings, settingsHash: originalHash });
        let steps = null, error = null;
        const disable = settings.disable || {};
        const disabled = settings.enabled !== true ? 'provider_disabled'
            : (disable.channel || []).includes(input.channelId) ? 'channel_disabled'
                : (disable.user || []).includes(input.userId) ? 'user_disabled'
                    : (disable.role || []).some(value => context.roleIds?.includes(value)) ? 'role_disabled' : null;
        if (disabled) telemetry.markOutcome('skipped', disabled, { disable, context });
        else {
            try {
                const message = makeMessage(context, url, plannedEffects, input.messageContent || url);
                steps = await provider.extract(message, url, settings, { preview: true });
                await telemetry.settle();
            } catch (cause) {
                error = telemetry.errorData(cause);
                telemetry.markOutcome('failed', 'extract_exception', { error });
            }
        }
        const serializedSteps = telemetry.serializable(steps || []);
        for (const step of serializedSteps) {
            if (step.deleteSource) plannedEffects.push({ type: 'delete_source', input: {} });
            if (step.suppressSourceEmbeds) plannedEffects.push({ type: 'suppress_source_embeds', input: {} });
        }
        const outcome = resultState.outcome || (serializedSteps.length ? 'preview_generated' : 'no_output_reason_unrecorded');
        telemetry.event('request', 'request.completed', { outcome, reason: resultState.reason, steps: serializedSteps,
            plannedEffects, durationMs: performance.now() - started });
        return { runId: actionId, triggerType: 'diagnostic', url, providerId: provider.id, settings, settingsHash: hash(settings),
            requestedSettingsHash: originalHash, context, outcome, reason: resultState.reason, error,
            steps: serializedSteps, planned_outputs: serializedSteps, plannedEffects, httpAttempts, events,
            durationMs: performance.now() - started, replayed: replay, sourcePolicy: telemetry.current()?.sourcePolicy,
            buildRevision: process.env.BOT_BUILD_REVISION || 'unknown' };
    });
}
module.exports = { inspect, defaults, hash, resolveProvider, makeMessage, providers: loadProviders };
