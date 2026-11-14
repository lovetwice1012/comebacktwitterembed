'use strict';

// Recover a committed Discord edit after its SQL acknowledgement was lost.
// The caller must hold the shared gallery lock and must not submit a new
// Discord operation while evaluating this proof.
const cards = require('./twitterGridCards');
const { isExpected } = require('./discordMessageIdentity');
const grid = require('./components/twitterGrid')._internal;
const restore = require('./twitterGridRestore');
const { matchesUniqueReference, logicalAttachments } = require('./discordAttachmentIdentity');
const { statusIdentity } = require('./providers/twitter/twitterSourceParser/fxTwitter')._internal;

function invalid() { return new Error('GRID_RESTORE_INLINE_RECOVERY'); }
function plain(value) { return value?.toJSON ? value.toJSON() : JSON.parse(JSON.stringify(value || {})); }
function isMarker(id, file) {
    return /^[a-f0-9]{32}$/.test(id || '') && new RegExp(`^tg-${id}\\.(?:jpg|png|webp)$`).test(file?.name || '')
        && /^\d{1,25}$/.test(String(file.id || '')) && /^image\/(?:jpeg|png|webp)$/i.test(file.contentType || '');
}
function refersTo(url, file, channelId, attachments) { return matchesUniqueReference(url, file, attachments, channelId); }
function markerPosition(message, file, channelId = message.channelId || message.channel?.id) {
    const attachments = logicalAttachments(message);
    if (!attachments) return null;
    const indexes = (message.embeds || []).flatMap((embed, index) => refersTo(cards.cleanEmbed(embed).image?.url, file, channelId, attachments) ? [index] : []);
    return indexes.length === 1 ? indexes[0] : null;
}
function normalizedFingerprint(message, uploaded, retained, channelId, legacy = false) {
    const embeds = (message.embeds || []).map(embed => {
        const value = cards.cleanEmbed(embed), url = value.image?.url;
        if (url) {
            const matches = uploaded.filter(file => refersTo(url, file, channelId, logicalAttachments(message)));
            if (matches.length > 1) throw invalid();
            if (matches.length === 1) value.image.url = `attachment://${matches[0].name}`;
        }
        return value;
    });
    // Retained uploads referenced by embeds are hidden from Discord's GET
    // attachment array. Reproduce that response shape for journal proof.
    const files = logicalAttachments(message) || [];
    const visibleRetained = retained.filter(file => !(message.embeds || []).some(embed =>
        refersTo(cards.cleanEmbed(embed).image?.url, file, channelId, files)));
    const expected = { channelId: channelId || message.channelId || message.channel?.id, content: message.content || '', embeds, components: (message.components || []).map(plain), attachments: visibleRetained };
    return legacy ? cards.legacyFingerprint(expected) : cards.fingerprint(expected);
}
async function lockRows(lock, interaction, query, readRows) {
    if (typeof lock?.query !== 'function' || typeof lock?.db?.queryDatabaseIndependent !== 'function') throw invalid();
    const params = [interaction.guildId, interaction.channelId, lock.scope.messageId, 'twitter', Date.now()];
    const list = async () => (await readRows('SELECT gallery_id FROM bot_media_galleries WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>? ORDER BY gallery_id', params)).map(row => String(row.gallery_id || ''));
    const ids = await list();
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) throw invalid();
    const rows = [];
    for (const id of ids) {
        const found = await query('SELECT gallery_id,message_id,payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>? FOR UPDATE', [id, ...params]);
        if (found.length !== 1) throw invalid(); rows.push(found[0]);
    }
    if (JSON.stringify(ids) !== JSON.stringify(await list())) throw invalid();
    return rows;
}
function validGroup(payload, row, lock) {
    return payload?.kind === 'twitter-image-grid-v1' && payload.id === row.gallery_id && payload.lockId === lock.lockId
        && payload.sharedInline === true && (!payload.partsState || payload.partsState === 'complete')
        && Number.isInteger(payload.totalParts) && payload.totalParts >= 1 && payload.totalParts <= 20
        && payload.completedParts === payload.totalParts && Array.isArray(payload.messageIds) && payload.messageIds.length === payload.totalParts
        && payload.messageIds[0] === String(lock.scope.messageId) && new Set(payload.messageIds).size === payload.messageIds.length
        && payload.messageIds.every(id => /^\d{1,25}$/.test(String(id || '')))
        && Array.isArray(payload.partSignatures) && payload.partSignatures.length === payload.totalParts
        && payload.partSignatures.every(value => /^[a-f0-9]{64}$/.test(value || ''));
}
async function recoverInline({ lock, interaction, recorded, messages, authorize, verifySource, hashAttachment, fetchCurrent, deadlineAtMs, now = Date.now }) {
    const started = now();
    if (!Number.isSafeInteger(started)) throw invalid();
    const deadline = Math.min(Number.isSafeInteger(deadlineAtMs) ? deadlineAtMs : started + 90000, started + 90000);
    const { readBeforeDeadline } = require('./twitterGridRestoreRecovery');
    const read = work => readBeforeDeadline(work, deadline, now);
    const timeLeft = () => { const remaining = Math.floor(deadline - now()); if (!Number.isSafeInteger(remaining) || remaining < 1) throw invalid(); return remaining; };
    const query = (sql, params) => lock.query(sql, params, { timeoutMs: timeLeft() });
    const readRows = (sql, params) => read(() => lock.db.queryDatabaseIndependent(sql, params, { timeoutMs: timeLeft() }));
    const budget = { bytes: 0, maxBytes: 20 * 25 * 1024 * 1024 };
    const payload = lock?.payload, evidence = recorded?.steps?.[0]?.evidence, step = recorded?.steps?.[0];
    if (typeof authorize !== 'function' || !await read(authorize) || typeof verifySource !== 'function' || typeof hashAttachment !== 'function'
        || !lock?.journal || JSON.stringify(lock.journal.payload) !== JSON.stringify(recorded) || lock.journal.operationId !== recorded?.operationId
        || lock.journal.guildId !== String(interaction?.guildId || '') || lock.journal.channelId !== String(interaction?.channelId || '')
        || lock.journal.messageId !== String(lock.scope?.messageId || '') || recorded?.kind !== 'twitter-grid-restore'
        || !/^[a-f0-9]{32}$/.test(recorded.operationId || '') || recorded.lockId !== lock.lockId || recorded.galleryId !== payload?.id
        || !['here', 'first', 'rest'].includes(recorded.mode) || !['in_progress', 'unknown', 'finished', 'partial_saved'].includes(recorded.state)
        || !Array.isArray(recorded.steps) || !recorded.steps.length || recorded.steps.length > 20 || !Array.isArray(recorded.groupSizes)
        || recorded.steps.length > recorded.groupSizes.length || !Array.isArray(messages) || messages.length !== recorded.steps.length
        || step?.type !== 'edit' || step.index !== 0 || step.start !== 0 || !['inline-reference', 'inline-upload'].includes(evidence?.kind)
        || !/^[a-f0-9]{64}$/.test(evidence.expectedFingerprint || '') || !/^[a-f0-9]{64}$/.test(evidence.expectedStatic || '')
        || !Number.isInteger(evidence.targetStart) || !Number.isInteger(evidence.targetEnd) || evidence.targetStart < 0 || evidence.targetEnd <= evidence.targetStart
        || evidence.targetEnd > 10 || !Array.isArray(evidence.retainedIds) || new Set(evidence.retainedIds.map(String)).size !== evidence.retainedIds.length
        || evidence.retainedIds.some(id => !/^\d{1,25}$/.test(String(id || '')))) throw invalid();
    const original = payload.imageUrls?.length === recorded.imageCount ? payload.imageUrls : payload.restoreArchive?.imageUrls;
    if (!Array.isArray(original) || original.length !== recorded.imageCount || original.length < 2 || original.length > 20
        || original.some(url => !restore.photoIdentity(url)) || !/^\d{1,22}$/.test(recorded.sourceStatusId || '')) throw invalid();
    if (payload.restoreArchive && (payload.restoreArchive.sourceStatusId !== recorded.sourceStatusId
        || !Array.isArray(payload.restoreArchive.imageUrls) || original.length > payload.restoreArchive.imageUrls.length
        || original.some((url, index) => url !== payload.restoreArchive.imageUrls[index]))) throw invalid();
    if (payload.sourceStatusId && payload.sourceStatusId !== recorded.sourceStatusId) throw invalid();
    const verified = await read(() => verifySource({ id: recorded.sourceStatusId, url: `https://x.com/i/web/status/${recorded.sourceStatusId}` }, { ...payload, imageUrls: original }, { deadlineAtMs: deadline, now }));
    if (!Array.isArray(verified) || JSON.stringify(verified) !== JSON.stringify(original)) throw invalid();
    const targetCount = recorded.targetCount ?? (recorded.mode === 'first' ? Math.min(10, original.length) : original.length);
    if ((recorded.baseOffset ?? 0) !== 0 || !Number.isInteger(targetCount) || targetCount < 1 || targetCount > original.length
        || recorded.mode === 'first' && targetCount !== Math.min(10, original.length)
        || recorded.mode !== 'first' && targetCount !== original.length) throw invalid();
    let plan; try { plan = restore.planFromSizes(original, recorded.mode, recorded.groupSizes); } catch { throw invalid(); }
    const groups = [plan.edit, ...plan.sends], sizes = groups.map(group => group.length);
    if (JSON.stringify(sizes) !== JSON.stringify(recorded.groupSizes) || groups.length < messages.length
        || sizes.reduce((sum, value) => sum + value, 0) !== targetCount || step.count !== groups[0].length
        || !Array.isArray(step.proofs) || step.proofs.length !== groups[0].length) throw invalid();
    if (step.proofs.some((proof, index) => !new RegExp(`^restore-${recorded.operationId}-${index}\\.(jpg|png|webp|avif)$`).test(proof?.name || '')
        || !/^[a-f0-9]{64}$/.test(proof?.sha256 || ''))) throw invalid();
    let priorCount = 0;
    for (let index = 0; index < recorded.steps.length; index++) {
        const part = recorded.steps[index], isLast = index === recorded.steps.length - 1;
        if (part.index !== index || part.type !== (index ? 'send' : 'edit') || part.start !== priorCount
            || String(part.previousId || '') !== String(index ? messages[index - 1]?.id : lock.scope.messageId)
            || part.count !== groups[index].length || !['planned', 'confirmed'].includes(part.state)
            || part.state === 'planned' && (!isLast || !['in_progress', 'unknown'].includes(recorded.state))
            || part.state === 'confirmed' && String(part.messageId || '') !== String(messages[index]?.id || '')) throw invalid();
        priorCount += part.count;
    }
    const source = messages[0], botId = String(interaction?.client?.user?.id || ''), channelId = String(interaction?.channelId || '');
    if (!/^\d{1,25}$/.test(botId) || !/^\d{1,25}$/.test(channelId) || !isExpected(source, interaction, lock.scope.messageId)
        || !cards.matchesFingerprint(source, evidence.expectedStatic, true)
        || !cards.matchesFingerprint(source, payload.firstStaticSignature, true)) throw invalid();
    const observed = messages.map(message => cards.fingerprint(message));
    const embeds = (source.embeds || []).map(cards.cleanEmbed), files = logicalAttachments(source);
    if (!files) throw invalid();
    if (evidence.targetEnd > embeds.length || statusIdentity(embeds[evidence.targetStart]?.url) !== recorded.sourceStatusId) throw invalid();
    const ids = files.map(file => String(file.id || ''));
    if (ids.some(id => !/^\d{1,25}$/.test(id)) || new Set(ids).size !== ids.length) throw invalid();
    const retained = files.filter(file => evidence.retainedIds.includes(String(file.id)));
    if (retained.length !== evidence.retainedIds.length || JSON.stringify(retained.map(file => String(file.id))) !== JSON.stringify(evidence.retainedIds.map(String))) throw invalid();
    let uploads = [];
    if (evidence.kind === 'inline-reference') {
        if (files.length !== retained.length || !cards.matchesFingerprint(source, evidence.expectedFingerprint)
            || evidence.targetEnd - evidence.targetStart !== groups[0].length
            || JSON.stringify(embeds.slice(evidence.targetStart, evidence.targetEnd).map(item => item.image?.url)) !== JSON.stringify(groups[0])) throw invalid();
    } else {
        if (!Array.isArray(step.proofs) || step.proofs.length !== groups[0].length
            || !restore.verifyRestoredAttachments(source, { channelId, botId }, step.proofs, evidence.retainedIds)) throw invalid();
        for (const [index, proof] of step.proofs.entries()) {
            if (!new RegExp(`^restore-${recorded.operationId}-${index}\\.(jpg|png|webp|avif)$`).test(proof?.name || '') || !/^[a-f0-9]{64}$/.test(proof?.sha256 || '')) throw invalid();
            const found = files.filter(file => file.name === proof.name); if (found.length !== 1 || await read(() => hashAttachment(found[0], { deadlineAtMs: deadline, now, budget })) !== proof.sha256) throw invalid();
            uploads.push(found[0]);
        }
        if (normalizedFingerprint(source, uploads, retained, channelId) !== evidence.expectedFingerprint
            && normalizedFingerprint(source, uploads, retained, channelId, true) !== evidence.expectedFingerprint) throw invalid();
        if (payload.isPrimary) { if (evidence.targetEnd - evidence.targetStart !== 1 || embeds[evidence.targetStart].image?.url) throw invalid(); }
        else if (evidence.targetEnd - evidence.targetStart !== uploads.length || embeds.slice(evidence.targetStart, evidence.targetEnd).some((embed, i) => !refersTo(embed.image?.url, uploads[i], channelId, files))) throw invalid();
    }
    // A continuation is acceptable only as the exact already-sent Bot message
    // backed by the planned file-name and SHA-256 evidence, never by proximity.
    for (let index = 1, start = groups[0].length; index < messages.length; index++) {
        const item = messages[index], proofStep = recorded.steps[index];
        if (!isExpected(item, interaction, item?.id) || proofStep?.type !== 'send' || proofStep.index !== index || proofStep.start !== start || proofStep.count !== groups[index].length
            || !Array.isArray(proofStep.proofs) || proofStep.proofs.length !== groups[index].length || item.content || (item.embeds || []).length
            || (item.components || []).length || !restore.verifyRestoredAttachments(item, { channelId, botId }, proofStep.proofs)) throw invalid();
        for (const [offset, proof] of proofStep.proofs.entries()) {
            if (!new RegExp(`^restore-${recorded.operationId}-${start + offset}\\.(jpg|png|webp|avif)$`).test(proof?.name || '') || !/^[a-f0-9]{64}$/.test(proof?.sha256 || '')) throw invalid();
            const found = logicalAttachments(item)?.filter(file => file.name === proof.name) || []; if (found.length !== 1 || await read(() => hashAttachment(found[0], { deadlineAtMs: deadline, now, budget })) !== proof.sha256) throw invalid();
        }
        start += groups[index].length;
    }
    if (!await read(authorize)) throw invalid();
    const rows = await lockRows(lock, interaction, query, readRows), entries = [];
    for (const row of rows) {
        let group; try { group = JSON.parse(row.payload_json); } catch { throw invalid(); }
        if (group.lockId !== lock.lockId) continue;
        if (!validGroup(group, row, lock) || !cards.matchesFingerprint(source, group.firstStaticSignature, true)) throw invalid();
        entries.push({ row, payload: group });
    }
    const selected = entries.filter(entry => entry.payload.id === payload.id);
    if (selected.length !== 1 || JSON.stringify(selected[0].payload) !== JSON.stringify(payload)) throw invalid();
    const markerRows = await grid.markerRows(query, interaction, payload, source);
    if (!markerRows || markerRows.has(payload.id)) throw invalid();
    const fingerprint = cards.fingerprint(source), targetEmbeds = embeds.slice(evidence.targetStart, evidence.targetEnd);
    const witness = { hashes: targetEmbeds.map(embed => cards.embedFingerprint(embed, source)), attachments: payload.isPrimary && evidence.kind === 'inline-upload'
        ? uploads.map(file => ({ id: String(file.id), name: file.name })) : [] };
    if (!grid.embedWitnessPosition(source, witness)) throw invalid();
    const visibleGroups = groups.slice(0, messages.length), visible = visibleGroups.flat();
    const partial = messages.length < groups.length;
    const { replacePhase, ...unchanged } = payload; void replacePhase;
    const archivedImages = payload.restoreArchive?.imageUrls || original;
    const laterAvailable = !partial && recorded.mode === 'first' && visible.length < archivedImages.length;
    const target = { ...unchanged, imageUrls: visible, expectedImageUrls: visible,
        expectedRefs: visible.map(url => ({ type: 'url', url })), partRefs: visibleGroups.map(group => group.map(url => ({ type: 'url', url }))),
        partSizes: visibleGroups.map(group => group.length), totalParts: messages.length, completedParts: messages.length, partsState: 'complete',
        messageIds: messages.map(item => String(item.id)), partSignatures: messages.map(item => cards.fingerprint(item)),
        firstStaticSignature: evidence.expectedStatic, embedStart: evidence.targetStart, embedEnd: evidence.targetEnd, embedWitness: witness,
        partContainsNonImage: messages.map(item => cards.attachmentList(item).some(file => !String(file.contentType || '').startsWith('image/'))),
        sourceStatusId: recorded.sourceStatusId, restoreArchive: payload.restoreArchive || { sourceStatusId: recorded.sourceStatusId, imageUrls: [...original] },
        ...(partial || laterAvailable ? { restoreContinuation: { sourceStatusId: recorded.sourceStatusId, nextIndex: visible.length,
            targetCount: partial ? targetCount : archivedImages.length } } : {}) };
    const updates = [];
    for (const entry of entries) {
        if (entry.payload.id === payload.id) { updates.push({ row: entry.row, next: target }); continue; }
        let position;
        if (markerRows.has(entry.payload.id)) {
            const found = files.filter(file => isMarker(entry.payload.id, file));
            if (found.length !== 1 || entry.payload.replacePhase !== 'done') throw invalid();
            const index = markerPosition(source, found[0], channelId); if (index === null) throw invalid(); position = { start: index, end: index + 1 };
        } else position = grid.embedWitnessPosition(source, entry.payload.embedWitness);
        if (!position || position.start < evidence.targetEnd && position.end > evidence.targetStart) throw invalid();
        updates.push({ row: entry.row, next: { ...entry.payload, embedStart: position.start, embedEnd: position.end,
            partSignatures: [fingerprint, ...entry.payload.partSignatures.slice(1)], firstStaticSignature: evidence.expectedStatic } });
    }
    const fetch = fetchCurrent || (id => interaction.channel.messages.fetch({ message: id, force: true, cache: false }));
    for (const [index, originalMessage] of messages.entries()) {
        let latest; try { latest = await read(() => fetch(String(originalMessage.id))); } catch { throw invalid(); }
        if (!isExpected(latest, interaction, originalMessage.id) || cards.fingerprint(latest) !== observed[index]
            || cards.fingerprint(originalMessage) !== observed[index]) throw invalid();
    }
    if (!await read(authorize)) throw invalid();
    for (const update of updates) {
        if (JSON.stringify(update.next) === update.row.payload_json) continue;
        const result = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
            [JSON.stringify(update.next), update.row.gallery_id, lock.scope.messageId, update.row.payload_json]);
        if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    }
    return { target, partial };
}
module.exports = { recoverInline };
