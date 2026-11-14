'use strict';

const https = require('node:https');
const { createHash } = require('node:crypto');
const { lookup } = require('./providers/autoWatch/publicDns');
const cards = require('./twitterGridCards');
const { isExpected, isLocated } = require('./discordMessageIdentity');
const restore = require('./twitterGridRestore');
const { createRestoreJournal } = require('./twitterGridRestoreJournal');
const { logicalAttachments } = require('./discordAttachmentIdentity');

async function readBeforeDeadline(work, deadlineAtMs, now = Date.now) {
    const remaining = deadlineAtMs - now();
    if (remaining < 1) throw new Error('GRID_RESTORE_TIMEOUT');
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(work), new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('GRID_RESTORE_TIMEOUT')), remaining);
        })]);
    } finally { clearTimeout(timer); }
}

// Hash one confirmed Discord CDN attachment without retaining its bytes.
async function hashAttachment(file, options = {}) {
    const now = options.now || Date.now, remaining = Number.isSafeInteger(options.deadlineAtMs) ? options.deadlineAtMs - now() : 15000;
    if (remaining < 1) throw new Error('GRID_RESTORE_TIMEOUT');
    const url = new URL(file.url), controller = new AbortController(), timeout = setTimeout(() => controller.abort(), Math.min(15000, remaining));
    timeout.unref?.();
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.username || url.password || url.port || url.hash) {
        clearTimeout(timeout); throw new Error('GRID_RESTORE_UNAVAILABLE');
    }
    const fetch = options.fetch || require('node-fetch'), agent = new https.Agent({ keepAlive: false, lookup: options.lookup || lookup });
    let response;
    try {
        response = await fetch(url.href, { agent, redirect: 'manual', timeout: Math.min(15000, remaining), size: 25 * 1024 * 1024, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('GRID_RESTORE_UNAVAILABLE');
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk); bytes += buffer.length;
            if (bytes > 25 * 1024 * 1024) throw new Error('GRID_RESTORE_UNAVAILABLE');
            if (options.budget) {
                options.budget.bytes += buffer.length;
                if (options.budget.bytes > options.budget.maxBytes) throw new Error('GRID_RESTORE_UNAVAILABLE');
            }
            if (Number.isSafeInteger(options.deadlineAtMs) && now() >= options.deadlineAtMs) throw new Error('GRID_RESTORE_TIMEOUT');
            hash.update(buffer);
        }
        if (!bytes) throw new Error('GRID_RESTORE_UNAVAILABLE');
        return hash.digest('hex');
    } finally { response?.body?.destroy?.(); clearTimeout(timeout); controller.abort(); agent.destroy(); }
}

async function findUnknownSend(channel, recorded, step, interaction, options = {}) {
    if (!Number.isSafeInteger(recorded.startedAtMs) || recorded.startedAtMs <= 0 || !Array.isArray(step?.proofs) || !step.proofs.length) return null;
    const found = [], seen = new Set(); let before = null, complete = false;
    for (let page = 0; page < 5; page++) {
        if (Number.isSafeInteger(options.deadlineAtMs) && (options.now || Date.now)() >= options.deadlineAtMs) return null;
        let items;
        try {
            const read = () => channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
            items = Number.isSafeInteger(options.deadlineAtMs) ? await readBeforeDeadline(read, options.deadlineAtMs, options.now || Date.now) : await read();
        } catch { return null; }
        const messages = typeof items?.values === 'function' ? [...items.values()] : [];
        if (!messages.length) { complete = true; break; }
        let oldest = null, pastWindow = false;
        for (const message of messages) {
            const id = String(message?.id || '');
            if (!isLocated(message, interaction) || seen.has(id)) return null;
            seen.add(id);
            let created = Number(message.createdTimestamp);
            if (!Number.isSafeInteger(created) || created <= 0) {
                try { created = Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return null; }
            }
            if (created < recorded.startedAtMs - 30000) { pastWindow = true; continue; }
            if (!oldest || BigInt(id) < BigInt(oldest)) oldest = id;
            if (isExpected(message, interaction, null) && restore.verifyRestoredAttachments(message, { channelId: interaction.channelId, botId: interaction.client?.user?.id }, step.proofs)) found.push(message);
        }
        if (pastWindow || messages.length < 100) { complete = true; break; }
        if (!oldest || oldest === before) return null;
        before = oldest;
    }
    return complete && found.length === 1 ? found[0] : null;
}

// Called only under the shared gallery lock after fresh permissions. No new
// Discord edit or send is performed here. Unknown/unidentified messages stay
// blocked; we never infer that an ambiguous POST failed and resend it.
async function recoverConfirmed(lock, interaction, dependencies = {}) {
    const now = dependencies.now || Date.now, deadlineAtMs = dependencies.deadlineAtMs || now() + 90000;
    const budget = { bytes: 0, maxBytes: 20 * 25 * 1024 * 1024 };
    const originalRecord = lock?.journal?.payload, operationId = lock?.journal?.operationId, payload = lock?.payload;
    const marker = originalRecord?.rejected413 ? require('./twitterGridRestoreJournal').rejected413State(originalRecord) : null;
    if (originalRecord?.rejected413 && !marker) return null;
    const recorded = marker ? { ...originalRecord, state: 'in_progress',
        steps: marker.phase === 'rejected' ? originalRecord.steps.slice(0, -1) : originalRecord.steps } : originalRecord;
    if (!recorded || recorded.kind !== 'twitter-grid-restore' || recorded.version !== 1 || recorded.lockId !== lock.lockId
        || lock.journal.guildId !== String(interaction.guildId) || lock.journal.channelId !== String(interaction.channelId)
        || lock.journal.messageId !== String(lock.scope.messageId)
        || recorded.galleryId !== payload?.id || operationId !== recorded.operationId || !/^[a-f0-9]{32}$/.test(operationId || '')
        || !['in_progress', 'finished', 'unknown', 'partial_saved'].includes(recorded.state) || !['here', 'first', 'rest', 'new', 'resume'].includes(recorded.mode)
        || !/^\d{1,22}$/.test(recorded.sourceStatusId || '') || !Array.isArray(recorded.steps) || !Array.isArray(recorded.groupSizes)
        || !recorded.steps.length && !marker || recorded.steps.length > recorded.groupSizes.length || recorded.steps.length > 20
        || recorded.steps.some((step, index) => !(step.state === 'confirmed' || ['unknown', 'in_progress'].includes(recorded.state) && index === recorded.steps.length - 1
            && step.state === 'planned' && ['edit', 'send'].includes(step.type)) || step.index !== index
            || !(step.state === 'planned' && ['edit', 'send'].includes(step.type) || /^\d{1,25}$/.test(step.messageId || ''))
            || !Array.isArray(step.proofs) || step.proofs.length !== recorded.groupSizes[index])) return null;
    if (recorded.state === 'unknown' && recorded.steps.at(-1)?.state !== 'planned') return null;
    // A confirmed DB commit followed by a lost cleanup ACK may already have
    // replaced the visible list with the selected first ten. The archive is
    // the original verified list needed for idempotent recovery in that case.
    const originalUrls = payload.imageUrls?.length === recorded.imageCount ? payload.imageUrls : payload.restoreArchive?.imageUrls;
    if (!Array.isArray(originalUrls) || originalUrls.length !== recorded.imageCount || payload.sourceStatusId && payload.sourceStatusId !== recorded.sourceStatusId
        || !restore.validArchive(payload, recorded.sourceStatusId)) return null;
    const sourcePayload = { ...payload, imageUrls: originalUrls };
    const baseOffset = recorded.mode === 'resume' ? (recorded.baseOffset ?? 10) : 0;
    const targetCount = recorded.targetCount ?? (recorded.mode === 'first' ? Math.min(10, originalUrls.length) : originalUrls.length);
    if (!Number.isInteger(baseOffset) || !Number.isInteger(targetCount) || baseOffset < 0 || targetCount < 1 || targetCount > originalUrls.length
        || recorded.mode === 'resume' && (baseOffset < 1 || baseOffset >= targetCount)
        || recorded.mode !== 'resume' && (recorded.baseOffset ?? 0) !== 0
        || recorded.mode === 'first' && targetCount !== Math.min(10, originalUrls.length)
        || !['first', 'resume'].includes(recorded.mode) && targetCount !== originalUrls.length) return null;
    let plan;
    try { plan = restore.planFromSizes(originalUrls, recorded.mode, recorded.groupSizes, { nextIndex: baseOffset, targetCount }); } catch { return null; }
    const sizes = [plan.edit.length, ...plan.sends.map(group => group.length)].filter(Boolean);
    if (JSON.stringify(sizes) !== JSON.stringify(recorded.groupSizes)) return null;
    const partial = recorded.steps.length < sizes.length;
    let offset = baseOffset;
    for (let index = 0; index < recorded.steps.length; index++) {
        const step = recorded.steps[index], expectedType = !['new', 'resume'].includes(recorded.mode) && index === 0 ? 'edit' : 'send';
        if (step.type !== expectedType || step.start !== offset || step.count !== sizes[index]
            || step.proofs.some((proof, i) => !new RegExp(`^restore-${operationId}-${offset + i}\\.(jpg|png|webp|avif)$`).test(proof.name || ''))) return null;
        offset += sizes[index];
    }
    const source = { id: recorded.sourceStatusId, url: `https://x.com/i/web/status/${recorded.sourceStatusId}` };
    let verified;
    try { verified = await readBeforeDeadline(() => (dependencies.fetchVerifiedSource || restore.fetchVerifiedSource)(source, sourcePayload, { deadlineAtMs }), deadlineAtMs, now); }
    catch { return null; }
    if (!Array.isArray(verified) || verified.length !== originalUrls.length || verified.some((url, i) => url !== originalUrls[i])) return null;
    const channel = dependencies.channel || interaction.channel, messages = [];
    if (marker && !recorded.steps.length) {
        let original; try { original = await readBeforeDeadline(() => channel.messages.fetch({ message: lock.scope.messageId, force: true, cache: false }), deadlineAtMs, now); } catch { return null; }
        if (!isExpected(original, interaction, lock.scope.messageId)
            || !cards.matchesFingerprint(original, recorded.firstFingerprint) || !await dependencies.authorize?.()) return null;
        let newRow;
        if (recorded.mode === 'new') {
            if (!/^[a-f0-9]{32}$/.test(recorded.newGalleryId || '') || recorded.newGalleryId === lock.lockId) return null;
            const rows = await lock.db.queryDatabaseIndependent('SELECT message_id,payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND provider_id=?',
                [recorded.newGalleryId, interaction.guildId, interaction.channelId, 'twitter']);
            if (rows.length !== 1 || rows[0].message_id != null) return null;
            let created; try { created = JSON.parse(rows[0].payload_json); } catch { return null; }
            if (created.id !== recorded.newGalleryId || created.lockId !== recorded.newGalleryId || created.kind !== 'twitter-image-grid-v1'
                || created.partsState !== 'pending' || created.completedParts !== 0 || created.totalParts !== sizes.length
                || !Array.isArray(created.messageIds) || created.messageIds.length || !Array.isArray(created.imageUrls) || created.imageUrls.length
                || JSON.stringify(created.expectedImageUrls) !== JSON.stringify(originalUrls)) return null;
            newRow = rows[0];
        }
        if (typeof lock.db.withIndependentTransaction !== 'function' || now() >= deadlineAtMs || !await dependencies.authorize?.()) return null;
        await lock.db.withIndependentTransaction(async query => {
            if (newRow) {
                const deleted = await query('DELETE FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND provider_id=? AND message_id IS NULL AND BINARY payload_json=BINARY ?',
                    [recorded.newGalleryId, interaction.guildId, interaction.channelId, 'twitter', newRow.payload_json]);
                if (Number(deleted?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
            }
            const deleted = await query('DELETE FROM bot_twitter_grid_action_intents WHERE gallery_id=? AND operation_id=? AND BINARY payload_json=BINARY ?',
                [lock.lockId, operationId, JSON.stringify(originalRecord)]);
            if (Number(deleted?.affectedRows) !== 1) throw new Error('GRID_RESTORE_JOURNAL_CONFLICT');
        });
        return { journal: { clearAfterCommit: async () => {} }, operation: { id: operationId, record: originalRecord } };
    }
    let unknownSend = null;
    const pending = ['unknown', 'in_progress'].includes(recorded.state) ? recorded.steps.at(-1) : null;
    if (pending?.state === 'planned' && pending.type === 'send') {
        unknownSend = await (dependencies.findUnknownSend || findUnknownSend)(channel, recorded, pending, interaction, { deadlineAtMs, now });
        if (!unknownSend) return null;
    }
    const seen = new Set();
    for (const step of recorded.steps) {
        if (now() >= deadlineAtMs) return null;
        const messageId = step.state === 'planned' ? step.type === 'edit' ? String(lock.scope.messageId) : String(unknownSend?.id || '') : step.messageId;
        if (seen.has(messageId)) return null;
        seen.add(messageId);
        let message; try { message = await readBeforeDeadline(() => channel.messages.fetch({ message: messageId, force: true, cache: false }), deadlineAtMs, now); } catch { return null; }
        if (step.type === 'edit' && messageId !== String(lock.scope.messageId)) return null;
        if (!isExpected(message, interaction, messageId)) return null;
        if (payload.sharedInline && step.type === 'edit' && ['inline-reference', 'inline-upload'].includes(step.evidence?.kind)) {
            messages.push(message); continue;
        }
        if (step.type === 'send' && recorded.mode !== 'new' && (message.content || (message.embeds || []).length || (message.components || []).length)) return null;
        if (!restore.verifyRestoredAttachments(message, { channelId: interaction.channelId, botId: interaction.client?.user?.id }, step.proofs)) return null;
        for (const proof of step.proofs) {
            if (!/^restore-[a-f0-9]{32}-\d{1,2}\.(jpg|png|webp|avif)$/.test(proof.name || '')
                || !proof.name.startsWith(`restore-${operationId}-`) || !/^[a-f0-9]{64}$/.test(proof.sha256 || '')) return null;
            const file = logicalAttachments(message)?.find(item => item.name === proof.name);
            try { if (await readBeforeDeadline(() => (dependencies.hashAttachment || hashAttachment)(file, { deadlineAtMs, now, budget }), deadlineAtMs, now) !== proof.sha256) return null; } catch { return null; }
        }
        messages.push(message);
    }
    if (recorded.steps.some((step, index) => String(step.previousId || '') !== String(index ? messages[index - 1].id : lock.scope.messageId))) return null;
    if (marker && (now() >= deadlineAtMs || !await dependencies.authorize?.())) return null;
    if (payload.sharedInline && !['new', 'resume'].includes(recorded.mode)) {
        const inline = await require('./twitterGridRestoreInlineRecovery').recoverInline({ lock, interaction, recorded, messages,
            authorize: dependencies.authorize, verifySource: dependencies.fetchVerifiedSource || restore.fetchVerifiedSource,
            hashAttachment: dependencies.hashAttachment || hashAttachment,
            fetchCurrent: id => channel.messages.fetch({ message: id, force: true, cache: false }), deadlineAtMs, now });
        if (!!inline.partial !== partial) throw new Error('GRID_RESTORE_INLINE_RECOVERY');
    } else if (recorded.mode === 'new') {
        let original; try { original = await readBeforeDeadline(() => channel.messages.fetch({ message: lock.scope.messageId, force: true, cache: false }), deadlineAtMs, now); } catch { return null; }
        if (!isExpected(original, interaction, lock.scope.messageId) || !cards.matchesFingerprint(original, recorded.firstFingerprint)) return null;
        if (!/^[a-f0-9]{32}$/.test(recorded.newGalleryId || '')) return null;
        const rows = await lock.db.queryDatabaseIndependent('SELECT payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND provider_id=? AND expires_at_ms>?',
            [recorded.newGalleryId, interaction.guildId, interaction.channelId, 'twitter', Date.now()]);
        if (!rows[0]) return null;
        let created; try { created = JSON.parse(rows[0].payload_json); } catch { return null; }
        if (marker && created.partsState === 'pending' && created.totalParts !== sizes.length) return null;
        const expectedAll = JSON.stringify(created.expectedImageUrls) === JSON.stringify(originalUrls);
        const savedArchive = created.restoreArchive;
        const archiveMatches = savedArchive?.sourceStatusId === recorded.sourceStatusId && Array.isArray(savedArchive.imageUrls)
            && originalUrls.length <= savedArchive.imageUrls.length && originalUrls.every((url, i) => url === savedArchive.imageUrls[i]);
        if (created.kind !== 'twitter-image-grid-v1' || created.id !== recorded.newGalleryId || created.lockId !== recorded.newGalleryId
            || !expectedAll && !archiveMatches) return null;
        // Every recorded message was proven above. Attach missing receipts to
        // the existing new-gallery row using its exact-payload CAS; never POST.
        const independent = /** @type {any} */ ({ queryDatabase: lock.db.queryDatabaseIndependent });
        const storage = { bind: async (id, messageId, retainForPost) => {
            const bound = retainForPost
                ? await independent.queryDatabase('UPDATE bot_media_galleries SET message_id=?,expires_at_ms=? WHERE gallery_id=? AND (message_id IS NULL OR message_id=?)', [messageId, Number.MAX_SAFE_INTEGER, id, messageId])
                : await independent.queryDatabase('UPDATE bot_media_galleries SET message_id=? WHERE gallery_id=? AND (message_id IS NULL OR message_id=?)', [messageId, id, messageId]);
            if (Number(bound?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
        } };
        if (!Number.isInteger(created.completedParts) || created.completedParts < 0 || created.completedParts > messages.length
            || !Array.isArray(created.messageIds) || !Array.isArray(created.partSignatures)
            || created.messageIds.length !== created.completedParts || created.partSignatures.length !== created.completedParts
            || created.messageIds.some((id, i) => String(id) !== String(messages[i].id) || !cards.matchesFingerprint(messages[i], created.partSignatures[i]))) return null;
        if (created.partsState === 'pending') {
            for (let index = created.completedParts; index < messages.length; index++) {
                const start = sizes.slice(0, index).reduce((sum, value) => sum + value, 0);
                const part = { imageUrls: originalUrls.slice(start, start + sizes[index]), sequence: index, totalParts: sizes.length };
                if (index === 0) {
                    if (cards.gridIdFromMessage(messages[0]) !== created.id || !await cards.bind(created, messages[0], storage, independent, part)) return null;
                } else if (!await cards.append(created, part, messages[index], independent)) return null;
            }
            if (!partial) await cards.finish(created, independent);
            else {
                const before = JSON.stringify(created), visibleCount = sizes.slice(0, messages.length).reduce((sum, value) => sum + value, 0);
                const visible = originalUrls.slice(0, visibleCount), retainedArchive = payload.restoreArchive?.imageUrls || originalUrls;
                created = { ...created, imageUrls: visible, expectedImageUrls: visible, expectedRefs: (created.expectedRefs || []).slice(0, visibleCount),
                    totalParts: messages.length, completedParts: messages.length, partsState: 'complete', sourceStatusId: recorded.sourceStatusId,
                    restoreArchive: { sourceStatusId: recorded.sourceStatusId, imageUrls: retainedArchive },
                    restoreContinuation: { sourceStatusId: recorded.sourceStatusId, nextIndex: visibleCount, targetCount } };
                const updated = await lock.db.queryDatabaseIndependent('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
                    [JSON.stringify(created), created.id, String(messages[0].id), before]);
                if (Number(updated?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
            }
        }
        const visibleCount = sizes.slice(0, messages.length).reduce((sum, value) => sum + value, 0);
        if (created.partsState !== 'complete' || created.id !== recorded.newGalleryId || !Array.isArray(created.messageIds)
            || JSON.stringify(created.messageIds) !== JSON.stringify(messages.map(item => String(item.id)))
            || JSON.stringify(created.imageUrls) !== JSON.stringify(originalUrls.slice(0, visibleCount))
            || !Array.isArray(created.partSignatures) || created.partSignatures.length !== messages.length
            || created.partSignatures.some((value, i) => !cards.matchesFingerprint(messages[i], value))) return null;
        if (partial && (created.restoreContinuation?.nextIndex !== visibleCount || (created.restoreContinuation.targetCount ?? originalUrls.length) !== targetCount)) return null;
    } else if (recorded.mode === 'resume') {
        if (!Array.isArray(payload.messageIds) || !Array.isArray(payload.partSignatures)
            || payload.messageIds.length !== payload.partSignatures.length || !payload.messageIds.length
            || new Set(payload.messageIds).size !== payload.messageIds.length) return null;
        const existing = [];
        for (let index = 0; index < payload.messageIds.length; index++) {
            let saved;
            try { saved = await readBeforeDeadline(() => channel.messages.fetch({ message: payload.messageIds[index], force: true, cache: false }), deadlineAtMs, now); }
            catch { return null; }
            if (!isExpected(saved, interaction, payload.messageIds[index])
                || !cards.matchesFingerprint(saved, payload.partSignatures[index])) return null;
            existing.push(saved);
        }
        const appliedCount = baseOffset + sizes.slice(0, messages.length).reduce((sum, value) => sum + value, 0);
        const remainingTarget = partial ? targetCount : targetCount < originalUrls.length ? originalUrls.length : null;
        const continuationMatches = value => remainingTarget === null ? !value
            : value?.sourceStatusId === recorded.sourceStatusId && value.nextIndex === appliedCount && value.targetCount === remainingTarget;
        if (payload.restoreContinuation?.nextIndex === baseOffset) {
            if ((payload.restoreContinuation.targetCount ?? originalUrls.length) !== targetCount
                || messages.some(item => payload.messageIds.includes(String(item.id)))) return null;
            let next; try { next = restore.resumedManifest(payload, operationId, existing, messages, true); } catch { return null; }
            if (next.imageUrls.length !== appliedCount || !continuationMatches(next.restoreContinuation)) return null;
            const result = await lock.query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
                [JSON.stringify(next), payload.id, lock.scope.messageId, lock.row.payload_json]);
            if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
        } else if (!Array.isArray(payload.imageUrls) || payload.imageUrls.length !== appliedCount
            || payload.imageUrls.some((url, i) => url !== originalUrls[i]) || payload.messageIds.length <= messages.length
            || JSON.stringify(payload.messageIds.slice(-messages.length)) !== JSON.stringify(messages.map(message => String(message.id)))
            || !continuationMatches(payload.restoreContinuation)) return null;
    } else {
        if (!cards.matchesFingerprint(messages[0], payload.firstStaticSignature, true) || payload.sharedInline) return null;
        let next; try { next = restore.restoredManifest(payload, operationId, recorded.mode, messages, originalUrls, recorded.sourceStatusId, sizes, true); } catch { return null; }
        const result = await lock.query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
            [JSON.stringify(next), payload.id, lock.scope.messageId, lock.row.payload_json]);
        if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    }
    const journal = createRestoreJournal(lock.db, { ...lock.scope, lockId: lock.lockId }), operation = { id: operationId, record: originalRecord };
    if (now() >= deadlineAtMs) throw new Error('GRID_RESTORE_TIMEOUT');
    if (marker) await journal.resolveRejected413(operation);
    if (recorded.state === 'unknown') {
        const step = recorded.steps.at(-1);
        if (step.type === 'edit') await journal.confirmUnknownEdit(operation, { index: step.index, messageId: lock.scope.messageId });
        else await journal.confirmUnknownSend(operation, { index: step.index, messageId: unknownSend.id });
    } else if (recorded.state === 'in_progress' && pending?.state === 'planned') {
        const messageId = pending.type === 'edit' ? lock.scope.messageId : unknownSend?.id;
        await journal.confirm(operation, { index: pending.index, type: pending.type, messageId });
    }
    if (operation.record.state === 'in_progress') {
        if (partial) await journal.markPartial(operation); else await journal.markFinished(operation);
    }
    return { journal, operation };
}

module.exports = { hashAttachment, findUnknownSend, recoverConfirmed, readBeforeDeadline };
