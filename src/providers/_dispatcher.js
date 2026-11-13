'use strict';

/**
 * Provider extractor が返す SendStep[] を実際に Discord へ送信する dispatcher。
 *
 * 各 SendStep は 1 回の Discord 送信単位 + 後処理指示を含む。
 * dispatcher は extractor が返した結果に従い、機械的に送信と後処理を実施する。
 * extractor 内部の挙動はこの dispatcher 自身は一切知らない。
 */

const telemetry = require('../adminSupport/telemetry');
const { binaryMetadata } = require('../adminSupport/telemetryPayload');
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

function instagramTelemetryPayload(payload) {
    const ancestors = new Set();
    const safe = value => {
        // Redact signed Instagram CDN URLs before serializing telemetry, and
        // replace binary data before Buffer.toJSON can expand it into arrays.
        if (Buffer.isBuffer(value)) return binaryMetadata(value);
        if (typeof value === 'string') return value.replace(/https:\/\/[^\s<>"'()]+/gi, url => {
            try {
                const host = new URL(url).hostname.toLowerCase();
                return host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') || host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ? '[Instagram media]' : url;
            } catch { return url; }
        });
        if (!value || typeof value !== 'object') return value;
        if (ancestors.has(value)) return '[circular]';
        ancestors.add(value);
        try {
            const normalized = typeof value.toJSON === 'function' ? value.toJSON() : value;
            if (normalized !== value) return safe(normalized);
            if (Array.isArray(value)) return value.map(safe);
            return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fallbackUrl').map(([key, item]) => [key, safe(item)]));
        } finally { ancestors.delete(value); }
    };
    return safe(payload);
}

function telemetryPayload(payload, verifiedFiles, providerId) {
    if (providerId === 'instagram') return telemetry.serializable(instagramTelemetryPayload(payload));
    if (!Array.isArray(payload?.files)) return telemetry.serializable(payload);
    const files = payload.files.map(file => {
        // These plain wrappers are created internally by prepareTwitterFiles;
        // never clone arbitrary Vx/other-provider objects or their toJSONs.
        if (!file || typeof file !== 'object' || !verifiedFiles.has(file)) return file;
        const attachment = binaryMetadata(file.attachment);
        return attachment ? { ...file, attachment } : file;
    });
    // Buffer.toJSON creates a large numeric array before a JSON replacer can
    // inspect it. Replace binary values before serialization, preserving the
    // same length/hash metadata and never copying the bytes into telemetry.
    return telemetry.serializable({ ...payload, files });
}

function twitterFileUrl(file) {
    return typeof file === 'string' ? file : typeof file?.fallbackUrl === 'string' ? file.fallbackUrl
        : typeof file?.attachment === 'string' ? file.attachment : '';
}
function splitRejectedTwitterStep(step, files) {
    if (!Array.isArray(files) || files.length < 2) return null;
    const cut = Math.ceil(files.length / 2), leftFiles = files.slice(0, cut), rightFiles = files.slice(cut);
    const first = { ...step, files: leftFiles };
    /** @type {import('./_types').SendStep} */
    const second = { files: rightFiles, send: 'channel', allowedMentions: { parse: [], repliedUser: false },
        requiresPreviousSuccess: true, ...(step.safeTwitterMedia === true ? { safeTwitterMedia: true } : {}) };
    const meta = step.twitterGrid;
    if (meta && Array.isArray(meta.imageUrls)) {
        const allFiles = new Set(files.map(twitterFileUrl).filter(Boolean));
        const leftCounts = new Map();
        for (const file of leftFiles) { const url = twitterFileUrl(file); if (url) leftCounts.set(url, (leftCounts.get(url) || 0) + 1); }
        const leftImages = [], rightImages = [];
        for (const url of meta.imageUrls) {
            if (!allFiles.has(url)) { leftImages.push(url); continue; } // embed-only image stays on the first message
            const left = leftCounts.get(url) || 0;
            if (left) { leftImages.push(url); leftCounts.set(url, left - 1); } else rightImages.push(url);
        }
        first.twitterGrid = { ...meta, imageUrls: leftImages };
        second.twitterGrid = { imageUrls: rightImages, sequence: Math.max(1, meta.sequence), totalParts: meta.totalParts };
    }
    return [first, second];
}
function renumberTwitterGrid(steps, index) {
    if (!steps[index]?.twitterGrid) return;
    let start = index;
    while (start > 0 && steps[start]?.twitterGrid?.sequence > 0 && steps[start - 1]?.twitterGrid) start--;
    if (steps[start]?.twitterGrid?.sequence !== 0) return;
    let end = index;
    while (end + 1 < steps.length && steps[end + 1]?.twitterGrid?.sequence > 0) end++;
    const totalParts = end - start + 1;
    for (let i = start; i <= end; i++) steps[i] = { ...steps[i], twitterGrid: { ...steps[i].twitterGrid, sequence: i - start, totalParts } };
}
function actualTwitterGridPart(step) {
    const part = step.twitterGrid;
    if (!part) return null;
    const photos = new Set(part.imageUrls || []);
    return { ...part, containsNonImage: (step.files || []).some(file => !photos.has(twitterFileUrl(file))) };
}

const FILE_FALLBACK_HTTP_STATUSES = new Set([400, 413, 415, 422]);
const FILE_RESOLUTION_ERROR_CODES = new Set(['ENOENT', 'FileNotFound', 'ReqResourceType']);
const TWITTER_MEDIA_TOTAL_LIMIT = 80 * 1024 * 1024;
const TWITTER_MEDIA_ACTIVE_LIMIT = 2;
const TWITTER_MEDIA_QUEUE_LIMIT = 16;
const TWITTER_MEDIA_QUEUE_WAIT_MS = 30000;
let activeTwitterMediaBatches = 0;
const waitingTwitterMediaBatches = [];

function releaseTwitterMediaBatch() {
    const next = waitingTwitterMediaBatches.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else activeTwitterMediaBatches--;
}
async function acquireTwitterMediaBatch() {
    if (activeTwitterMediaBatches < TWITTER_MEDIA_ACTIVE_LIMIT) { activeTwitterMediaBatches++; return; }
    if (waitingTwitterMediaBatches.length >= TWITTER_MEDIA_QUEUE_LIMIT) throw Object.assign(new Error('Twitter media preparation is busy'), { code: 'TWITTER_MEDIA_PREPARE' });
    await new Promise((resolve, reject) => {
        const item = { resolve, timer: null };
        item.timer = setTimeout(() => {
            const index = waitingTwitterMediaBatches.indexOf(item);
            if (index >= 0) waitingTwitterMediaBatches.splice(index, 1);
            reject(Object.assign(new Error('Twitter media preparation is busy'), { code: 'TWITTER_MEDIA_PREPARE' }));
        }, TWITTER_MEDIA_QUEUE_WAIT_MS);
        item.timer.unref?.(); waitingTwitterMediaBatches.push(item);
    });
}

function safeTwitterFallback(file) {
    if (file?.spoiler === true || file?.name?.startsWith('SPOILER_')) return '';
    const candidates = typeof file === 'string' ? [file] : [file?.fallbackUrl, file?.url, file?.attachment];
    for (const value of candidates) {
        if (typeof value !== 'string') continue;
        try {
            if (new URL(value).pathname.split('/').at(-1)?.startsWith('SPOILER_')) continue;
            require('./twitter/safeMedia').validateTwitterMediaUrl(value); return value;
        } catch { /* Try another validated URL, never emit an arbitrary host. */ }
    }
    return '';
}

async function prepareTwitterFiles(files) {
    const { fetchTwitterMedia, validateTwitterMediaUrl, MAX_MEDIA_BYTES } = require('./twitter/safeMedia');
    // Validate the whole input before starting any download. A rejected URL
    // must never be submitted to Discord's automatic URL resolver.
    const entries = files.map(file => {
        const url = typeof file === 'string' ? file : file?.attachment;
        if (typeof url !== 'string') throw Object.assign(new Error('Twitter media is not a URL'), { code: 'TWITTER_MEDIA_PREPARE' });
        try { return { file, url, info: validateTwitterMediaUrl(url) }; }
        catch { throw Object.assign(new Error('Twitter media URL is unavailable'), { code: 'TWITTER_MEDIA_PREPARE' }); }
    });
    const result = new Array(entries.length); let next = 0, total = 0, failed = null;
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, async () => {
        while (!failed) {
            const index = next++; if (index >= entries.length) return;
            const { file, url, info } = entries[index];
            const remaining = TWITTER_MEDIA_TOTAL_LIMIT - total;
            try {
                if (remaining <= 0) throw Object.assign(new Error('attachment budget exceeded'), { code: 'TWITTER_MEDIA_BATCH_TOO_LARGE' });
                const fetched = await fetchTwitterMedia(url, { kind: info.kind, maxBytes: Math.min(MAX_MEDIA_BYTES, remaining) });
                const format = fetched.format;
                if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'mp4'].includes(format)
                    || info.kind === 'video' && format !== 'mp4' || info.kind === 'photo' && format === 'mp4') throw new Error('media format mismatch');
                total += fetched.data.length;
                if (total > TWITTER_MEDIA_TOTAL_LIMIT) throw Object.assign(new Error('attachment budget exceeded'), { code: 'TWITTER_MEDIA_BATCH_TOO_LARGE' });
                const ext = format === 'jpeg' ? 'jpg' : format;
                const supplied = typeof file === 'object' && typeof file.name === 'string' ? file.name.replace(/[\\/\r\n]/g, '_').slice(0, 120) : '';
                const base = supplied.replace(/\.[^.]*$/, '').replace(/[. ]+$/, '') || `twitter-media-${index + 1}`;
                let name = `${base}.${ext}`;
                if (file?.spoiler === true && !name.startsWith('SPOILER_')) name = `SPOILER_${name}`;
                result[index] = { ...(typeof file === 'object' ? file : {}), attachment: fetched.data, name, fallbackUrl: url };
            } catch (cause) {
                // A per-file limit lower than MAX_MEDIA_BYTES is imposed only
                // by the remaining batch budget; it proves the current batch
                // cannot fit, while a full-limit failure may be one large file.
                const overBatch = cause?.code === 'TWITTER_MEDIA_BATCH_TOO_LARGE'
                    || cause?.code === 'TWITTER_MEDIA_TOO_LARGE' && remaining > 0 && remaining < MAX_MEDIA_BYTES;
                if (!failed || !overBatch) failed = Object.assign(new Error('Twitter media could not be safely prepared'),
                    { code: overBatch ? 'TWITTER_MEDIA_BATCH_TOO_LARGE' : 'TWITTER_MEDIA_PREPARE' });
            }
        }
    }));
    if (failed) throw failed;
    return result;
}

function shouldRetryWithoutFiles(err) {
    // A JSON parse failure can happen after Discord accepted the POST but returned
    // an empty/truncated response. Retrying that request could create a duplicate.
    if (err?.name === 'SyntaxError' || err instanceof SyntaxError) return false;

    const errorCode = String(err?.code ?? '');
    if (FILE_RESOLUTION_ERROR_CODES.has(errorCode) || ['TWITTER_MEDIA_PREPARE', 'TWITTER_MEDIA_BATCH_TOO_LARGE'].includes(errorCode)) return true;

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
        || FILE_RESOLUTION_ERROR_CODES.has(String(error?.code ?? '')) || error?.code === 'TWITTER_MEDIA_PREPARE'
        || error?.code === 'TWITTER_SINGLE_SEND_UNAVAILABLE') return 'failed';
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
    // Later 413 handling inserts smaller physical parts without mutating the
    // provider's original step objects.
    steps = steps.slice();
    const verifiedTwitterFiles = new WeakSet();
    function releaseVerifiedFiles(index) {
        const item = steps[index];
        if (item?.files?.some(file => file && typeof file === 'object' && verifiedTwitterFiles.has(file)))
            steps[index] = { ...item, files: undefined };
    }
    let previousSent = null;
    let lastStepSent = null;
    let pendingTwitterGrid = null;
    let sendable = 0;
    let completeFallback = true;
    let twitterMediaLease = false;
    const cleanup = new Map();
    async function finishPendingGrid(state) {
        const current = pendingTwitterGrid;
        pendingTwitterGrid = null;
        if (!current) return;
        try { await require('../twitterGridCards').markIncomplete(current, state); }
        catch (error) { require('../mediaGallery').report(error); }
    }
    async function discardUnpublishedGrid(grids) {
        if (!grids?.length) return;
        try { await require('../twitterGridCards').discardUnbound(grids); }
        catch (error) { require('../mediaGallery').report(error); }
    }
    async function gridCompletion(item) {
        const cards = require('../twitterGridCards');
        if (typeof cards.finish !== 'function') return item.totalParts > 1 ? 'pending' : 'complete';
        return (await cards.finish(item)).state;
    }
    try {
    for (let i = 0; i < steps.length; i++) {
        const previousForDependency = lastStepSent;
        if (steps[i]?.requiresPreviousSuccess && !lastStepSent) {
            // Treat an unsent dependent part as incomplete, so source cleanup
            // cannot remove the only copy of a partially delivered post.
            sendable++;
            await finishPendingGrid('failed');
            releaseVerifiedFiles(i);
            continue;
        }
        if (pendingTwitterGrid && (!steps[i]?.twitterGrid || steps[i].twitterGrid.sequence === 0)) await finishPendingGrid('failed');
        lastStepSent = null;
        const gallery = await require('../mediaGallery').prepare(steps[i], message, trackingContext);
        const grid = await require('../twitterGridCards').prepare(gallery.step, message, trackingContext, undefined, steps.slice(i + 1));
        const personal = i === 0 ? await require('../personalLinks/cards').prepare(grid.step, message, trackingContext) : { step: grid.step, cardId: null };
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
            if (pendingTwitterGrid && step.twitterGrid?.sequence > 0) await finishPendingGrid('failed');
            await discardUnpublishedGrid(grid.grids);
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

        const needsSingleAttempt = providerId === 'twitter'
            && (grid.grids?.length || pendingTwitterGrid || messageObject.files?.length);
        let singleAttemptSender = null;
        if (needsSingleAttempt) {
            try {
                const candidate = require('./twitter/singleAttemptSender').forMessage(message, sendMode, previousSent);
                if (typeof candidate?.send === 'function') singleAttemptSender = candidate;
            }
            catch { /* Fail closed before Discord when a one-shot sender is unavailable. */ }
        }
        const originalSender = singleAttemptSender?.send || sender;
        let preparedTwitterFiles = null;
        let attemptedDiscordSubmission = false;
        sender = async payload => {
            attemptedDiscordSubmission = false;
            const attempt = { stepIndex: i, payload: telemetryPayload(payload, verifiedTwitterFiles, providerId), startedAt: new Date().toISOString() };
            telemetry.event('discord_send', 'started', attempt);
            try {
                let outputPayload = payload;
                if (providerId === 'twitter' && step.safeTwitterMedia === true && payload.files?.length) {
                    if (!twitterMediaLease) { await acquireTwitterMediaBatch(); twitterMediaLease = true; }
                    const alreadyVerified = payload.files.every(file => file && typeof file === 'object' && verifiedTwitterFiles.has(file));
                    preparedTwitterFiles = alreadyVerified ? payload.files : await prepareTwitterFiles(payload.files);
                    for (const file of preparedTwitterFiles) verifiedTwitterFiles.add(file);
                    outputPayload = { ...payload, files: preparedTwitterFiles };
                }
                if (needsSingleAttempt && !singleAttemptSender)
                    throw Object.assign(new Error('A single-attempt sender is unavailable.'), { code: 'TWITTER_SINGLE_SEND_UNAVAILABLE' });
                attemptedDiscordSubmission = true;
                const output = await originalSender(outputPayload);
                if (typeof output?.id !== 'string' || !output.id) {
                    throw Object.assign(new Error('Discord did not return a message ID.'), { code: 'DISCORD_SEND_RESULT_UNKNOWN' });
                }
                Object.assign(attempt, { outcome: 'confirmed', messageId: output?.id, channelId: output?.channelId });
                result.sent.push({ stepIndex: i, messageId: output?.id, channelId: output?.channelId });
                telemetry.event('discord_send', 'completed', attempt);
                return output;
            } catch (error) {
                const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
                const unproven413 = attemptedDiscordSubmission && needsSingleAttempt && !singleAttemptSender && status === 413;
                const outcome = unproven413 ? 'delivery_unknown'
                    : !attemptedDiscordSubmission && error?.code === 'TWITTER_MEDIA_BATCH_TOO_LARGE' ? 'failed' : deliveryFailureOutcome(error);
                Object.assign(attempt, { outcome, error: telemetry.errorData(error) });
                telemetry.event('discord_send', 'failed', attempt);
                throw error;
            } finally { result.attempts.push(attempt); }
        };
        let sent = null;
        let sendFailure = null;
        let deliveryErrorState = null;
        let withoutFiles = false;
        let releasePreparedImages = () => {};
        let originalImageFiles = null;
        const startedAt = Date.now();
        recordMetric('discord_send_attempt', trackingContext);
        try {
            if (providerId === 'instagram' && messageObject.files?.length) {
                // Acquire supported image attachments before entering Discord's
                // send path, so retrying an acquisition cannot repeat a POST.
                const prepare = require('./instagram/attachment-preflight').prepare;
                const prepared = await prepare(messageObject.files);
                if (prepared) { originalImageFiles = messageObject.files; messageObject.files = prepared.files; releasePreparedImages = prepared.release; }
            }
            sent = await sender(messageObject);
        } catch (err) {
            // HTTP 413 is an explicit rejection before a message was created.
            // A local batch-size rejection is also definitive, but only while
            // the Discord submission has not yet started. Ambiguous outcomes
            // and other fetch/validation failures never split.
            const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
            const unproven413 = attemptedDiscordSubmission && needsSingleAttempt && !singleAttemptSender && status === 413;
            const definiteRejection = status === 413 && !!singleAttemptSender && deliveryFailureOutcome(err) === 'failed'
                || !attemptedDiscordSubmission && err?.code === 'TWITTER_MEDIA_BATCH_TOO_LARGE';
            const split = providerId === 'twitter' && definiteRejection
                ? splitRejectedTwitterStep(steps[i], preparedTwitterFiles || messageObject.files) : null;
            if (split) {
                await discardUnpublishedGrid(grid.grids);
                steps.splice(i, 1, ...split);
                renumberTwitterGrid(steps, i);
                sendable--; result.plannedSteps++;
                lastStepSent = previousForDependency;
                i--;
                continue;
            }
            if (isUnknownMessageError(err)) {
                if (pendingTwitterGrid && step.twitterGrid?.sequence > 0) await finishPendingGrid('failed');
                await discardUnpublishedGrid(grid.grids);
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
                releaseVerifiedFiles(i);
                continue;
            }

            if (isMissingPermissionsError(err)) {
                if (pendingTwitterGrid && step.twitterGrid?.sequence > 0) await finishPendingGrid('failed');
                await discardUnpublishedGrid(grid.grids);
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
                releaseVerifiedFiles(i);
                continue;
            }

            if (messageObject.files !== undefined && shouldRetryWithoutFiles(err)
                && !unproven413 && !(attemptedDiscordSubmission && err?.code === 'TWITTER_MEDIA_BATCH_TOO_LARGE')) {
                result.fallback = true;
                withoutFiles = true;
                const fallbackUrls = messageObject.files.map(providerId === 'twitter' && step.safeTwitterMedia === true ? safeTwitterFallback : fileToFallbackText);
                if (fallbackUrls.some(url => !url)) completeFallback = false;
                const fallbackText = fallbackUrls.filter(Boolean).join('\n');
                delete messageObject.files;
                // A grid must never expose images whose upload failed.
                if (grid.grids?.length && messageObject.components) {
                    messageObject.components = messageObject.components.map(row => ({ ...row,
                        components: row.components.filter(component => !String(component.custom_id || component.data?.custom_id || component.customId || '').startsWith('tg:')),
                    })).filter(row => row.components.length);
                }
                await discardUnpublishedGrid(grid.grids);
                appendContent(messageObject, fallbackText);

                if (!hasSendablePayload(messageObject)) {
                    if (pendingTwitterGrid && step.twitterGrid?.sequence > 0) await finishPendingGrid('failed');
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
                    releaseVerifiedFiles(i);
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
                deliveryErrorState = unproven413 || deliveryFailureOutcome(err) === 'delivery_unknown' ? 'delivery_unknown' : 'failed';
                if (deliveryErrorState === 'failed') await discardUnpublishedGrid(grid.grids);
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
        } finally { if (originalImageFiles) messageObject.files = originalImageFiles; releasePreparedImages(); }
        previousSent = sent ?? previousSent;
        lastStepSent = sent;
        if (sent) {
            if (grid.grids?.length && !withoutFiles) {
                for (const item of grid.grids) {
                    let bound = false;
                    try {
                        const cards = require('../twitterGridCards');
                        const firstPart = item.isPrimary === false ? undefined : actualTwitterGridPart(step);
                        bound = await cards.bind(item, sent, undefined, undefined, firstPart);
                        if (!bound) continue;
                        if (await gridCompletion(item) === 'pending') pendingTwitterGrid = item;
                    } catch (error) {
                        require('../mediaGallery').report(error);
                        // Discord acknowledged the message; a failed DB finish
                        // is uncertain and must not trigger another send.
                        if (bound) {
                            try { await require('../twitterGridCards').markIncomplete(item, 'record_unknown'); }
                            catch (markError) { require('../mediaGallery').report(markError); }
                            if (pendingTwitterGrid === item) pendingTwitterGrid = null;
                        }
                    }
                }
            } else if (pendingTwitterGrid && step.twitterGrid?.sequence > 0) {
                if (!withoutFiles) {
                    // A video-only physical part is intentionally not added to
                    // the photo group and must never be deleted by replacement.
                    if (step.twitterGrid.imageUrls?.length) {
                        let recorded = false;
                        try { recorded = await require('../twitterGridCards').append(pendingTwitterGrid, actualTwitterGridPart(step), sent); }
                        catch (error) { require('../mediaGallery').report(error); }
                        if (!recorded) await finishPendingGrid('record_unknown');
                        else {
                            try { if (await gridCompletion(pendingTwitterGrid) === 'complete') pendingTwitterGrid = null; }
                            catch (error) { require('../mediaGallery').report(error); await finishPendingGrid('record_unknown'); }
                        }
                    }
                } else await finishPendingGrid('failed');
            }
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
            if (pendingTwitterGrid && step.twitterGrid?.sequence > 0) await finishPendingGrid(withoutFiles ? 'failed' : deliveryErrorState || 'delivery_unknown');
            recordAnalyticsEvent('discord_send', {
                ...trackingContext,
                source: 'dispatcher.send',
                success: false,
                durationMs: Date.now() - startedAt,
                details: { send_mode: sendMode, step_index: i, outcome: sendFailure || 'not_sent' },
            });
        }
        releaseVerifiedFiles(i);

    }
    if (pendingTwitterGrid) await finishPendingGrid('failed');
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
    } finally {
        // Prepared buffers remain reachable through subsequent split steps
        // until the send completes or aborts. The global admission must span
        // that full lifetime, not just the initial download.
        if (twitterMediaLease) releaseTwitterMediaBatch();
    }
}

module.exports = { runSendSteps };
