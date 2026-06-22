'use strict';

const { Events } = require('discord.js');
const { settings } = require('../settings');
const { ifUserHasRole, cleanMessageContent } = require('../utils');
const { extractAllUrls } = require('../providers/_loader');
const { isProviderEnabled, getProviderSettings } = require('../providers/_provider_settings');
const { runSendSteps } = require('../providers/_dispatcher');

function register(client) {
    function shouldIgnoreMessage(message) {
        const isMessageFromClient = message.author.id === client.user.id;
        return isMessageFromClient;
    }

    function normalizeDisableSetting(providerId, guildId, disableSetting) {
        if (disableSetting && typeof disableSetting === 'object') {
            return {
                user: Array.isArray(disableSetting.user) ? disableSetting.user : [],
                channel: Array.isArray(disableSetting.channel) ? disableSetting.channel : [],
                role: Array.isArray(disableSetting.role) ? disableSetting.role : [],
            };
        }

        // 旧 Twitter グローバル disable との互換
        if (providerId === 'twitter') {
            return {
                user: Array.isArray(settings.disable.user) ? settings.disable.user : [],
                channel: Array.isArray(settings.disable.channel) ? settings.disable.channel : [],
                role: Array.isArray(settings.disable.role[guildId]) ? settings.disable.role[guildId] : [],
            };
        }

        return { user: [], channel: [], role: [] };
    }

    function isMessageDisabledForProvider(message, providerId, providerSettings) {
        const disable = normalizeDisableSetting(providerId, message.guild.id, providerSettings.disable);
        const isUserDisabled = disable.user.includes(message.author.id);
        const isChannelDisabled = disable.channel.includes(message.channel.id);
        const isRoleDisabled = !message.webhookId && ifUserHasRole(message.member, disable.role);
        return isUserDisabled || isChannelDisabled || isRoleDisabled;
    }

    client.on(Events.MessageCreate, async message => {
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
        if (shouldIgnoreMessage(message)) return;

        const content = cleanMessageContent(message.content);
        const matches = extractAllUrls(content);

        if (matches.length === 0) return;

        //await ensureUserExistsInDatabase(message.author.id);

        for (const { provider, url } of matches) {
            if (!isProviderEnabled(provider, message.guild.id)) continue;
            const providerSettings = getProviderSettings(provider, message.guild.id);
            if (isMessageDisabledForProvider(message, provider.id, providerSettings)) continue;
            if (message.author.bot && providerSettings.extract_bot_message !== true && !message.webhookId) continue;

            let steps;
            try {
                steps = await provider.extract(message, url, providerSettings);
            } catch (err) {
                console.log(err);
                continue;
            }
            if (Array.isArray(steps)) await runSendSteps(message, steps, provider.id);
        }
    });
}

module.exports = { register };
