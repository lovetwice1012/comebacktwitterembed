'use strict';

// Shared-message helpers only. Call under the common gallery lock; the caller
// owns the durable journal, source verification and single-attempt Discord I/O.
const cards = require('./twitterGridCards');
const { isExpected } = require('./discordMessageIdentity');
const grid = require('./components/twitterGrid')._internal;
const restore = require('./twitterGridRestore');
const { matchesReference, matchesUniqueReference, logicalAttachments } = require('./discordAttachmentIdentity');
const gridMarkers = require('./discordGridMarkers');

function invalid() { return new Error('GRID_RESTORE_INLINE_UNAVAILABLE'); }
function plain(value) { return value?.toJSON ? value.toJSON() : JSON.parse(JSON.stringify(value || {})); }
function markerFor(id, file) {
    return /^[a-f0-9]{32}$/.test(id || '') && new RegExp(`^tg-${id}\\.(?:jpg|png|webp)$`).test(file?.name || '')
        && /^\d{1,25}$/.test(String(file.id || '')) && /^image\/(?:jpeg|png|webp)$/i.test(file.contentType || '');
}
function referencesAttachment(url, file, channelId, allowAttachmentScheme = false) {
    return matchesReference(url, file, channelId, { allowAttachmentScheme });
}
function markerPosition(message, file, channelId = message.channelId || message.channel?.id) {
    const match = /^tg-([a-f0-9]{32})\.(?:jpg|png|webp)$/.exec(String(file?.name || ''));
    if (!match || String(message?.channelId || message?.channel?.id || '') !== String(channelId || '')) return null;
    const marker = gridMarkers.get(message, match[1]);
    return marker && marker.id === String(file.id || '') && marker.name === file.name && marker.embedIndices.length === 1
        ? marker.embedIndices[0] : null;
}
// Discord excludes embed-referenced uploads from message.attachments. Include
// only same-channel, strictly identified grid markers; the surrounding DB
// witness checks must validate every such marker before any edit is built.
function messageFiles(message) {
    if (!gridMarkers.collect(message)) return null;
    return logicalAttachments(message);
}
function validGroup(payload, row, scope) {
    return payload?.kind === 'twitter-image-grid-v1' && payload.id === row.gallery_id && /^[a-f0-9]{32}$/.test(payload.id || '')
        && payload.lockId === scope.lockId && payload.sharedInline === true && (!payload.partsState || payload.partsState === 'complete')
        && Number.isInteger(payload.totalParts) && payload.totalParts >= 1 && payload.totalParts <= 20
        && payload.completedParts === payload.totalParts && Array.isArray(payload.messageIds) && payload.messageIds.length === payload.totalParts
        && payload.messageIds[0] === scope.messageId && new Set(payload.messageIds).size === payload.messageIds.length
        && Array.isArray(payload.partSignatures) && payload.partSignatures.length === payload.totalParts
        && /^[a-f0-9]{64}$/.test(payload.firstStaticSignature || '');
}
async function lockRowsById(query, readRows, interaction, scope) {
    const sql = 'SELECT gallery_id FROM bot_media_galleries WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>? ORDER BY gallery_id';
    const params = [interaction.guildId, interaction.channelId, scope.messageId, 'twitter', Date.now()];
    const list = async () => (await readRows(sql, params)).map(row => String(row.gallery_id || ''));
    const ids = await list();
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) throw invalid();
    const rows = [];
    for (const id of [...ids].sort()) {
        const selected = await query('SELECT gallery_id,message_id,payload_json FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>? FOR UPDATE',
            [id, ...params]);
        if (selected.length !== 1) throw invalid();
        rows.push(selected[0]);
    }
    if (JSON.stringify(ids) !== JSON.stringify(await list())) throw invalid();
    return rows;
}
async function inspect({ query, readRows = query, interaction, payload, message, authorize }) {
    if (typeof query !== 'function' || typeof authorize !== 'function' || !await authorize() || !payload || !message
        || !isExpected(message, interaction, payload.messageIds?.[0]) || !payload.sharedInline || payload.replacePhase !== 'done') throw invalid();
    const scope = { lockId: payload.lockId, messageId: String(message.id), channelId: String(interaction.channelId) }, files = messageFiles(message);
    if (!files || new Set(files.map(file => String(file.id || ''))).size !== files.length || files.some(file => !/^\d{1,25}$/.test(String(file.id || '')))) throw invalid();
    // Discord cannot safely reconstruct a video-bearing rich embed through an
    // edit. Preserve the post rather than silently discard that content.
    if ((message.embeds || []).some(embed => { const data = plain(embed); return !!data.video; })) throw invalid();
    const own = files.filter(file => markerFor(payload.id, file));
    if (own.length !== 1 || markerPosition(message, own[0], scope.channelId) === null || !cards.matchesFingerprint(message, payload.firstStaticSignature, true)) throw invalid();
    const rows = await lockRowsById(query, readRows, interaction, scope);
    const entries = [];
    for (const row of rows) {
        let group; try { group = JSON.parse(row.payload_json); } catch { throw invalid(); }
        if (group.lockId !== scope.lockId) continue;
        if (!validGroup(group, row, scope)) throw invalid();
        entries.push({ row, payload: group });
    }
    const targetRows = entries.filter(entry => entry.payload.id === payload.id);
    if (targetRows.length !== 1 || JSON.stringify(targetRows[0].payload) !== JSON.stringify(payload)
        || entries.some(entry => !cards.matchesFingerprint(message, entry.payload.firstStaticSignature, true))) throw invalid();
    const markers = await grid.markerRows(query, interaction, payload, message);
    if (!markers || !markers.has(payload.id)) throw invalid();
    const witnesses = new Map();
    for (const entry of entries) {
        if (entry.payload.id === payload.id) continue;
        if (markers.has(entry.payload.id)) {
            const sibling = files.filter(file => markerFor(entry.payload.id, file));
            if (sibling.length !== 1 || markerPosition(message, sibling[0], scope.channelId) === null || entry.payload.replacePhase !== 'done') throw invalid();
        } else {
            const position = grid.embedWitnessPosition(message, entry.payload.embedWitness);
            if (!position) throw invalid();
            witnesses.set(entry.payload.id, position);
        }
    }
    return { scope, payload, entries, witnesses, marker: { ...own[0] }, markerIndex: markerPosition(message, own[0], scope.channelId),
        expectedFingerprint: cards.fingerprint(message), content: message.content || '',
        components: (message.components || []).map(plain), embeds: (message.embeds || []).map(cards.cleanEmbed),
        attachments: files.map(file => ({ id: String(file.id), name: file.name, contentType: file.contentType, url: file.url })) };
}
function prepareEdit(snapshot, uploads) {
    if (!snapshot || !Array.isArray(uploads) || !uploads.length || uploads.length > 10
        || uploads.some(file => !Buffer.isBuffer(file?.data) || !file.data.length || !/^restore-[a-f0-9]{32}-\d{1,2}\.(?:jpg|png|webp|avif)$/.test(file.name || ''))
        || new Set(uploads.map(file => file.name)).size !== uploads.length) throw invalid();
    const retained = snapshot.attachments.filter(file => file.id !== String(snapshot.marker.id));
    if (retained.length + uploads.length > 10) throw invalid();
    const embeds = snapshot.embeds.map(plain), index = snapshot.markerIndex;
    if (!embeds[index] || !matchesUniqueReference(embeds[index].image?.url, snapshot.marker, snapshot.attachments, snapshot.scope.channelId)) throw invalid();
    const target = { ...embeds[index] }; delete target.image;
    let targetEnd = index + 1;
    if (snapshot.payload.isPrimary) {
        embeds[index] = target;
    } else {
        // The quote's images remain associated with its own embed. Other
        // embeds and attachments, including the parent, are never rewritten.
        const additions = uploads.map((file, offset) => {
            const item = offset ? { url: target.url, color: target.color } : { ...target };
            if (item.url && offset >= 4) { try { const url = new URL(item.url); url.hash = `g${Math.floor(offset / 4)}`; item.url = url.toString(); } catch { throw invalid(); } }
            item.image = { url: `attachment://${file.name}` }; return item;
        });
        if (embeds.length - 1 + additions.length > 10) throw invalid();
        embeds.splice(index, 1, ...additions); targetEnd = index + additions.length;
    }
    return { kind: 'uploads', edit: { content: snapshot.content, embeds, components: snapshot.components,
        attachments: retained.map(file => ({ id: file.id })), files: uploads.map(file => ({ attachment: file.data, name: file.name })),
        allowedMentions: { parse: [], repliedUser: false } }, retained, uploads, targetStart: index, targetEnd };
}
function capacity(snapshot, photoCount) {
    if (!snapshot || !Number.isInteger(photoCount) || photoCount < 1 || photoCount > 20) throw invalid();
    const retained = snapshot.attachments.filter(file => file.id !== String(snapshot.marker.id)).length;
    const attachmentSlots = Math.max(0, 10 - retained), embedSlots = Math.max(0, 10 - (snapshot.embeds.length - 1));
    const inlineUploadMax = Math.min(10, attachmentSlots, snapshot.payload.isPrimary ? 10 : embedSlots);
    const inlineReferenceMax = Math.min(10, embedSlots);
    return { photoCount, attachmentSlots, embedSlots, inlineUploadMax, inlineReferenceMax,
        requiresSeparateMessages: photoCount > Math.max(inlineUploadMax, inlineReferenceMax) };
}
async function prepareReferenceEdit(snapshot, urls, verifySource) {
    if (!snapshot || typeof verifySource !== 'function' || !Array.isArray(urls) || urls.length < 1 || urls.length > 10
        || !Array.isArray(snapshot.payload.imageUrls) || JSON.stringify(urls) !== JSON.stringify(snapshot.payload.imageUrls.slice(0, urls.length))
        || urls.some(url => !restore.photoIdentity(url))) throw invalid();
    const verified = await verifySource(snapshot.payload, urls);
    if (!Array.isArray(verified) || JSON.stringify(verified) !== JSON.stringify(urls)) throw invalid();
    const retained = snapshot.attachments.filter(file => file.id !== String(snapshot.marker.id));
    const embeds = snapshot.embeds.map(plain), index = snapshot.markerIndex;
    if (!embeds[index] || !matchesUniqueReference(embeds[index].image?.url, snapshot.marker, snapshot.attachments, snapshot.scope.channelId)) throw invalid();
    const target = { ...embeds[index] }; delete target.image;
    const additions = urls.map((url, offset) => {
        const item = offset ? { url: target.url, color: target.color } : { ...target };
        if (item.url && offset >= 4) { try { const group = new URL(item.url); group.hash = `g${Math.floor(offset / 4)}`; item.url = group.toString(); } catch { throw invalid(); } }
        item.image = { url }; return item;
    });
    if (embeds.length - 1 + additions.length > 10) throw invalid();
    embeds.splice(index, 1, ...additions);
    return { kind: 'references', urls: [...urls], uploads: [], retained, targetStart: index, targetEnd: index + additions.length,
        edit: { content: snapshot.content, embeds, components: snapshot.components,
            attachments: retained.map(file => ({ id: file.id })), allowedMentions: { parse: [], repliedUser: false } } };
}
function referenceManifest(snapshot, plan, message) {
    if (!snapshot || plan?.kind !== 'references' || !message || String(message.id || '') !== snapshot.scope.messageId
        || JSON.stringify(plan.urls) !== JSON.stringify(snapshot.payload.imageUrls.slice(0, plan.urls.length))) throw invalid();
    const { replacePhase, ...unchanged } = snapshot.payload; void replacePhase;
    const archived = snapshot.payload.restoreArchive;
    if (archived && (!Array.isArray(archived.imageUrls) || !Array.isArray(snapshot.payload.imageUrls)
        || snapshot.payload.imageUrls.length > archived.imageUrls.length
        || snapshot.payload.imageUrls.some((url, index) => url !== archived.imageUrls[index])
        || snapshot.payload.sourceStatusId && archived.sourceStatusId !== snapshot.payload.sourceStatusId)) throw invalid();
    return { ...unchanged, imageUrls: [...plan.urls], expectedImageUrls: [...plan.urls],
        partRefs: [plan.urls.map(url => ({ type: 'url', url }))], partSizes: [plan.urls.length],
        messageIds: [snapshot.scope.messageId], completedParts: 1, totalParts: 1, partsState: 'complete',
        partSignatures: [cards.fingerprint(message)], firstStaticSignature: cards.fingerprint(message, true),
        partContainsNonImage: [plan.retained.some(file => !String(file.contentType || '').startsWith('image/'))],
        restoreArchive: archived || { sourceStatusId: snapshot.payload.sourceStatusId || null, imageUrls: [...snapshot.payload.imageUrls] } };
}
async function inspectPartial({ query, readRows = query, interaction, payload, message, authorize }) {
    if (typeof query !== 'function' || typeof authorize !== 'function' || !await authorize()
        || !isExpected(message, interaction, payload?.messageIds?.[0]) || !payload?.sharedInline
        || !restore.statusFromPartial(payload, message)) throw invalid();
    const scope = { lockId: payload.lockId, messageId: String(message.id), channelId: String(interaction.channelId) };
    const rows = await lockRowsById(query, readRows, interaction, scope);
    const entries = [];
    for (const row of rows) {
        let group; try { group = JSON.parse(row.payload_json); } catch { throw invalid(); }
        if (group.lockId !== scope.lockId) continue;
        if (!validGroup(group, row, scope) || !cards.matchesFingerprint(message, group.firstStaticSignature, true)) throw invalid();
        entries.push({ row, payload: group });
    }
    const targets = entries.filter(entry => entry.payload.id === payload.id);
    if (targets.length !== 1 || JSON.stringify(targets[0].payload) !== JSON.stringify(payload)) throw invalid();
    const markers = await grid.markerRows(query, interaction, payload, message), files = messageFiles(message);
    if (!files || !markers || markers.has(payload.id) || !grid.embedWitnessPosition(message, payload.embedWitness)) throw invalid();
    for (const entry of entries) {
        if (entry.payload.id === payload.id) continue;
        if (markers.has(entry.payload.id)) {
            const marker = files.filter(file => markerFor(entry.payload.id, file));
            if (marker.length !== 1 || markerPosition(message, marker[0], scope.channelId) === null || entry.payload.replacePhase !== 'done') throw invalid();
        } else if (!grid.embedWitnessPosition(message, entry.payload.embedWitness)) throw invalid();
    }
    return { scope, payload, entries, expectedFingerprint: cards.fingerprint(message) };
}
async function commitResume({ query, interaction, snapshot, first, continuation, operationId, uploads, authorize }) {
    const existing = Array.isArray(first) ? first : [first], added = Array.isArray(continuation) ? continuation : [continuation];
    const batches = Array.isArray(uploads?.[0]) ? uploads : [uploads];
    if (typeof query !== 'function' || typeof authorize !== 'function' || !await authorize() || !snapshot || !existing[0]
        || !isExpected(existing[0], interaction, snapshot.scope.messageId) || cards.fingerprint(existing[0]) !== snapshot.expectedFingerprint
        || !restore.statusFromPartial(snapshot.payload, existing[0]) || added.length !== batches.length
        || existing.some((message, i) => !isExpected(message, interaction, snapshot.payload.messageIds[i])
            || !cards.matchesFingerprint(message, snapshot.payload.partSignatures[i]))
        || added.some((message, i) => !isExpected(message, interaction, null) || !restore.verifyRestoredAttachments(message, { channelId: interaction.channelId, botId: interaction.client.user.id }, batches[i]))) throw invalid();
    let next; try { next = restore.resumedManifest(snapshot.payload, operationId, existing, added); } catch { throw invalid(); }
    const target = snapshot.entries.find(entry => entry.payload.id === snapshot.payload.id);
    if (!target) throw invalid();
    const changed = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), target.row.gallery_id, snapshot.scope.messageId, target.row.payload_json]);
    if (Number(changed?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    return next;
}
function normalizedEmbeds(embeds, attachments, channelId, allowAttachmentScheme = false, actual = false) {
    return embeds.map(embed => {
        const data = cards.cleanEmbed(embed), url = data.image?.url;
        if (url) {
            const match = attachments.filter(file => actual ? matchesUniqueReference(url, file, attachments, channelId)
                : referencesAttachment(url, file, channelId, allowAttachmentScheme));
            if (match.length === 1) data.image.url = `attachment://${match[0].name}`;
            else if (actual && String(url).startsWith('attachment://')) data.image.url = { unverifiedAttachment: true };
        }
        return data;
    });
}
async function commit({ query, interaction, snapshot, plan, message, targetPayload, authorize }) {
    if (typeof query !== 'function' || typeof authorize !== 'function' || !await authorize() || !snapshot || !plan || !message
        || !isExpected(message, interaction, snapshot.scope.messageId)
        || (message.content || '') !== snapshot.content || JSON.stringify((message.components || []).map(plain)) !== JSON.stringify(snapshot.components)) throw invalid();
    const actualFiles = messageFiles(message);
    if (!actualFiles) throw invalid();
    if (plan.kind === 'uploads') {
        if (!restore.verifyRestoredAttachments(message, { channelId: interaction.channelId, botId: interaction.client.user.id }, plan.uploads, plan.retained.map(file => file.id))) throw invalid();
    } else if (plan.kind !== 'references' || actualFiles.length !== plan.retained.length) throw invalid();
    if (plan.retained.some(old => !actualFiles.some(file => String(file.id) === old.id && file.name === old.name && file.contentType === old.contentType))
        || JSON.stringify(normalizedEmbeds(message.embeds || [], actualFiles, interaction.channelId, true, true)) !== JSON.stringify(normalizedEmbeds(plan.edit.embeds, actualFiles, interaction.channelId, true))) throw invalid();
    const fingerprint = cards.fingerprint(message), staticSignature = cards.fingerprint(message, true);
    if (!targetPayload || targetPayload.kind !== 'twitter-image-grid-v1' || targetPayload.id !== snapshot.payload.id
        || targetPayload.lockId !== snapshot.scope.lockId || targetPayload.messageIds?.[0] !== snapshot.scope.messageId
        || targetPayload.partSignatures?.[0] !== fingerprint || targetPayload.partsState !== 'complete'
        || !Number.isInteger(targetPayload.totalParts) || targetPayload.totalParts < 1 || targetPayload.totalParts > 20
        || targetPayload.completedParts !== targetPayload.totalParts || !Array.isArray(targetPayload.messageIds)
        || targetPayload.messageIds.length !== targetPayload.totalParts || new Set(targetPayload.messageIds).size !== targetPayload.totalParts
        || !Array.isArray(targetPayload.partSignatures) || targetPayload.partSignatures.length !== targetPayload.totalParts
        || targetPayload.partSignatures.some(value => !/^[a-f0-9]{64}$/.test(value || ''))
        || !Array.isArray(targetPayload.partSizes) || targetPayload.partSizes.length !== targetPayload.totalParts
        || !Array.isArray(targetPayload.partRefs) || targetPayload.partRefs.length !== targetPayload.totalParts
        || targetPayload.partSizes.some((count, i) => !Number.isInteger(count) || count < 0 || count > 10
            || !Array.isArray(targetPayload.partRefs[i]) || targetPayload.partRefs[i].length !== count)
        || !Array.isArray(targetPayload.imageUrls) || targetPayload.partSizes.reduce((sum, count) => sum + count, 0) !== targetPayload.imageUrls.length
        || targetPayload.imageUrls.some((url, index) => url !== snapshot.payload.imageUrls[index])
        || targetPayload.partRefs.flat().some((ref, index) => ref?.type !== 'url' || ref.url !== targetPayload.imageUrls[index])
        || targetPayload.partSizes[0] !== (plan.kind === 'references' ? plan.urls.length : plan.uploads.length)) throw invalid();
    for (const key of ['requesterId', 'settingsHash', 'nsfw', 'nsfwContextVersion', 'sourceStatusId', 'isPrimary']) {
        if (snapshot.payload[key] !== undefined && targetPayload[key] !== snapshot.payload[key]) throw invalid();
    }
    const restored = plan.uploads.map(file => actualFiles.find(actual => actual.name === file.name));
    const witness = { hashes: (message.embeds || []).slice(plan.targetStart, plan.targetEnd).map(embed => cards.embedFingerprint(embed, message)),
        attachments: snapshot.payload.isPrimary && plan.kind === 'uploads' ? restored.map(file => ({ id: String(file.id), name: file.name })) : [] };
    if (!grid.embedWitnessPosition(message, witness)) throw invalid();
    const updates = [];
    for (const entry of snapshot.entries) {
        let next;
        if (entry.payload.id === snapshot.payload.id) next = { ...targetPayload, sharedInline: true, embedStart: plan.targetStart,
            embedEnd: plan.targetEnd, embedWitness: witness, firstStaticSignature: staticSignature };
        else {
            const previous = snapshot.witnesses.get(entry.payload.id);
            let position;
            if (previous) position = grid.embedWitnessPosition(message, entry.payload.embedWitness);
            else {
                const marker = actualFiles.filter(file => markerFor(entry.payload.id, file));
                if (marker.length !== 1) throw invalid();
                const index = markerPosition(message, marker[0], interaction.channelId); if (index === null) throw invalid();
                position = { start: index, end: index + 1 };
            }
            if (!position) throw invalid();
            next = { ...entry.payload, embedStart: position.start, embedEnd: position.end,
                partSignatures: [fingerprint, ...entry.payload.partSignatures.slice(1)], firstStaticSignature: staticSignature };
        }
        updates.push({ row: entry.row, next });
    }
    for (const item of updates) {
        const result = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
            [JSON.stringify(item.next), item.row.gallery_id, snapshot.scope.messageId, item.row.payload_json]);
        if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    }
    return updates.find(item => item.next.id === snapshot.payload.id).next;
}
module.exports = { inspect, inspectPartial, capacity, prepareEdit, prepareReferenceEdit, referenceManifest, commit, commitResume, messageFiles };
