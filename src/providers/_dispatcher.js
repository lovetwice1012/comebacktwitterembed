'use strict';

/**
 * Provider extractor が返す SendStep[] を実際に Discord へ送信する dispatcher。
 *
 * 各 SendStep は 1 回の Discord 送信単位 + 後処理指示を含む。
 * dispatcher は extractor が返した結果に従い、機械的に送信と後処理を実施する。
 * extractor 内部の挙動はこの dispatcher 自身は一切知らない。
 */

const telemetry = require('../adminSupport/telemetry');
const { MessageFlags } = require('discord.js');

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
    // Naked media URLs must not undo a spoiler attachment. Local paths are
    // useful only to the uploader and must never become public fallback text.
    if (file?.spoiler === true || file?.name?.startsWith('SPOILER_')) return '';
    const candidates = typeof file === 'string' ? [file] : [file?.fallbackUrl, file?.url, file?.attachment];
    for (const value of candidates) {
        if (typeof value !== 'string') continue;
        try {
            const url = new URL(value);
            if (url.pathname.split('/').at(-1)?.startsWith('SPOILER_')) continue;
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return value;
        } catch { /* Local paths and opaque file objects are not public URLs. */ }
    }
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

const FILE_FALLBACK_HTTP_STATUSES = new Set([400, 413, 415, 422]);
const FILE_RESOLUTION_ERROR_CODES = new Set(['ENOENT', 'FileNotFound', 'ReqResourceType']);

function shouldRetryWithoutFiles(err) {
    // A JSON parse failure can happen after Discord accepted the POST but returned
    // an empty/truncated response. Retrying that request could create a duplicate.
    if (err?.name === 'SyntaxError' || err instanceof SyntaxError) return false;

    const errorCode = String(err?.code ?? '');
    if (FILE_RESOLUTION_ERROR_CODES.has(errorCode)) return true;

    const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
    return Number.isInteger(status) && FILE_FALLBACK_HTTP_STATUSES.has(status);
}

async function suppressSourceEmbeds(message) {
    if (typeof message?.suppressEmbeds !== 'function') return;
    try { await message.suppressEmbeds(true); telemetry.event('postprocess', 'completed', { operation: 'suppress_embeds' }); return true; }
    catch (error) { telemetry.event('postprocess', 'failed', { operation: 'suppress_embeds', error: telemetry.errorData(error) }); return false; }
}

function deliveryFailureOutcome(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    if (error?.name === 'SyntaxError' || error instanceof SyntaxError) return 'delivery_unknown';
    if (Number.isInteger(status) && status >= 400 && status < 500) return 'failed';
    if (isMissingPermissionsError(error) || isUnknownMessageError(error)
        || FILE_RESOLUTION_ERROR_CODES.has(String(error?.code ?? ''))) return 'failed';
    // A transport error, including a nested cause or an unfamiliar timeout,
    // does not establish that Discord rejected the POST before accepting it.
    return 'delivery_unknown';
}

async function deleteSourceMessage(message, providerId = null, context = {}) {
    const trackingContext = /** @type {Record<string, any>} */ ({ ...context, providerId, message });
    if (typeof message?.delete !== 'function') return;
    try {
        await message.delete();
        recordMetric('discord_source_delete_success', trackingContext);
        telemetry.event('postprocess', 'completed', { operation: 'delete_source' });
        return true;
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
        telemetry.event('postprocess', 'failed', { operation: 'delete_source', error: telemetry.errorData(err) });
        return false;
    }
}

/**
 * @param {any} message - 元の Discord メッセージ
 * @param {import('./_types').SendStep[]} steps
 */
async function runSendSteps(message, steps, providerId = null, context = {}) {
    const trackingContext = /** @type {Record<string, any>} */ ({ ...context, providerId, message });
    if (trackingContext.url === undefined && trackingContext.rawUrl !== undefined) trackingContext.url = trackingContext.rawUrl;
    return runWithErrorContext(trackingContext, () => {
        if (!Array.isArray(steps) || steps.length === 0) return;
        return require('../sharedPostHistory').run(message, steps, trackingContext,
            prepared => runSendStepsNow(message, prepared, trackingContext));
    });
}

async function runSendStepsNow(message, steps, trackingContext) {
    const providerId = trackingContext.providerId;
    if (!Array.isArray(steps) || steps.length === 0) return;

    const result = { sent: [], attempts: [], postprocess: [], fallback: false, plannedSteps: steps.length };
    let previousSent = null;
    let sendable = 0;
    let completeFallback = true;
    const cleanup = new Map();
    for (let i = 0; i < steps.length; i++) {
        const gallery = await require('../mediaGallery').prepare(steps[i], message, trackingContext);
        const personal = i === 0 ? await require('../personalLinks/cards').prepare(gallery.step, message, trackingContext) : { step: gallery.step, cardId: null };
        const step = personal.step;
        const sendMode = step.send ?? (i === 0 ? 'channel' : 'reply-previous');
        if (step.suppressSourceEmbeds && !cleanup.has('suppress_embeds')) cleanup.set('suppress_embeds', i);
        if (step.deleteSource && !cleanup.has('delete_source')) cleanup.set('delete_source', i);

        const messageObject = {};
        if (trackingContext.presentationSettings?.silent_expansion === true) messageObject.flags = MessageFlags.SuppressNotifications;
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
            continue;
        }
        sendable++;

        let sender;
        if (sendMode === 'reply-source') {
            sender = (obj) => message.reply(obj);
        } else if (sendMode === 'reply-previous') {
            const target = previousSent ?? message;
            sender = (obj) => target.reply(obj);
        } else {
            sender = (obj) => message.channel.send(obj);
        }

        const originalSender = sender;
        sender = async payload => {
            const attempt = { stepIndex: i, payload: telemetry.serializable(payload), startedAt: new Date().toISOString() };
            telemetry.event('discord_send', 'started', attempt);
            try {
                const output = await originalSender(payload);
                if (typeof output?.id !== 'string' || !output.id) {
                    throw Object.assign(new Error('Discord did not return a message ID.'), { code: 'DISCORD_SEND_RESULT_UNKNOWN' });
                }
                Object.assign(attempt, { outcome: 'confirmed', messageId: output?.id, channelId: output?.channelId });
                result.sent.push({ stepIndex: i, messageId: output?.id, channelId: output?.channelId });
                telemetry.event('discord_send', 'completed', attempt);
                return output;
            } catch (error) {
                Object.assign(attempt, { outcome: deliveryFailureOutcome(error), error: telemetry.errorData(error) });
                telemetry.event('discord_send', 'failed', attempt);
                throw error;
            } finally { result.attempts.push(attempt); }
        };
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

            if (messageObject.files !== undefined && shouldRetryWithoutFiles(err)) {
                result.fallback = true;
                const fallbackUrls = messageObject.files.map(fileToFallbackText);
                if (fallbackUrls.some(url => !url)) completeFallback = false;
                const fallbackText = fallbackUrls.filter(Boolean).join('\n');
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
            if (personal.cardId) {
                try { await require('../personalLinks/store').getStore().bindCard(personal.cardId, sent.id); }
                catch (error) { require('../personalLinks/cards').report(error); }
            }
            if (gallery.galleryId) {
                try { await require('../mediaGallery').store().bind(gallery.galleryId, sent.id); }
                catch (error) { require('../mediaGallery').report(error); }
            }
            recordMetric('discord_send_success', trackingContext);
            recordAnalyticsEvent('discord_send', {
                ...trackingContext,
                source: 'dispatcher.send',
                success: true,
                durationMs: Date.now() - startedAt,
                details: { send_mode: sendMode, step_index: i, message_id: sent.id, fallback: result.fallback, attempts: result.attempts.filter(item => item.stepIndex === i) },
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

    }
    const deliveryUnknown = result.attempts.some(item => item.outcome === 'delivery_unknown');
    // Finish every reply before altering its source. Policy-only steps still
    // work, while partial or uncertain delivery leaves the original available.
    if (result.sent.length === sendable && !deliveryUnknown && completeFallback) {
        for (const operation of ['suppress_embeds', 'delete_source']) {
            if (!cleanup.has(operation)) continue;
            const success = operation === 'suppress_embeds' ? await suppressSourceEmbeds(message)
                : await deleteSourceMessage(message, providerId, trackingContext);
            result.postprocess.push({ stepIndex: cleanup.get(operation), operation, success });
        }
    } else if (cleanup.size) {
        telemetry.event('postprocess', 'skipped', { reason: 'incomplete_delivery', operations: [...cleanup.keys()] });
    }
    const failedPostprocess = result.postprocess.some(item => item.success === false);
    result.outcome = deliveryUnknown ? 'U'
        : result.sent.length === sendable && !failedPostprocess ? result.fallback ? 'D' : 'F'
            : result.sent.length ? 'P' : 'E';
    return result;
}

module.exports = { runSendSteps };
