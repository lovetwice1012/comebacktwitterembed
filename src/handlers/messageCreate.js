'use strict';

const { Events } = require('discord.js');
const { ifUserHasRole, cleanMessageContent } = require('../utils');
const { extractAllUrls } = require('../providers/_loader');
const { getProviderSettings } = require('../providers/_provider_settings');
const { runSendSteps } = require('../providers/_dispatcher');
const {
    recordAnalyticsEvent = () => {},
    recordError,
    recordMetric,
    recordProviderContentEvent = () => {},
    runWithErrorContext = (_context, fn) => fn(),
} = require('../errorTracking');

function register(client) {
    const fetchedMessageMembers = new WeakMap();

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
        if (isUserDisabled || isChannelDisabled) return true;
        if (message.webhookId || disable.role.length === 0) return false;

        const member = await getMessageMember(message);
        if (!member) return false;
        return ifUserHasRole(member, disable.role);
    }

    client.on(Events.MessageCreate, async message => {
       if (!message.guild) return;
       if (message.guild.id !== '1132814274734067772' || message.channel.id !== '1279100351034953738') return;
       
         if (message.crosspostable) {
           message.crosspost()
           .then(() => message.react("✅"))
           .catch(console.error);
         } else {
           message.react("❌")
        }
    });

    client.on(Events.MessageCreate, async (message) => runWithErrorContext({
        source: 'messageCreate',
        message,
    }, async () => {
        if (!message.guild) return;
        if (shouldIgnoreMessage(message)) return;

        const content = cleanMessageContent(message.content);
        const matches = extractAllUrls(content);

        if (matches.length === 0) return;

        //await ensureUserExistsInDatabase(message.author.id);

        for (const { provider, url } of matches) {
            await runWithErrorContext({
                source: 'messageCreate.provider',
                providerId: provider.id,
                message,
                url,
            }, async () => {
            const providerSettings = await getProviderSettings(provider, message.guild.id);
            if (providerSettings.enabled !== true) return;
            if (await isMessageDisabledForProvider(message, providerSettings)) return;
            if (message.author.bot && providerSettings.extract_bot_message !== true && !message.webhookId) return;

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
                console.log(err);
                return;
            }
            if (Array.isArray(steps)) {
                recordMetric('provider_extract_success', { providerId: provider.id, message, url });
                recordAnalyticsEvent('provider_extract', {
                    source: 'messageCreate.providerExtract',
                    providerId: provider.id,
                    message,
                    url,
                    success: true,
                    durationMs: Date.now() - startedAt,
                    details: { outcome: 'success', extracted: summarizeSendSteps(steps) },
                });
                recordProviderContentEvent({
                    source: 'messageCreate.providerExtract',
                    providerId: provider.id,
                    steps,
                    message,
                    url,
                    guildId: message.guildId ?? message.guild?.id,
                    channelId: message.channelId ?? message.channel?.id,
                    authorUserId: message.author?.id,
                });
                await runSendSteps(message, steps, provider.id, { url });
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
            });
        }
    }));
}

module.exports = { register };
