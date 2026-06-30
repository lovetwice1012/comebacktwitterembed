'use strict';

const { Events } = require('discord.js');
const { ifUserHasRole, cleanMessageContent } = require('../utils');
const { extractAllUrls } = require('../providers/_loader');
const { getProviderSettings } = require('../providers/_provider_settings');
const { runSendSteps } = require('../providers/_dispatcher');
const { recordError, recordMetric } = require('../errorTracking');

function register(client) {
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

    function isMessageDisabledForProvider(message, providerSettings) {
        const disable = normalizeDisableSetting(providerSettings.disable);
        const isUserDisabled = disable.user.includes(message.author.id);
        const isChannelDisabled = disable.channel.includes(message.channel.id);
        const isRoleDisabled = !message.webhookId && ifUserHasRole(message.member, disable.role);
        return isUserDisabled || isChannelDisabled || isRoleDisabled;
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

    client.on(Events.MessageCreate, async (message) => {
        if (!message.guild) return;
        if (shouldIgnoreMessage(message)) return;

        const content = cleanMessageContent(message.content);
        const matches = extractAllUrls(content);

        if (matches.length === 0) return;

        //await ensureUserExistsInDatabase(message.author.id);

        for (const { provider, url } of matches) {
            const providerSettings = await getProviderSettings(provider, message.guild.id);
            if (providerSettings.enabled !== true) continue;
            if (isMessageDisabledForProvider(message, providerSettings)) continue;
            if (message.author.bot && providerSettings.extract_bot_message !== true && !message.webhookId) continue;

            let steps;
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
                console.log(err);
                continue;
            }
            if (Array.isArray(steps)) {
                recordMetric('provider_extract_success', { providerId: provider.id, message, url });
                await runSendSteps(message, steps, provider.id);
            } else {
                recordMetric('provider_extract_empty', { providerId: provider.id, message, url });
            }
        }
    });
}

module.exports = { register };
