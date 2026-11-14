'use strict';

// Discord REST targets must match the authenticated Bot and the scoped guild,
// channel and message before any content or attachment can authorize a write.
function isExpected(message, interaction, expectedId) {
    const id = message?.id;
    return isLocated(message, interaction) && (expectedId === null || typeof expectedId === 'string' && id === expectedId)
        && !!interaction?.client?.user?.id && message.author?.id === interaction.client.user.id;
}
function isLocated(message, interaction) {
    return typeof message?.id === 'string' && /^\d{1,25}$/.test(message.id)
        && typeof interaction?.guildId === 'string' && !!interaction.guildId && message.guildId === interaction.guildId
        && typeof interaction?.channelId === 'string' && !!interaction.channelId && message.channelId === interaction.channelId;
}
module.exports = { isExpected, isLocated };
