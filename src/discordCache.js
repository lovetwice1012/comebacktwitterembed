'use strict';

function createDiscordCacheOptions(discord = require('discord.js')) {
    const { Options } = discord;
    const keepClient = value => value.id === value.client.user?.id;
    return {
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            // Interactions contain the original message; historical messages are
            // fetched explicitly when needed. Ordinary chat must not accumulate.
            MessageManager: 0,
            GuildMemberManager: { maxSize: 2, keepOverLimit: keepClient },
            UserManager: { maxSize: 1000, keepOverLimit: keepClient },
            ReactionManager: 0,
            ReactionUserManager: 0,
            PresenceManager: 0,
            GuildScheduledEventManager: 0,
        }),
    };
}

// Message.member is normally a lookup in the guild cache. Preserve the member
// received with this message before awaiting, so eviction cannot change role
// checks (including sensitive-content restrictions) during extraction.
function retainMessageMember(message, member = message.member) {
    if (member) Object.defineProperty(message, 'member', { value: member, configurable: true });
}

module.exports = { createDiscordCacheOptions, retainMessageMember };
