'use strict';

/**
 * Provider extractor が返す SendStep[] を実際に Discord へ送信する dispatcher。
 *
 * 各 SendStep は 1 回の Discord 送信単位 + 後処理指示を含む。
 * dispatcher は extractor が返した結果に従い、機械的に送信と後処理を実施する。
 * extractor 内部の挙動はこの dispatcher 自身は一切知らない。
 */

const { isMissingPermissionsError, isUnknownMessageError, sendContentPromise } = require('../utils');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');
const { incrementProcessedCounters } = require('../state');

function fileToFallbackText(file) {
    if (typeof file === 'string') return file;
    if (file && typeof file.attachment === 'string') return file.attachment;
    if (file && typeof file.url === 'string') return file.url;
    return String(file ?? '');
}

function formatSendError(err) {
    return err?.rawError?.message || err?.message || String(err);
}

function logSendFailure(message, err, action = 'send response') {
    const channelId = message.channelId ?? message.channel?.id ?? 'unknown';
    console.warn(`[dispatcher] Failed to ${action} in channel ${channelId}: ${formatSendError(err)}`);
}

/**
 * @param {any} message - 元の Discord メッセージ
 * @param {import('./_types').SendStep[]} steps
 */
async function runSendSteps(message, steps, providerId = null) {
    if (!Array.isArray(steps) || steps.length === 0) return;

    let previousSent = null;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const sendMode = step.send ?? (i === 0 ? 'channel' : 'reply-previous');

        const messageObject = {};
        if (step.embeds && step.embeds.length > 0)         messageObject.embeds = step.embeds;
        if (step.files && step.files.length > 0)           messageObject.files = step.files;
        if (step.components && step.components.length > 0) messageObject.components = checkComponentIncludesDisabledButtonAndIfFindDeleteIt(step.components, message.guildId, providerId);
        if (step.content)                                  messageObject.content = step.content;
        if (step.allowedMentions)                          messageObject.allowedMentions = step.allowedMentions;

        let sender;
        if (sendMode === 'reply-source') {
            sender = (obj) => message.reply(obj);
        } else if (sendMode === 'reply-previous') {
            const target = previousSent ?? message;
            sender = (obj) => target.reply(obj);
        } else {
            sender = (obj) => message.channel.send(obj);
        }

        let sent = null;
        try {
            sent = await sender(messageObject);
        } catch (err) {
            if (isUnknownMessageError(err)) {
                continue;
            }

            if (isMissingPermissionsError(err)) {
                logSendFailure(message, err);
                continue;
            }

            if (messageObject.files !== undefined) {
                try {
                    await sendContentPromise(message, messageObject.files.map(fileToFallbackText).filter(Boolean));
                } catch (fallbackErr) {
                    logSendFailure(message, fallbackErr, 'send fallback attachment URLs');
                    continue;
                }

                delete messageObject.files;
                sent = await message.channel.send(messageObject).catch(e => {
                    if (!isUnknownMessageError(e)) logSendFailure(message, e, 'send response without files');
                    return null;
                });
            } else {
                console.log(err);
            }
        }
        previousSent = sent ?? previousSent;
        if (sent) {
            incrementProcessedCounters();
        }

        if (step.suppressSourceEmbeds) {
            await message.suppressEmbeds(true).catch(() => {});
        }
        if (step.deleteSource) {
            await message.delete().catch(() => {});
        }
    }
}

module.exports = { runSendSteps };
