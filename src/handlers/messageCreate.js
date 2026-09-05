'use strict';

const { Events } = require('discord.js');
const crypto = require('crypto');
const telemetry = require('../adminSupport/telemetry');
const {
    ifUserHasRole,
    cleanMessageContent,
    isMissingPermissionsError,
    isUnknownMessageError,
} = require('../utils');
const { extractAllUrls } = require('../providers/_loader');
const { getProviderSettings } = require('../providers/_provider_settings');
const { runSendSteps } = require('../providers/_dispatcher');
const { retainMessageMember } = require('../discordCache');
const { messageWorkQueue } = require('../workQueue');
const {
    recordAnalyticsEvent = () => {},
    recordError,
    recordMetric,
    recordProviderContentEvent = () => {},
    runWithErrorContext = (_context, fn) => fn(),
} = require('../errorTracking');

function register(client) {
    const fetchedMessageMembers = new WeakMap();
    const recentMessageIds = new Map();

    function truncateText(value, maxLength = 1000) {
        if (value === undefined || value === null) return null;
        const text = String(value);
        return text.length > maxLength ? text.slice(0, maxLength) : text;
    }

    function summarizeEmbed(embed) {
        const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
        if (!data || typeof data !== 'object') return null;
        return {
            title: truncateText(data.title),
            description: truncateText(data.description, 2000),
            url: truncateText(data.url, 2000),
            author: truncateText(data.author?.name),
            provider: truncateText(data.provider?.name),
            footer: truncateText(data.footer?.text),
            fields: Array.isArray(data.fields)
                ? data.fields.slice(0, 12).map(field => ({
                    name: truncateText(field?.name, 300),
                    value: truncateText(field?.value, 1000),
                }))
                : [],
        };
    }

    function summarizeSendSteps(steps) {
        if (!Array.isArray(steps)) return null;
        return {
            step_count: steps.length,
            embeds: steps
                .flatMap(step => Array.isArray(step.embeds) ? step.embeds : [])
                .map(summarizeEmbed)
                .filter(Boolean)
                .slice(0, 8),
            file_count: steps.reduce((sum, step) => sum + (Array.isArray(step.files) ? step.files.length : 0), 0),
            component_count: steps.reduce((sum, step) => sum + (Array.isArray(step.components) ? step.components.length : 0), 0),
            content: steps.map(step => truncateText(step.content, 1000)).filter(Boolean).slice(0, 8),
        };
    }

    function shouldIgnoreMessage(message) {
        const isMessageFromClient = message.author.id === client.user.id;
        return isMessageFromClient;
    }

    function normalizeDisableSetting(disableSetting) {
        if (disableSetting && typeof disableSetting === 'object') {
            return {
                user: Array.isArray(disableSetting.user) ? disableSetting.user : [],
                channel: Array.isArray(disableSetting.channel) ? disableSetting.channel : [],
                role: Array.isArray(disableSetting.role) ? disableSetting.role : [],
            };
        }

        // 旧 Twitter グローバル disable との互換
        return { user: [], channel: [], role: [] };
    }

    async function fetchMessageMember(message) {
        const userId = message?.author?.id;
        if (!userId || typeof message?.guild?.members?.fetch !== 'function') return null;
        try {
            return await message.guild.members.fetch(userId);
        } catch (err) {
            recordError(err, {
                fallbackType: 'message_member_fetch_failed',
                source: 'messageCreate.fetchMember',
                message,
                userId,
            });
            return null;
        }
    }

    async function getMessageMember(message) {
        if (message.member) return message.member;
        if (!message || typeof message !== 'object') return null;
        if (!fetchedMessageMembers.has(message)) {
            fetchedMessageMembers.set(message, fetchMessageMember(message));
        }
        return fetchedMessageMembers.get(message);
    }

    async function isMessageDisabledForProvider(message, providerSettings) {
        const disable = normalizeDisableSetting(providerSettings.disable);
        const isUserDisabled = disable.user.includes(message.author.id);
        const isChannelDisabled = disable.channel.includes(message.channel.id);
        if (isUserDisabled || isChannelDisabled) { telemetry.markOutcome('skipped', isUserDisabled ? 'user_disabled' : 'channel_disabled', { disable, userId: message.author.id, channelId: message.channel.id }); return true; }
        if (message.webhookId || disable.role.length === 0) return false;

        const member = await getMessageMember(message);
        if (!member) return false;
        const disabled = ifUserHasRole(member, disable.role);
        if (disabled) telemetry.markOutcome('skipped', 'role_disabled', { disable, roles: [...member.roles.cache.keys()] });
        return disabled;
    }

    client.on(Events.MessageCreate, async message => {
        if (!message.guild) return;
        if (message.guild.id !== '1132814274734067772' || message.channel.id !== '1279100351034953738') return;

        try {
            if (message.crosspostable) {
                await message.crosspost();
                await message.react('✅');
            } else {
                await message.react('❌');
            }
        } catch (err) {
            const expected = isUnknownMessageError(err) || isMissingPermissionsError(err);
            recordError(err, {
                errorType: isUnknownMessageError(err)
                    ? 'discord_unknown_message'
                    : (isMissingPermissionsError(err) ? 'discord_missing_permissions' : 'discord_announcement_failed'),
                severity: expected ? 'warn' : 'error',
                source: 'messageCreate.announcement',
                message,
            });
            const detail = err?.rawError?.message || err?.message || String(err);
            console.warn(`[messageCreate] Announcement action failed: ${detail}`);
        }
    });

    let lastOverloadWarningAt = -Infinity;
    client.on(Events.MessageCreate, message => telemetry.run({ ...telemetry.contextFromMessage(message), trigger_type: 'user' }, () => {
        // All supported URLs contain ://. Skip ordinary chat before creating
        // promises, error contexts, or running every provider's regex.
        if (!message.guild || shouldIgnoreMessage(message) || !message.content?.includes('://')) return;
        telemetry.event('input', 'received', { content: message.content, bot: message.author?.bot, webhookId: message.webhookId });
        let matches;
        try {
            matches = extractAllUrls(cleanMessageContent(message.content));
            if (matches.length === 0) { telemetry.event('recognition', 'skipped', { reason: 'unsupported_url', content: message.content }); return; }
            const now = Date.now();
            for (const [id, timestamp] of recentMessageIds) {
                if (timestamp > now - 300000) break;
                recentMessageIds.delete(id);
            }
            if (message.id && recentMessageIds.has(message.id)) { telemetry.event('recognition', 'skipped', { reason: 'duplicate_message' }); return; }
            retainMessageMember(message);
            if (message.id) {
                if (recentMessageIds.size >= 10000) recentMessageIds.delete(recentMessageIds.keys().next().value);
                recentMessageIds.set(message.id, now);
            }
        } catch (err) {
            recordError(err, { fallbackType: 'message_create_failed', source: 'messageCreate.match', message });
            return;
        }
        matches = matches.map(match => ({ ...match, requestId: crypto.randomUUID(), receivedStart: performance.now() }));
        for (const match of matches) telemetry.run({ request_id: match.requestId, provider_id: match.provider.id, url: match.url }, () => {
            telemetry.event('request', 'request.started', { url: match.url, queueSnapshot: messageWorkQueue.snapshot() });
        });
        telemetry.event('queue', 'enqueued', { snapshot: messageWorkQueue.snapshot() });
        const queuedAt = performance.now();
        return messageWorkQueue.run(() => runWithErrorContext({
            source: 'messageCreate',
            message,
        }, async () => {
            telemetry.event('queue', 'started', { waitMs: performance.now() - queuedAt, snapshot: messageWorkQueue.snapshot() });
            // A referenced/forwarded message can evict the sender even while
            // discord.js constructs this message. Restore its member once,
            // before any provider's synchronous role-sensitive checks run.
            if (!message.member && !message.webhookId) {
                retainMessageMember(message, await getMessageMember(message));
            }
            for (const { provider, url, requestId, receivedStart } of matches) {
                const resultState = /** @type {any} */ ({});
                const requestStarted = receivedStart;
                await telemetry.run({ request_id: requestId, provider_id: provider.id, url, resultState }, async () => {
                telemetry.event('request', 'processing', { url, queueWaitMs: performance.now() - queuedAt });
                try { await runWithErrorContext({
                    source: 'messageCreate.provider',
                    providerId: provider.id,
                    message,
                    url,
                }, async () => {
                    const providerSettings = await getProviderSettings(provider, message.guild.id);
                    telemetry.event('settings', 'evaluated', { settings: providerSettings, hash: require('../adminSupport/inspect').hash(providerSettings), memberRoles: message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : null });
                    if (providerSettings.enabled !== true) { telemetry.markOutcome('skipped', 'provider_disabled'); return; }
                    if (await isMessageDisabledForProvider(message, providerSettings)) return;
                    if (message.author.bot && providerSettings.extract_bot_message !== true && !message.webhookId) { telemetry.markOutcome('skipped', 'bot_message_disabled'); return; }

                    let steps;
                    const startedAt = Date.now();
                    recordMetric('provider_extract_attempt', { providerId: provider.id, message, url });
                    try {
                        steps = await provider.extract(message, url, providerSettings);
                    } catch (err) {
                        recordError(err, {
                            fallbackType: 'provider_extract_failed',
                            source: 'messageCreate.providerExtract',
                            providerId: provider.id,
                            message,
                            url,
                        });
                        recordMetric('provider_extract_error', { providerId: provider.id, message, url });
                        recordAnalyticsEvent('provider_extract', {
                            source: 'messageCreate.providerExtract',
                            providerId: provider.id,
                            message,
                            url,
                            success: false,
                            durationMs: Date.now() - startedAt,
                            details: { outcome: 'error', error_name: err?.name || null },
                        });
                        telemetry.markOutcome('failed', 'extract_exception', { error: telemetry.errorData(err) });
                        console.log(err);
                        return;
                    }
                    if (Array.isArray(steps)) {
                        const contentFailed = resultState.outcome === 'failed' || steps.some(step => step.outputRole === 'failure_notice');
                        recordMetric(contentFailed ? 'provider_extract_error' : 'provider_extract_success', { providerId: provider.id, message, url });
                        recordAnalyticsEvent('provider_extract', {
                            source: 'messageCreate.providerExtract',
                            providerId: provider.id,
                            message,
                            url,
                            success: !contentFailed,
                            durationMs: Date.now() - startedAt,
                            details: { outcome: contentFailed ? 'failure_notice' : 'success', extracted: summarizeSendSteps(steps) },
                        });
                        if (!contentFailed) recordProviderContentEvent({
                            source: 'messageCreate.providerExtract',
                            providerId: provider.id,
                            steps,
                            message,
                            url,
                            guildId: message.guildId ?? message.guild?.id,
                            channelId: message.channelId ?? message.channel?.id,
                            authorUserId: message.author?.id,
                        });
                        telemetry.event('output', 'generated', { steps });
                        const sendResult = await runSendSteps(message, steps, provider.id, { url });
                        resultState.delivery = sendResult;
                        if (!contentFailed && !resultState.outcome) resultState.outcome = sendResult?.outcome || 'U';
                    } else {
                        recordMetric('provider_extract_empty', { providerId: provider.id, message, url });
                        recordAnalyticsEvent('provider_extract', {
                            source: 'messageCreate.providerExtract',
                            providerId: provider.id,
                            message,
                            url,
                            success: null,
                            durationMs: Date.now() - startedAt,
                            details: { outcome: 'empty' },
                        });
                    }
                }); } catch (error) { telemetry.markOutcome('failed', 'request_exception', { error: telemetry.errorData(error) }); }
                finally {
                    let outcome = ({ failed: 'E', skipped: 'S', target_constraint: 'X' })[resultState.outcome] || resultState.outcome || 'U';
                    if (resultState.childFailures?.length && ['F', 'D'].includes(outcome)) outcome = 'P';
                    telemetry.event('request', 'request.completed', { ...resultState }, { outcome, durationMs: performance.now() - requestStarted });
                }
                });
            }
        })).catch(err => {
            if (err?.code === 'WORK_QUEUE_FULL' || err?.code === 'WORK_QUEUE_EXPIRED') {
                telemetry.event('queue', 'rejected', { code: err.code, snapshot: messageWorkQueue.snapshot() });
                for (const match of matches) telemetry.run({ request_id: match.requestId, provider_id: match.provider.id, url: match.url }, () => {
                    telemetry.event('request', 'request.completed', { reason_code: err.code }, { outcome: 'E', durationMs: performance.now() - match.receivedStart });
                });
                recentMessageIds.delete(message.id);
                recordMetric('message_processing_rejected', { message, endpointKey: err.code });
                if (Date.now() - lastOverloadWarningAt >= 60000) {
                    lastOverloadWarningAt = Date.now();
                    console.warn('[messageCreate] Overloaded:', err.code, messageWorkQueue.snapshot());
                }
                return;
            }
            recordError(err, {
                fallbackType: 'message_create_failed',
                source: 'messageCreate.handle',
                message,
            });
            console.error('[messageCreate] Failed to process message:', err);
        });
    }));
}

module.exports = { register };
