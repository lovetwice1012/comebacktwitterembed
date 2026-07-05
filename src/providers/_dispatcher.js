'use strict';

/**
 * Provider extractor が返す SendStep[] を実際に Discord へ送信する dispatcher。
 *
 * 各 SendStep は 1 回の Discord 送信単位 + 後処理指示を含む。
 * dispatcher は extractor が返した結果に従い、機械的に送信と後処理を実施する。
 * extractor 内部の挙動はこの dispatcher 自身は一切知らない。
 */

const { isMissingPermissionsError, isUnknownMessageError } = require('../utils');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');
const { incrementProcessedCounters } = require('../state');
const {
    recordAnalyticsEvent = () => {},
    recordError,
    recordMetric,
    runWithErrorContext = (_context, fn) => fn(),
} = require('../errorTracking');

function fileToFallbackText(file) {
    if (typeof file === 'string') return file;
    if (file && typeof file.attachment === 'string') return file.attachment;
    if (file && typeof file.fallbackUrl === 'string') return file.fallbackUrl;
    if (file && typeof file.url === 'string') return file.url;
    return '';
}

function formatSendError(err) {
    return err?.rawError?.message || err?.message || String(err);
}

function logSendFailure(message, err, action = 'send response') {
    const channelId = message.channelId ?? message.channel?.id ?? 'unknown';
    console.warn(`[dispatcher] Failed to ${action} in channel ${channelId}: ${formatSendError(err)}`);
}

function appendContent(messageObject, content) {
    if (!content) return;
    messageObject.content = [messageObject.content, content].filter(Boolean).join('\n');
}

function hasSendablePayload(messageObject) {
    return Boolean(
        messageObject.content
        || (Array.isArray(messageObject.embeds) && messageObject.embeds.length > 0)
        || (Array.isArray(messageObject.files) && messageObject.files.length > 0)
    );
}

async function suppressSourceEmbeds(message) {
    if (typeof message?.suppressEmbeds !== 'function') return;
    await message.suppressEmbeds(true).catch(() => {});
}

async function deleteSourceMessage(message, providerId = null, context = {}) {
    const trackingContext = /** @type {Record<string, any>} */ ({ ...context, providerId, message });
    if (typeof message?.delete !== 'function') return;
    try {
        await message.delete();
        recordMetric('discord_source_delete_success', trackingContext);
    } catch (err) {
        const missingPermissions = isMissingPermissionsError(err);
        const unknownMessage = isUnknownMessageError(err);
        recordMetric(missingPermissions ? 'discord_source_delete_permission_denied' : 'discord_source_delete_error', trackingContext);
        recordError(err, {
            ...trackingContext,
            errorType: missingPermissions ? 'discord_source_delete_missing_permissions' : (unknownMessage ? 'discord_source_delete_unknown_message' : 'discord_source_delete_failed'),
            severity: 'warn',
            source: 'dispatcher.deleteSource',
        });
        if (!unknownMessage) logSendFailure(message, err, 'delete source message');
    }
}

/**
 * @param {any} message - 元の Discord メッセージ
 * @param {import('./_types').SendStep[]} steps
 */
async function runSendSteps(message, steps, providerId = null, context = {}) {
    const trackingContext = /** @type {Record<string, any>} */ ({ ...context, providerId, message });
    if (trackingContext.url === undefined && trackingContext.rawUrl !== undefined) trackingContext.url = trackingContext.rawUrl;
    return runWithErrorContext(trackingContext, () => runSendStepsNow(message, steps, trackingContext));
}

async function runSendStepsNow(message, steps, trackingContext) {
    const providerId = trackingContext.providerId;
    if (!Array.isArray(steps) || steps.length === 0) return;

    let previousSent = null;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const sendMode = step.send ?? (i === 0 ? 'channel' : 'reply-previous');

        const messageObject = {};
        if (step.embeds && step.embeds.length > 0)         messageObject.embeds = step.embeds;
        if (step.files && step.files.length > 0)           messageObject.files = step.files;
        if (step.components && step.components.length > 0) messageObject.components = await checkComponentIncludesDisabledButtonAndIfFindDeleteIt(step.components, message.guildId, providerId);
        if (step.content)                                  messageObject.content = step.content;
        if (step.allowedMentions)                          messageObject.allowedMentions = step.allowedMentions;

        if (!hasSendablePayload(messageObject)) {
            recordAnalyticsEvent('discord_send', {
                ...trackingContext,
                source: 'dispatcher.send',
                success: null,
                durationMs: 0,
                details: { send_mode: sendMode, step_index: i, outcome: 'no_sendable_payload' },
            });
            if (step.suppressSourceEmbeds) await suppressSourceEmbeds(message);
            if (step.deleteSource) await deleteSourceMessage(message, providerId, trackingContext);
            continue;
        }

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
        let sendFailure = null;
        const startedAt = Date.now();
        recordMetric('discord_send_attempt', trackingContext);
        try {
            sent = await sender(messageObject);
        } catch (err) {
            if (isUnknownMessageError(err)) {
                recordError(err, {
                    ...trackingContext,
                    errorType: 'discord_unknown_message',
                    severity: 'warn',
                    source: 'dispatcher.send',
                    details: { send_mode: sendMode, step_index: i, outcome: 'unknown_message' },
                });
                recordMetric('discord_send_error', trackingContext);
                recordAnalyticsEvent('discord_send', {
                    ...trackingContext,
                    source: 'dispatcher.send',
                    success: false,
                    durationMs: Date.now() - startedAt,
                    details: { send_mode: sendMode, step_index: i, outcome: 'unknown_message' },
                });
                continue;
            }

            if (isMissingPermissionsError(err)) {
                recordError(err, {
                    ...trackingContext,
                    errorType: 'discord_missing_permissions',
                    severity: 'warn',
                    source: 'dispatcher.send',
                    details: { send_mode: sendMode, step_index: i, outcome: 'missing_permissions' },
                });
                recordMetric('discord_send_permission_denied', trackingContext);
                recordAnalyticsEvent('discord_send', {
                    ...trackingContext,
                    source: 'dispatcher.send',
                    success: false,
                    durationMs: Date.now() - startedAt,
                    details: { send_mode: sendMode, step_index: i, outcome: 'missing_permissions' },
                });
                logSendFailure(message, err);
                continue;
            }

            if (messageObject.files !== undefined) {
                const fallbackText = messageObject.files.map(fileToFallbackText).filter(Boolean).join('\n');
                delete messageObject.files;
                appendContent(messageObject, fallbackText);

                if (!hasSendablePayload(messageObject)) {
                    recordError(err, {
                        ...trackingContext,
                        fallbackType: 'discord_send_failed',
                        source: 'dispatcher.retryWithoutFiles',
                        details: { send_mode: sendMode, step_index: i, outcome: 'no_fallback_payload' },
                    });
                    recordMetric('discord_send_error', trackingContext);
                    recordAnalyticsEvent('discord_send', {
                        ...trackingContext,
                        source: 'dispatcher.retryWithoutFiles',
                        success: false,
                        durationMs: Date.now() - startedAt,
                        details: { send_mode: sendMode, step_index: i, outcome: 'no_fallback_payload' },
                    });
                    logSendFailure(message, err, 'send response without files');
                    continue;
                }

                sent = await sender(messageObject).catch(e => {
                    if (!isUnknownMessageError(e)) {
                        recordError(e, {
                            ...trackingContext,
                            fallbackType: 'discord_send_failed',
                            source: 'dispatcher.retryWithoutFiles',
                            details: { send_mode: sendMode, step_index: i, outcome: 'retry_without_files_failed' },
                        });
                        logSendFailure(message, e, 'send response without files');
                    }
                    recordMetric('discord_send_error', trackingContext);
                    sendFailure = 'retry_without_files_failed';
                    return null;
                });
            } else {
                recordError(err, {
                    ...trackingContext,
                    fallbackType: 'discord_send_failed',
                    source: 'dispatcher.send',
                    details: { send_mode: sendMode, step_index: i, outcome: 'send_failed' },
                });
                recordMetric('discord_send_error', trackingContext);
                sendFailure = 'send_failed';
                console.log(err);
            }
        }
        previousSent = sent ?? previousSent;
        if (sent) {
            recordMetric('discord_send_success', trackingContext);
            recordAnalyticsEvent('discord_send', {
                ...trackingContext,
                source: 'dispatcher.send',
                success: true,
                durationMs: Date.now() - startedAt,
                details: { send_mode: sendMode, step_index: i },
            });
            incrementProcessedCounters();
        } else {
            recordAnalyticsEvent('discord_send', {
                ...trackingContext,
                source: 'dispatcher.send',
                success: false,
                durationMs: Date.now() - startedAt,
                details: { send_mode: sendMode, step_index: i, outcome: sendFailure || 'not_sent' },
            });
        }

        if (step.suppressSourceEmbeds) await suppressSourceEmbeds(message);
        if (step.deleteSource) {
            await deleteSourceMessage(message, providerId, trackingContext);
        }
    }
}

module.exports = { runSendSteps };
