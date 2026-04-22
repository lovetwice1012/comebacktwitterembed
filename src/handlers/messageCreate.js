'use strict';

const { Events } = require('discord.js');
const { settings } = require('../settings');
const { ifUserHasRole, cleanMessageContent, extractTwitterUrls } = require('../utils');
const { sendTweetEmbed } = require('../twitter');

function register(client) {
    function shouldIgnoreMessage(message) {
        const isBotMessageNotExtracted = message.author.bot && settings.extract_bot_message[message.guild.id] !== true && !message.webhookId;
        const isMessageFromClient = message.author.id === client.user.id;
        return isBotMessageNotExtracted || isMessageFromClient;
    }

    function isMessageDisabledForUserOrChannel(message) {
        const isUserDisabled = settings.disable.user.includes(message.author.id);
        const isChannelDisabled = settings.disable.channel.includes(message.channel.id);
        const isRoleDisabled = !message.webhookId && settings.disable.role[message.guild.id] !== undefined && ifUserHasRole(message.member, settings.disable.role[message.guild.id]);

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
        const urls = extractTwitterUrls(content);

        if (urls.length === 0) return;
        if (isMessageDisabledForUserOrChannel(message)) return;

        //await ensureUserExistsInDatabase(message.author.id);

        for (const url of urls) {
            await sendTweetEmbed(message, url);
        }
    });
}

module.exports = { register };
