'use strict';

const fetch = require('node-fetch');
const { ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField } = require('discord.js');
const { counters } = require('./state');
const { t } = require('./locales');
const { videoExtensions, isUnknownMessageError, sendContentPromise } = require('./utils');
const { settings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('./settings');

async function fetchTweetJson(newUrl) {
    let result = await (await fetch(newUrl)).text();
    if (result.startsWith("T")) {
        console.log("<<RATE LIMIT>>:" + result + new Date().toLocaleString());
    }
    if (result.startsWith("<")) {
        result = await (await fetch(newUrl.replace("api.vxtwitter.com", "api.fxtwitter.com"))).text();
    }
    return JSON.parse(result);
}

function fireAltterRequest(tweetURL) {
    const altter = tweetURL.replace(/twitter.com/g, 'altterx.sprink.cloud');
    fetch(altter).then(res => res.text()).catch(() => {});
}

function buildTweetButtons(language) {
    return {
        deleteButton: new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(t('deleteButtonLabelLocales', language)).setCustomId('delete'),
        translateButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('translateButtonLabelLocales', language)).setCustomId('translate'),
        savetweetButton: new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('savetweetButtonLabelLocales', language)).setCustomId('savetweet'),
    };
}

function containsBannedWord(text, guildId) {
    const list = settings.bannedWords[guildId];
    if (list === undefined) return false;
    return list.some(word => text.includes(word));
}

async function notifyBannedWordAndDelete(message, language) {
    const reply = await message.reply(t('yourcontentsisconteinbannedwordLocales', language));
    setTimeout(async () => {
        await reply.delete().catch(() => {});
        await message.delete().catch(async () => {
            const warn = await message.channel.send(t('idonthavedeletemessagepermissionLocales', language));
            setTimeout(() => warn.delete().catch(() => {}), 3000);
        });
    }, 3000);
}

function applySendTweetGuildDefaults(message) {
    const gid = message.guild.id;
    if (settings.deletemessageifonlypostedtweetlink[gid] === undefined) settings.deletemessageifonlypostedtweetlink[gid] = false;
    if (settings.passive_mode[gid] === undefined) settings.passive_mode[gid] = false;
    if (settings.anonymous_expand[gid] === undefined) settings.anonymous_expand[gid] = false;
    if (settings.secondary_extract_mode[gid] === undefined) settings.secondary_extract_mode[gid] = false;
    if (settings.secondary_extract_mode_multiple_images[gid] === undefined) settings.secondary_extract_mode_multiple_images[gid] = true;
    if (settings.secondary_extract_mode_video[gid] === undefined) settings.secondary_extract_mode_video[gid] = true;
    if (settings.legacy_mode[gid] === undefined) {
        settings.legacy_mode[gid] = message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages);
    }
}

function analyzeMediaUrls(json, guildId) {
    const mediaURLs = json.mediaURLs ?? [];
    const isVideoUrl = el => el.includes('video.twimg.com') || videoExtensions.some(ext => el.includes(ext));
    const containsVideoMedia = mediaURLs.some(isVideoUrl);
    const imageMediaCount = mediaURLs.filter(el => !isVideoUrl(el)).length;
    const containsMultipleImages = imageMediaCount > 1;
    const shouldExtractInSecondaryMode = !settings.secondary_extract_mode[guildId]
        || ((settings.secondary_extract_mode_multiple_images[guildId] ?? true) && containsMultipleImages)
        || ((settings.secondary_extract_mode_video[guildId] ?? true) && containsVideoMedia);
    return { containsVideoMedia, containsMultipleImages, shouldExtractInSecondaryMode };
}

async function sendTweetMessageWithFallback(message, parent, messageObject, alwaysReply) {
    const sender = (alwaysReply && parent === null)
        ? (obj => message.reply(obj))
        : (parent === null ? (obj => message.channel.send(obj)) : (obj => parent.reply(obj)));
    try {
        return await sender(messageObject);
    } catch (err) {
        if (isUnknownMessageError(err)) return null;
        if (messageObject.files !== undefined) {
            await sendContentPromise(message, messageObject.files);
            delete messageObject.files;
            return await message.channel.send(messageObject).catch(e => { console.log(e); return null; });
        }
        return null;
    }
}

async function maybeRecurseQuotedTweet(message, json, depth) {
    const gid = message.guild.id;
    const maxDepth = settings.quote_repost_max_depth[gid] ?? 0;
    if (json.qrtURL !== null
        && (settings.quote_repost_do_not_extract[gid] === undefined || settings.quote_repost_do_not_extract[gid] === false)
        && (maxDepth === 0 || depth < maxDepth)) {
        await sendTweetEmbed(message, json.qrtURL, true, message, false, depth + 1);
        return true;
    }
    return false;
}

async function sendTweetEmbed(message, url, quoted = false, parent = null, saved = false, depth = 0) {
    try {
        let newUrl = url.replace(/twitter.com|x.com/g, 'api.vxtwitter.com');
        if (newUrl.split("/").length > 6 && !newUrl.includes("twidata.sprink.cloud")) {
            newUrl = newUrl.split("/").slice(0, 6).join("/");
        }
        const json = await fetchTweetJson(newUrl);
        fireAltterRequest(json.tweetURL);

        const guildId = message.guild.id;
        const language = settings.defaultLanguage[guildId] ?? "en";

        if (containsBannedWord(json.text, guildId)) {
            await notifyBannedWordAndDelete(message, settings.defaultLanguage[guildId]);
            return;
        }

        if (json.text.length > 1500) json.text = json.text.slice(0, 1500) + '...';
        applySendTweetGuildDefaults(message);

        const { deleteButton, translateButton, savetweetButton } = buildTweetButtons(language);
        const isAnonymousExpandEnabled = settings.anonymous_expand[guildId] === true;
        const requesterDisplayName = isAnonymousExpandEnabled
            ? t('anonymousExpandRequesterLabelLocales', language, true)
            : (message.author?.username ?? message.user.username) + '(id:' + (message.author?.id ?? message.user.id) + ')';
        const requesterLabelPrefix = t('anonymousExpandRequesterPrefixLocales', language, true);
        const tweetAuthorLabel = isAnonymousExpandEnabled
            ? t('anonymousExpandTweetAuthorLabelLocales', language, true)
            : json.user_name;
        const tweetAuthorFooterLabel = isAnonymousExpandEnabled
            ? t('anonymousExpandPostedByPrefixLocales', language, true) + t('anonymousExpandTweetAuthorLabelLocales', language, true)
            : 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')';

        const useCompactEmbed = settings.legacy_mode[guildId] === false && !quoted
            && (settings.deletemessageifonlypostedtweetlink[guildId] === false
                || (settings.deletemessageifonlypostedtweetlink[guildId] === true && message.content != url))
            && !url.includes("twidata.sprink.cloud") && !url.includes("localhost:3088");

        let embed;
        if (useCompactEmbed) {
            embed = {
                url: json.tweetURL,
                description: ':speech_balloon:' + json.replies + ' replies \u2022 :recycle:' + json.retweets + ' retweets \u2022 :heart:' + json.likes + ' likes',
                color: 0x1DA1F2,
                author: { name: requesterLabelPrefix + requesterDisplayName },
                timestamp: new Date(json.date),
            };
            if (settings.passive_mode[guildId] === true) delete embed.description;
        } else {
            embed = {
                title: tweetAuthorLabel,
                url: json.tweetURL,
                description: json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n:speech_balloon:' + json.replies + ' replies \u2022 :recycle:' + json.retweets + ' retweets \u2022 :heart:' + json.likes + ' likes',
                color: 0x1DA1F2,
                author: { name: requesterLabelPrefix + requesterDisplayName },
                footer: { text: tweetAuthorFooterLabel, icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png' },
                timestamp: new Date(json.date),
            };
        }
        if (url.includes("twidata.sprink.cloud") || url.includes("localhost:3088")) {
            embed.title = "<SAVED TWEET> " + embed.title;
            embed.color = 0x00FF00;
        }

        // Article (record/link) handling
        if (json.article) {
            let articleText = '';
            if (json.article.title) articleText += '\uD83D\uDCF0 **' + json.article.title + '**\n';
            if (json.article.preview_text) {
                const currentDescLength = embed.description ? embed.description.length : 0;
                const titleLength = json.article.title ? json.article.title.length + 10 : 0;
                const availableLength = 4096 - currentDescLength - titleLength - 10;
                let previewText = json.article.preview_text;
                if (previewText.length > availableLength && availableLength > 0) {
                    previewText = previewText.slice(0, availableLength) + '...';
                }
                articleText += previewText;
            }
            if (articleText && embed.description) {
                embed.description = embed.description.replace(json.text, json.text + '\n\n' + articleText);
                if (embed.description.length > 4096) embed.description = embed.description.slice(0, 4093) + '...';
            }
            if (json.article.image && (!json.mediaURLs || json.mediaURLs.length === 0)) {
                embed.image = { url: json.article.image };
            }
        }

        const { containsMultipleImages, shouldExtractInSecondaryMode } = analyzeMediaUrls(json, guildId);
        const isSecondarySkipUrl = url.includes("twidata.sprink.cloud") || url.includes("localhost:3088");

        let attachments = [];
        let embeds = [];
        let showMediaAsAttachmentsButton = null;
        let videoflag = false;

        if (json.mediaURLs?.length > 0) {
            if (json.mediaURLs.length > 4 || settings.sendMediaAsAttachmentsAsDefault[guildId] === true) {
                if (json.mediaURLs.length > 10) json.mediaURLs = json.mediaURLs.slice(0, 10);
                attachments = json.mediaURLs;
                embeds.push(embed);
                attachments.forEach(el => { if (videoExtensions.some(ext => el.includes(ext))) videoflag = true; });
                if (settings.sendMediaAsAttachmentsAsDefault[guildId] === true && !videoflag) {
                    showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('showAttachmentsAsEmbedsImagebuttonLocales', settings.defaultLanguage[guildId])).setCustomId('showAttachmentsAsEmbedsImage');
                }
                if (settings.secondary_extract_mode[guildId] === true && !shouldExtractInSecondaryMode && !isSecondarySkipUrl) {
                    await maybeRecurseQuotedTweet(message, json, depth);
                    return;
                }
            } else {
                let compactSingleImageHandled = false;
                json.mediaURLs.forEach(element => {
                    if (element.includes('video.twimg.com')) {
                        attachments.push(element);
                        videoflag = true;
                        return;
                    }
                    showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(t('showMediaAsAttachmentsButtonLocales', settings.defaultLanguage[guildId])).setCustomId('showMediaAsAttachments');
                    if (json.mediaURLs.length > 1) {
                        if (embeds.length == 0) embeds.push(embed);
                        embeds.push({ url: json.tweetURL, image: { url: element } });
                    } else {
                        if (useCompactEmbed) {
                            compactSingleImageHandled = true;
                            return;
                        }
                        embed.image = { url: element };
                        embeds.push(embed);
                    }
                });
                if (compactSingleImageHandled) {
                    const recursed = await maybeRecurseQuotedTweet(message, json, depth);
                    if (!recursed) showMediaAsAttachmentsButton = null;
                    return;
                }
                if (settings.secondary_extract_mode[guildId] === true && !shouldExtractInSecondaryMode && !isSecondarySkipUrl) {
                    await maybeRecurseQuotedTweet(message, json, depth);
                    return;
                }
            }
        } else if (settings.secondary_extract_mode[guildId] === true && !shouldExtractInSecondaryMode && !isSecondarySkipUrl && !json.article) {
            await maybeRecurseQuotedTweet(message, json, depth);
            return;
        }

        if (embeds.length === 0) embeds.push(embed);
        const messageObject = { allowedMentions: { repliedUser: false } };
        if (attachments.length > 0) messageObject.files = attachments;
        const components = [];
        if (showMediaAsAttachmentsButton !== null) {
            components.push({ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] });
        }
        components.push({ type: ComponentType.ActionRow, components: embeds[0].title ? [translateButton, deleteButton, savetweetButton] : [deleteButton] });
        messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(components, message.guildId);
        messageObject.embeds = embeds;
        if (quoted) messageObject.content = "Quoted tweet:";

        if (settings.legacy_mode[guildId] === true && message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            try { await message.suppressEmbeds(true); } catch (err) { /* ignore */ }
        }

        const alwaysReply = settings.alwaysreplyifpostedtweetlink[guildId] === true;
        await sendTweetMessageWithFallback(message, parent, messageObject, alwaysReply);

        if (settings.deletemessageifonlypostedtweetlink[guildId] === true && message.content == url) {
            if (settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[guildId] === undefined) settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[guildId] = false;
            if (settings.deletemessageifonlypostedtweetlink_secoundaryextractmode[guildId] === true && settings.secondary_extract_mode[guildId] === true) {
                await message.suppressEmbeds(true);
            } else {
                await message.delete().catch(async () => {
                    const warn = await message.channel.send(t('idonthavedeletemessagepermissionLocales', settings.defaultLanguage[guildId]));
                    setTimeout(async () => { await warn.delete().catch(() => {}); }, 3000);
                });
            }
        }

        await maybeRecurseQuotedTweet(message, json, depth);
        counters.processed++;
        counters.processed_hour++;
        counters.processed_day++;
    } catch (err) {
        console.log(err);
        throw err;
    }
}

module.exports = { sendTweetEmbed };
