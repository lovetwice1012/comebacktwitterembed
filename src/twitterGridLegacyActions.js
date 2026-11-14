'use strict';

// Existing message controls operate on all physical messages of a split X
// post. The caller holds the same SQL lock as the public grid replacement.
const cards = require('./twitterGridCards');
const { matchesReference, matchesUniqueReference, logicalAttachments } = require('./discordAttachmentIdentity');
const { randomBytes, createHash } = require('node:crypto');
const twitterProvider = require('./providers/twitter');
let activeSourceUploads = 0;
const MAX_SOURCE_UPLOADS = 2, MAX_SOURCE_BYTES = 80 * 1024 * 1024;
function definitelyRejected(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    return [400, 401, 403, 405, 413, 415, 422, 429].includes(status);
}

function own(message, interaction, expectedId) {
    return message?.author?.id === interaction.client?.user?.id
        && (!expectedId || String(message.id || '') === String(expectedId))
        && String(message.channelId || message.channel?.id || '') === String(interaction.channelId || '')
        && (!message.guildId || String(message.guildId) === String(interaction.guildId || ''));
}
function items(message) {
    const files = logicalAttachments(message);
    if (!files) throw new Error('GRID_SOURCE_CHANGED');
    return files;
}
function isSpoiler(file) {
    try {
        if (file?.spoiler === true || /^SPOILER_/i.test(String(file?.name || ''))) return true;
        if (typeof file?.flags?.has === 'function') return file.flags.has(8);
        return Number.isSafeInteger(file?.flags) && (file.flags & 8) !== 0;
    } catch { return true; }
}
function buttonData(button) { return button?.toJSON ? button.toJSON() : JSON.parse(JSON.stringify(button)); }
function switchRows(message, options, action) {
    const next = action === 'showAttachmentsAsEmbedsImage' ? options.buttons?.showMediaAsAttachmentsButton : options.buttons?.showAttachmentsAsMediaButton;
    if (!next) throw new Error('GRID_LOCK_UNAVAILABLE');
    return (message.components || []).map(row => {
        const raw = buttonData(row);
        return { ...raw, components: (raw.components || []).map(component => {
            const key = component.custom_id || component.customId;
            if (String(key || '').split(':')[0] !== action) return component;
            const changed = buttonData(next), locator = cards.locatorIdFromAction(key);
            if (locator) changed.custom_id = `${String(changed.custom_id).split(':')[0]}:sl1:${locator}`;
            return changed;
        }) };
    });
}
function groupFiles(message, payload) {
    const all = items(message);
    if (new Set(all.map(file => String(file.id))).size !== all.length || new Set(all.map(file => String(file.name))).size !== all.length)
        throw new Error('GRID_SOURCE_CHANGED');
    const isRoot = String(message?.id || '') === String(payload?.messageIds?.[0] || '');
    const after = isRoot && payload?.sharedInline && Number.isInteger(payload.embedEnd)
        ? (message.embeds || []).slice(payload.embedEnd) : [];
    const selected = all.filter(file => {
        const marker = /^tg-([a-f0-9]{32})\.(?:jpg|png|webp)$/.exec(file.name || '');
        if (marker && marker[1] !== payload?.id) return false;
        // Quoted groups can contain CDN-backed images in the same message.
        // A verified sibling is retained, never moved into the parent group.
        return !after.some(embed => matchesUniqueReference(cards.cleanEmbed(embed).image?.url, file, all,
            message.channelId || message.channel?.id));
    });
    return { all, selected, isRoot };
}
function currentAttachments(message, payload) {
    const { all, selected, isRoot } = groupFiles(message, payload);
    if (selected.some(file => !/^(image\/(jpeg|png|webp|avif)|video\/[^\s]+|audio\/[^\s]+)$/i.test(String(file.contentType || ''))))
        throw new Error('GRID_SOURCE_CHANGED');
    const attachments = selected.filter(file => /^image\/(jpeg|png|webp|avif)$/i.test(String(file.contentType || '')));
    if (!attachments.length || new Set(attachments.map(file => String(file.id))).size !== attachments.length
        || new Set(attachments.map(file => String(file.name))).size !== attachments.length
        || attachments.some(file => !/^\d{1,25}$/.test(String(file.id || '')) || !file.name
            || !/^image\/(jpeg|png|webp|avif)$/i.test(String(file.contentType || ''))
            || !matchesReference(file.url, file, message.channelId || message.channel?.id))) throw new Error('GRID_SOURCE_CHANGED');
    // Discord omits embedded files from attachments. Their Embed order is the
    // original first segment; any visible non-embedded image attachments are
    // the remaining segment (for example, when a quote leaves only 8 embeds).
    const end = isRoot && payload?.sharedInline && Number.isInteger(payload.embedEnd) ? payload.embedEnd : (message.embeds || []).length;
    const ordered = [], seen = new Set();
    for (const embed of (message.embeds || []).slice(0, end)) {
        const url = cards.cleanEmbed(embed).image?.url;
        const matches = attachments.filter(file => matchesUniqueReference(url, file, all, message.channelId || message.channel?.id));
        if (matches.length > 1) throw new Error('GRID_SOURCE_CHANGED');
        if (matches.length === 1 && !seen.has(String(matches[0].id))) { ordered.push(matches[0]); seen.add(String(matches[0].id)); }
    }
    for (const file of attachments) if (!seen.has(String(file.id))) ordered.push(file);
    return ordered;
}

function approvedPhotoPart(payload, index) {
    const sizes = payload.partSizes, refs = payload.partRefs, flags = payload.partContainsNonImage, urls = payload.imageUrls;
    if (!Array.isArray(payload.messageIds) || !Array.isArray(sizes) || !Array.isArray(refs) || !Array.isArray(flags) || !Array.isArray(urls)
        || sizes.length !== payload.messageIds.length || refs.length !== sizes.length || flags.length !== sizes.length
        || sizes.some(size => !Number.isInteger(size) || size < 0 || size > 10)
        || !Number.isInteger(index) || index < 0 || index >= sizes.length
        || flags.some(flag => typeof flag !== 'boolean') || refs.some((part, i) => !Array.isArray(part) || part.length !== sizes[i])
        || sizes.reduce((sum, size) => sum + size, 0) !== urls.length) return false;
    if (refs.flat().some((ref, offset) => {
        if (ref?.type !== 'url' || ref.url !== urls[offset]) return true;
        try {
            const value = require('./providers/twitter/twitterSourceParser/mediaUrlPolicy').validateTwitterMediaUrl(ref.url, 'photo').url;
            return (value.searchParams.get('format') || '').toLowerCase() === 'gif' || /\.gif(?::|$)/i.test(value.pathname);
        } catch { return true; }
    })) return false;
    return true;
}

function hiddenImageEvidence(message, payload, index, combined = false) {
    const { selected } = groupFiles(message, payload);
    const visible = cards.attachmentList(message), visibleIds = new Set(visible.map(file => String(file.id || '')));
    const hidden = selected.filter(file => /^image\//i.test(String(file.contentType || '')) && !visibleIds.has(String(file.id || '')));
    if (!hidden.length) return true;
    if (!approvedPhotoPart(payload, index)) return false;
    // Non-image media must remain explicitly visible and retained; a hidden
    // video or an old record without a trustworthy media flag is not guessed.
    const otherFiles = selected.filter(file => !/^image\//i.test(String(file.contentType || '')));
    if (payload.partContainsNonImage[index] !== (otherFiles.length > 0)) return false;
    if (combined && index === 0) return hidden.length === 1 && new RegExp(`^tg-${payload.id}\\.(jpg|png|webp)$`).test(hidden[0].name || '');
    return currentAttachments(message, payload).length === payload.partSizes[index];
}
function groupEmbedUrl(base, index) {
    if (!base) return undefined;
    try { const url = new URL(base); url.hash = `g${Math.floor(index / 4)}`; return url.toString(); }
    catch { return undefined; }
}
function makeEdit(message, base, action, first, options, suffix = [], payload) {
    const files = currentAttachments(message, payload);
    const embeds = [];
    if (action === 'showAttachmentsAsEmbedsImage') {
        const maximum = first ? Math.max(1, 10 - suffix.length) : 10;
        for (let index = 0; index < Math.min(files.length, maximum); index++) {
            const embed = index === 0 && first ? { ...base } : {};
            const url = groupEmbedUrl(base.url, index);
            if (url) embed.url = url;
            embed.image = { url: `attachment://${files[index].name}` };
            embeds.push(embed);
        }
    } else if (first) embeds.push(base);
    if (first) embeds.push(...suffix);
    const selected = new Set(files.map(file => String(file.id)));
    const retained = [...files, ...items(message).filter(file => !selected.has(String(file.id)))];
    return { content: message.content || '', embeds, attachments: retained.map(file => ({ id: String(file.id) })),
        components: first ? switchRows(message, options, action) : [], allowedMentions: { parse: [] } };
}
function sameAttachments(a, b) {
    const left = items(a).map(file => [String(file.id), file.name]).sort();
    const right = items(b).map(file => [String(file.id), file.name]).sort();
    return JSON.stringify(left) === JSON.stringify(right);
}
function translationWitness(message) {
    const embeds = (message.embeds || []).map(cards.cleanEmbed);
    if (embeds[0]) delete embeds[0].description;
    return JSON.stringify({ content: message.content || '', embeds,
        components: (message.components || []).map(buttonData),
        attachments: items(message).map(file => [String(file.id), file.name]) });
}
function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    return value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
}
function semanticEmbeds(embeds, attachments, channelId, allowAttachmentScheme = false, actual = false) {
    return (embeds || []).map(embed => {
        const clean = cards.cleanEmbed(embed);
        if (clean.image?.url) {
            const url = clean.image.url;
            const matches = attachments.filter(file => actual ? matchesUniqueReference(url, file, attachments, channelId)
                : matchesReference(url, file, channelId, { allowAttachmentScheme }));
            if (matches.length === 1) clean.image.url = `attachment://${matches[0].name}`;
            else if (actual && String(url).startsWith('attachment://')) clean.image.url = { unverifiedAttachment: true };
        }
        return clean;
    });
}
function semanticButtons(rows) {
    return (rows || []).map(row => (row.components || buttonData(row).components || []).map(button => {
        const raw = buttonData(button);
        const canonical = { ...raw, custom_id: raw.custom_id ?? raw.customId ?? null, disabled: raw.disabled === true,
            emoji: raw.emoji ? { id: raw.emoji.id ?? null, name: raw.emoji.name ?? null, animated: raw.emoji.animated === true } : null };
        delete canonical.id; delete canonical.customId;
        return canonical;
    }));
}
function matchesEdit(message, edit, expectedAttachments, channelId = message.channelId || message.channel?.id) {
    try {
        const actual = items(message);
        if (new Set(actual.map(file => String(file.id || ''))).size !== actual.length
            || new Set(actual.map(file => file.name)).size !== actual.length
            || !sameAttachments({ attachments: expectedAttachments }, message) || (message.content || '') !== (edit.content || '')) return false;
        const left = { embeds: semanticEmbeds(edit.embeds, actual, channelId, true), components: semanticButtons(edit.components) };
        const right = { embeds: semanticEmbeds(message.embeds, actual, channelId, true, true), components: semanticButtons(message.components) };
        return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
    } catch { return false; }
}
function stateDigest(content, embeds, components, attachments, namesOnly = false, channelId, allowAttachmentScheme = false, actual = false) {
    const state = { content: content || '', embeds: semanticEmbeds(embeds, attachments, channelId, allowAttachmentScheme, actual), components: semanticButtons(components),
        attachments: attachments.map(file => namesOnly ? file.name : [String(file.id), file.name]).sort() };
    return createHash('sha256').update(JSON.stringify(ordered(state))).digest('hex');
}
function messageDigest(message, namesOnly = false, channelId = message.channelId || message.channel?.id) { return stateDigest(message.content, message.embeds, message.components, items(message), namesOnly, channelId, true, true); }
function editDigest(edit, attachments, namesOnly = false, channelId) { return stateDigest(edit.content, edit.embeds, edit.components, attachments, namesOnly, channelId, true); }
async function saveIntent(db, interaction, payload, intent) {
    if (typeof db.queryDatabaseIndependent !== 'function') throw new Error('GRID_LOCK_UNAVAILABLE');
    await db.queryDatabaseIndependent(`INSERT INTO bot_twitter_grid_action_intents
        (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id),payload_json=VALUES(payload_json),updated_at_ms=VALUES(updated_at_ms)`,
    [payload.lockId, interaction.guildId, interaction.channelId, payload.messageIds[0], intent.operationId, JSON.stringify(intent), Date.now()]);
}
async function relatedRows(query, interaction, messageId) {
    const keys = await query('SELECT gallery_id FROM bot_media_galleries FORCE INDEX (idx_media_galleries_locator) WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>?',
        [interaction.guildId, interaction.channelId, messageId, 'twitter', Date.now()]);
    if (keys.length > 25) throw new Error('GRID_LOCK_UNAVAILABLE');
    const rows = [];
    // Avoid locking a broad secondary-index range. Distinct posts must not
    // deadlock merely because their gallery rows share a guild or channel.
    for (const key of keys.map(item => item.gallery_id).sort()) {
        const found = await query('SELECT gallery_id,message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? FOR UPDATE',
            [key, interaction.guildId, interaction.channelId]);
        if (!found[0] || found[0].provider_id !== 'twitter' || String(found[0].message_id) !== String(messageId)) throw new Error('GRID_LOCK_UNAVAILABLE');
        rows.push(found[0]);
    }
    return rows;
}
async function updateInlineSiblings(query, interaction, payload, latest, oldEnd, previousSignature, previousStatic) {
    if (!payload.sharedInline) return;
    if (!Number.isInteger(oldEnd) || !Number.isInteger(payload.embedEnd)) throw new Error('GRID_SOURCE_CHANGED');
    const siblings = await relatedRows(query, interaction, payload.messageIds[0]);
    for (const sibling of siblings) {
        let data; try { data = JSON.parse(sibling.payload_json); } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
        if (data.lockId !== payload.lockId || data.id === payload.id) continue;
        const siblingMarker = items(latest).some(file => new RegExp(`^tg-${data.id}\\.(jpg|png|webp)$`).test(file.name || ''));
        if (!Number.isInteger(data.embedStart) || data.embedStart < oldEnd || !Number.isInteger(data.embedEnd)
            || data.partSignatures?.[0] !== previousSignature && !(siblingMarker && data.firstStaticSignature === previousStatic))
            throw new Error('GRID_SOURCE_CHANGED');
        data.embedStart += payload.embedEnd - oldEnd; data.embedEnd += payload.embedEnd - oldEnd;
        data.partSignatures[0] = payload.partSignatures[0]; data.firstStaticSignature = payload.firstStaticSignature;
        const changed = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=?',
            [JSON.stringify(data), data.id, payload.messageIds[0]]);
        if (Number(changed?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    }
    if (payload.embedWitness?.hashes && payload.embedStart >= 0 && payload.embedEnd <= latest.embeds.length)
        payload.embedWitness.hashes = latest.embeds.slice(payload.embedStart, payload.embedEnd).map(embed => cards.embedFingerprint(embed, latest));
}
async function recover({ interaction, payload, query, db }) {
    if (typeof db.queryDatabaseIndependent !== 'function') throw new Error('GRID_LOCK_UNAVAILABLE');
    // The transaction may have taken a snapshot before waiting on the gallery
    // lock. Read the committed journal on an independent connection instead.
    const rows = await db.queryDatabaseIndependent('SELECT operation_id,payload_json,guild_id,channel_id,message_id FROM bot_twitter_grid_action_intents WHERE gallery_id=? LIMIT 1',
        [payload.lockId]);
    if (!rows[0]) return null;
    const row = rows[0];
    let intent; try { intent = JSON.parse(row.payload_json); } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
    if (intent?.version !== 1 || (intent.kind && intent.kind !== 'twitter-grid-legacy') || intent.lockId !== payload.lockId || intent.galleryId !== payload.id || intent.operationId !== row.operation_id
        || row.guild_id !== interaction.guildId || row.channel_id !== interaction.channelId || String(row.message_id) !== payload.messageIds?.[0]
        || !Array.isArray(intent.steps) || intent.steps.length > 20) throw new Error('GRID_LOCK_UNAVAILABLE');
    const channel = interaction.channel;
    for (const step of intent.steps) {
        if (!Number.isInteger(step.index) || step.index < 0 || step.index >= payload.messageIds.length
            || step.id !== payload.messageIds[step.index] || !/^[a-f0-9]{64}$/.test(step.before || '')) throw new Error('GRID_LOCK_UNAVAILABLE');
        let latest;
        try { latest = await channel.messages.fetch({ message: step.id, force: true }); }
        catch (error) {
            if (step.type === 'delete' && step.index > 0 && Number(error?.code) === 10008) {
                payload.legacyDeletedParts = [...new Set([...(payload.legacyDeletedParts || []), step.id])]; continue;
            }
            throw new Error('GRID_LOCK_UNAVAILABLE');
        }
        if (!own(latest, interaction, step.id)) throw new Error('GRID_SOURCE_CHANGED');
        if (step.type !== 'edit' || !/^[a-f0-9]{64}$/.test(step.expected || '') || messageDigest(latest, step.namesOnly === true, interaction.channelId) !== step.expected
            || step.retainedIds?.some(id => !items(latest).some(file => String(file.id) === id)))
            throw new Error('GRID_LOCK_UNAVAILABLE');
        const oldSignature = payload.partSignatures[step.index], newSignature = cards.fingerprint(latest);
        if (oldSignature !== step.before && oldSignature !== newSignature) throw new Error('GRID_SOURCE_CHANGED');
        const combined = step.index === 0 && payload.replacePhase === 'done'
            && items(latest).some(file => new RegExp(`^tg-${payload.id}\\.(jpg|png|webp)$`).test(file.name || ''));
        // A confirmed edit can change the number of parent Embeds before its
        // DB transaction commits. The journal's verified suffix count gives
        // the new target range without treating a quoted image as the parent.
        const evidencePayload = step.index === 0 && payload.sharedInline && Number.isInteger(step.suffixCount)
            ? { ...payload, embedEnd: latest.embeds.length - step.suffixCount } : payload;
        if (!hiddenImageEvidence(latest, evidencePayload, step.index, combined)) throw new Error('GRID_SOURCE_CHANGED');
        payload.partSignatures[step.index] = newSignature;
        if (step.index === 0) {
            payload.firstStaticSignature = cards.fingerprint(latest, true);
            if (payload.sharedInline && oldSignature !== newSignature) {
                if (!Number.isInteger(step.oldEnd) || !Number.isInteger(step.suffixCount)) throw new Error('GRID_LOCK_UNAVAILABLE');
                const newEnd = latest.embeds.length - step.suffixCount;
                payload.embedEnd = newEnd;
                await updateInlineSiblings(query, interaction, payload, latest, step.oldEnd, oldSignature, step.beforeStatic);
                if (step.namesOnly === true) {
                    if (!Array.isArray(step.newNames) || !step.newNames.length || step.newNames.length > 10
                        || new Set(step.newNames).size !== step.newNames.length
                        || step.newNames.some(name => !/^tgop-[a-f0-9]{32}-\d+\.(jpg|png|webp|avif)$/.test(name))) throw new Error('GRID_LOCK_UNAVAILABLE');
                    const uploaded = step.newNames.map(name => items(latest).filter(file => file.name === name));
                    if (uploaded.some(matches => matches.length !== 1)) throw new Error('GRID_LOCK_UNAVAILABLE');
                    if (payload.embedWitness) payload.embedWitness.attachments = uploaded.map(matches => ({ id: String(matches[0].id), name: matches[0].name }));
                }
            }
        }
    }
    await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=?',
        [JSON.stringify(payload), payload.id, payload.messageIds[0]]);
    return intent;
}
async function run({ interaction, current, payload, query, work, options, db, recovered }) {
    const action = options.action, channel = interaction.channel, rootId = String(current.id);
    const originalRootSignature = cards.fingerprint(current);
    const now = options.operationNow || Date.now;
    const startedAt = now(), createdAt = Number(interaction.createdTimestamp);
    const interactionDeadline = Number.isFinite(createdAt) && createdAt > 0 ? createdAt + 14 * 60 * 1000 : Infinity;
    const deadline = Math.min(startedAt + 12 * 60 * 1000, interactionDeadline);
    const checkDeadline = () => {
        if (now() >= deadline) throw Object.assign(new Error('GRID_OPERATION_TIME'), { safeClear: true });
    };
    // Do not guess at any unrelated inline quotation or partially delivered
    // group. A combined public result is handled only by its own grid flow.
    const ids = payload.messageIds, signatures = payload.partSignatures;
    if (!Array.isArray(ids) || !Array.isArray(signatures) || ids.length !== payload.completedParts || signatures.length !== ids.length
        || ids[0] !== rootId || new Set(ids).size !== ids.length || payload.partsState && payload.partsState !== 'complete'
        || payload.completedParts !== payload.totalParts) return { error: new Error('GRID_SOURCE_INCOMPLETE') };
    if (!own(current, interaction, ids[0])) return { error: new Error('GRID_SOURCE_CHANGED') };
    const persist = async () => {
        const result = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=?',
            [JSON.stringify(payload), payload.id, rootId]);
        if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
    };
    // A prior owner's post-commit cleanup must not delete this operation.
    const intent = recovered ? { ...recovered, operationId: randomBytes(16).toString('hex'), resumedBy: String(interaction.user.id) } : {
        version: 1, kind: 'twitter-grid-legacy', operationId: randomBytes(16).toString('hex'), galleryId: payload.id, actorId: String(interaction.user.id),
        createdAtMs: Date.now(), lockId: payload.lockId, action, steps: [] };
    if (recovered) await saveIntent(db, interaction, payload, intent);
    const plan = async step => { intent.steps.push(step); await saveIntent(db, interaction, payload, intent); };
    const authorize = async root => {
        const grid = require('./components/twitterGrid')._internal;
        const access = await (options.freshAccess || grid.freshAccess)(interaction);
        const settings = await (options.getSettings || require('./providers/_provider_settings').getFreshProviderSettings)(twitterProvider, interaction.guildId);
        const requester = /^\d{16,22}$/.test(String(payload.requesterId || '')) ? String(payload.requesterId) : null;
        const safeChannel = access?.channel?.nsfw === true || access?.parent?.nsfw === true;
        if (!access || !settings || !grid.currentButtonAccess(interaction, settings, access.member)
            || action !== 'delete' && (settings.enabled !== true || !cards.matchesSafetyPolicy(settings, payload) || payload.nsfw && !safeChannel)
            || action === 'delete' && requester !== interaction.user.id && !access.permissions?.has?.('ManageMessages'))
            throw new Error('GRID_PERMISSION_CHANGED');
    };
    const deleted = new Set(Array.isArray(payload.legacyDeletedParts) ? payload.legacyDeletedParts : []);
    const combined = items(current).some(file => new RegExp(`^tg-${payload.id}\\.(jpg|png|webp)$`).test(file.name || ''))
        && cards.matchesFingerprint(current, payload.firstStaticSignature, true);
    if (!combined && !cards.matchesFingerprint(current, signatures[0])) return { error: new Error('GRID_SOURCE_CHANGED') };
    if (combined && payload.replacePhase !== 'done') return { error: new Error('GRID_SOURCE_INCOMPLETE') };
    if (combined && !payload.sharedInline) {
        const files = items(current);
        if (files.length !== 1 || !new RegExp(`^tg-${payload.id}\\.(jpg|png|webp)$`).test(files[0].name || ''))
            return { error: new Error('GRID_SOURCE_CHANGED') };
        const imageUrls = (current.embeds || []).map(embed => cards.cleanEmbed(embed).image?.url).filter(Boolean);
        if (imageUrls.length > 1 || imageUrls.some(url => !matchesUniqueReference(url, files[0], files, interaction.channelId)))
            return { error: new Error('GRID_SOURCE_CHANGED') };
    }
    const messages = [current];
    for (let i = 1; i < ids.length; i++) {
        checkDeadline();
        let item;
        try { item = await channel.messages.fetch({ message: ids[i], force: true }); }
        catch (error) {
            if (Number(error?.code) === 10008 && (combined || action === 'delete' && deleted.has(ids[i]))) { messages.push(null); continue; }
            return { error: new Error('GRID_SOURCE_CHANGED') };
        }
        if (!own(item, interaction, ids[i]) || !cards.matchesFingerprint(item, signatures[i])) return { error: new Error('GRID_SOURCE_CHANGED') };
        messages.push(item);
    }
    // Inferring hidden files is permitted only after every observed message
    // has passed its saved signature, author, scope and ordered source proof.
    // Existing video/audio attachments remain visible and are retained.
    try {
        for (let index = 0; index < messages.length; index++) {
            if (messages[index] && !hiddenImageEvidence(messages[index], payload, index, combined))
                return { error: new Error('GRID_SOURCE_CHANGED') };
        }
    } catch { return { error: new Error('GRID_SOURCE_CHANGED') }; }
    if (['showMediaAsAttachments', 'showAttachmentsAsEmbedsImage'].includes(action)) {
        // Spoiler-bearing physical groups deliberately have no photo
        // references in their manifest. Never reveal their attachments or
        // claim a display conversion that did not change any photographs.
        const unavailable = messages.some(message => message && items(message).some(isSpoiler))
            ? 'GRID_SPOILER_DISPLAY_UNAVAILABLE'
            : !Array.isArray(payload.partSizes) || !payload.partSizes.some(count => Number.isInteger(count) && count > 0)
                ? 'GRID_NO_DISPLAYABLE_IMAGES' : null;
        if (unavailable) {
            try { await authorize(current); }
            catch (error) { return { error, intent: recovered ? intent : null, safeClear: !!recovered }; }
            return { error: new Error(unavailable), intent: recovered ? intent : null, safeClear: !!recovered };
        }
        // This operation will make attachments hidden by Embeds. Do not
        // create a state that the saved manifest cannot later authenticate.
        if (action === 'showAttachmentsAsEmbedsImage' && messages.some((message, index) =>
            message && payload.partSizes?.[index] > 0 && !approvedPhotoPart(payload, index)))
            return { error: new Error('GRID_SOURCE_CHANGED') };
    }
    if (action === 'delete') {
        const deleteMessage = async () => {
            for (let i = 1; i < messages.length; i++) {
                checkDeadline();
                const item = messages[i];
                if (!item) continue;
                let root = await channel.messages.fetch({ message: rootId, force: true });
                if (!own(root, interaction, rootId) || cards.fingerprint(root) !== originalRootSignature) throw new Error('GRID_SOURCE_CHANGED');
                await authorize(root);
                const latest = await channel.messages.fetch({ message: ids[i], force: true });
                if (!own(latest, interaction, ids[i]) || !cards.matchesFingerprint(latest, signatures[i])) throw new Error('GRID_SOURCE_CHANGED');
                await plan({ type: 'delete', index: i, id: ids[i], before: signatures[i] });
                root = await channel.messages.fetch({ message: rootId, force: true });
                const guarded = await channel.messages.fetch({ message: ids[i], force: true });
                if (!own(root, interaction, rootId) || cards.fingerprint(root) !== originalRootSignature
                    || !own(guarded, interaction, ids[i]) || !cards.matchesFingerprint(guarded, signatures[i]))
                    throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
                try { await authorize(root); } catch (error) { error.safeClear = true; throw error; }
                checkDeadline();
                const finalRoot = await channel.messages.fetch({ message: rootId, force: true });
                const finalPart = await channel.messages.fetch({ message: ids[i], force: true });
                if (!own(finalRoot, interaction, rootId) || cards.fingerprint(finalRoot) !== originalRootSignature
                    || !own(finalPart, interaction, ids[i]) || !cards.matchesFingerprint(finalPart, signatures[i]))
                    throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
                try { await finalPart.delete(); }
                catch (error) {
                    // An uncertain acknowledgement is never repeated until a
                    // fresh GET proves that this exact message disappeared.
                    try { await channel.messages.fetch({ message: ids[i], force: true }); throw error; }
                    catch (check) { if (Number(check?.code) !== 10008) throw error; }
                }
                deleted.add(ids[i]); payload.legacyDeletedParts = [...deleted]; await persist();
            }
            checkDeadline();
            // Preserve the verified stored representation for old v1 rows so
            // post-crash cleanup can still match the journal to that row.
            await plan({ type: 'delete', index: 0, id: ids[0], before: combined ? cards.fingerprint(current) : signatures[0] });
            const root = await channel.messages.fetch({ message: rootId, force: true });
            if (!own(root, interaction, rootId) || cards.fingerprint(root) !== originalRootSignature)
                throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
            try { await authorize(root); } catch (error) { error.safeClear = true; throw error; }
            checkDeadline();
            const finalRoot = await channel.messages.fetch({ message: rootId, force: true });
            if (!own(finalRoot, interaction, rootId) || cards.fingerprint(finalRoot) !== originalRootSignature)
                throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
            await finalRoot.delete();
            // A confirmed deletion no longer needs a lifetime locator. Keep
            // the records for a short audit/recovery window before the
            // existing gallery cleanup can remove them.
            const related = new Set([payload.id]);
            for (const row of current.components || []) for (const component of row.components || []) {
                const value = component.customId || component.custom_id || component.data?.custom_id;
                const match = /^tg:([a-f0-9]{32}):0:open$/.exec(value || '');
                if (match) related.add(match[1]);
            }
            for (const id of [...related].sort()) {
                const rows = await query('SELECT message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? FOR UPDATE',
                    [id, interaction.guildId, interaction.channelId]);
                if (!rows[0] || rows[0].provider_id !== 'twitter' || String(rows[0].message_id) !== rootId) continue;
                let relatedPayload; try { relatedPayload = JSON.parse(rows[0].payload_json); } catch { continue; }
                if (relatedPayload.lockId !== payload.lockId) continue;
                await query('UPDATE bot_media_galleries SET expires_at_ms=? WHERE gallery_id=?',
                    [Date.now() + 30 * 24 * 60 * 60 * 1000, id]);
            }
        };
        try { return { value: await work({ deleteMessage, verifiedRequesterId: /^\d{16,22}$/.test(String(payload.requesterId || '')) ? String(payload.requesterId) : null }), intent }; }
        catch (error) { return { error, intent, safeClear: error?.safeClear === true || definitelyRejected(error) }; }
    }
    if (deleted.size) return { error: new Error('GRID_SOURCE_CHANGED') };
    const foreignMarkers = items(current).some(file => /^tg-[a-f0-9]{32}\.(jpg|png|webp)$/.test(file.name || '')
        && !new RegExp(`^tg-${payload.id}\\.`).test(file.name));
    if (foreignMarkers && !await require('./components/twitterGrid')._internal.markerRows(query, interaction, payload, current))
        return { error: new Error('GRID_SOURCE_CHANGED') };
    if (action === 'translate') {
        try {
            const before = translationWitness(current);
            const beforeTranslateEdit = async change => {
                checkDeadline();
                if (change.files?.length) throw new Error('GRID_SOURCE_CHANGED');
                await authorize(current);
                await plan({ type: 'edit', index: 0, id: rootId, before: signatures[0],
                    expected: editDigest({ ...change, content: current.content || '' }, items(current), false, interaction.channelId),
                    oldEnd: payload.embedEnd, beforeStatic: payload.firstStaticSignature,
                    suffixCount: payload.sharedInline ? current.embeds.length - payload.embedEnd : 0 });
                try { await authorize(current); } catch (error) { error.safeClear = true; throw error; }
                checkDeadline();
                const guarded = await channel.messages.fetch({ message: rootId, force: true });
                if (!own(guarded, interaction, rootId) || cards.fingerprint(guarded) !== originalRootSignature)
                    throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
                interaction.message = guarded;
            };
            const value = await work({ beforeTranslateEdit });
            const latest = await channel.messages.fetch({ message: rootId, force: true });
            if (!own(latest, interaction, rootId) || translationWitness(latest) !== before) throw new Error('GRID_SOURCE_CHANGED');
            if (cards.fingerprint(latest) !== signatures[0]) {
                const previousSignature = signatures[0], oldEnd = payload.embedEnd, previousStatic = payload.firstStaticSignature;
                payload.partSignatures[0] = cards.fingerprint(latest);
                payload.firstStaticSignature = cards.fingerprint(latest, true);
                await updateInlineSiblings(query, interaction, payload, latest, oldEnd, previousSignature, previousStatic);
                await persist();
            }
            return { value, intent: intent.steps.length ? intent : null };
        } catch (error) { return { error, intent, safeClear: error?.safeClear === true || definitelyRejected(error) }; }
    }
    // Existing X posts with up to ten photos often have image-only embeds and
    // no image attachments. Keep the old control usable without dropping its
    // grid button, and journal the generated attachment names before upload.
    if (action === 'showMediaAsAttachments' && ids.length === 1
        && !items(current).some(file => String(file.contentType || '').startsWith('image/')
            && !/^tg-[a-f0-9]{32}\.(jpg|png|webp)$/.test(file.name || ''))) {
        if (activeSourceUploads >= MAX_SOURCE_UPLOADS) return { error: new Error('GRID_LOCK_UNAVAILABLE') };
        activeSourceUploads++;
        try {
            const currentEmbeds = (current.embeds || []).map(cards.cleanEmbed);
            const shared = payload.sharedInline === true || Number.isInteger(payload.embedEnd) && payload.embedEnd >= 1 && payload.embedEnd < currentEmbeds.length;
            const oldEnd = shared ? payload.embedEnd : currentEmbeds.length;
            if (shared && (payload.isPrimary === false || payload.embedStart !== 0 || !Number.isInteger(oldEnd)
                || oldEnd < 1 || oldEnd > currentEmbeds.length)) throw new Error('GRID_SOURCE_CHANGED');
            const suffix = currentEmbeds.slice(oldEnd);
            const images = currentEmbeds.slice(0, oldEnd).map(embed => embed.image?.url).filter(Boolean);
            const urls = payload.partRefs?.[0] ? cards.resolveReferences(payload.partRefs[0], current) : payload.imageUrls;
            if (!Array.isArray(urls) || !urls.length || urls.length + items(current).length > 10
                || images.length !== urls.length || JSON.stringify([...images].sort()) !== JSON.stringify([...urls].sort())
                || new Set(urls).size !== urls.length
                || items(current).some(file => !/^(video|audio)\//.test(String(file.contentType || ''))
                    && !/^tg-[a-f0-9]{32}\.(jpg|png|webp)$/.test(file.name || ''))) throw new Error('GRID_SOURCE_CHANGED');
            const fetchMedia = options.fetchTwitterMedia || require('./providers/twitter/safeMedia').fetchTwitterMedia;
            const files = []; let bytes = 0;
            for (const [index, url] of urls.entries()) {
                checkDeadline();
                // Never let discord.js resolve an arbitrary network URL. This
                // path uses the same pinned, size-limited downloader as the
                // normal X attachment sender.
                const remaining = MAX_SOURCE_BYTES - bytes;
                if (remaining <= 0) throw new Error('GRID_SOURCE_CHANGED');
                const fetched = await fetchMedia(url, { kind: 'photo', maxBytes: Math.min(20 * 1024 * 1024, remaining) });
                if (!Buffer.isBuffer(fetched.data) || !fetched.data.length || fetched.data.length > Math.min(20 * 1024 * 1024, remaining)
                    || !['jpeg', 'png', 'webp', 'avif'].includes(fetched.format)) throw new Error('GRID_SOURCE_CHANGED');
                bytes += fetched.data.length;
                const format = fetched.format === 'jpeg' ? 'jpg' : fetched.format;
                files.push({ attachment: fetched.data, name: `tgop-${intent.operationId}-${index}.${format}` });
            }
            const parentEmbeds = currentEmbeds.slice(0, oldEnd).map(embed => { if (urls.includes(embed.image?.url)) delete embed.image; return embed; })
                .filter(embed => Object.keys(embed).some(key => !['url', 'color'].includes(key)));
            if (!parentEmbeds.length) throw new Error('GRID_SOURCE_CHANGED');
            const embeds = [...parentEmbeds, ...suffix];
            const retained = items(current).map(file => ({ id: String(file.id), name: file.name, url: file.url }));
            const edit = { content: current.content || '', embeds, components: switchRows(current, options, action),
                attachments: retained.map(file => ({ id: file.id })), files, allowedMentions: { parse: [] } };
            const expected = [...retained, ...files.map(file => ({ id: '', name: file.name }))];
            await authorize(current);
            await plan({ type: 'edit', index: 0, id: rootId, before: signatures[0], expected: editDigest(edit, expected, true, interaction.channelId),
                namesOnly: true, retainedIds: retained.map(file => file.id), newNames: files.map(file => file.name),
                oldEnd, suffixCount: suffix.length, beforeStatic: payload.firstStaticSignature });
            try { await authorize(current); } catch (error) { error.safeClear = true; throw error; }
            checkDeadline();
            const guarded = await channel.messages.fetch({ message: rootId, force: true });
            if (!own(guarded, interaction, rootId) || cards.fingerprint(guarded) !== originalRootSignature)
                throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
            let failure; try { await guarded.edit(edit); } catch (error) { failure = error; }
            const latest = await channel.messages.fetch({ message: rootId, force: true });
            if (!own(latest, interaction, rootId) || messageDigest(latest, true, interaction.channelId) !== editDigest(edit, expected, true, interaction.channelId)
                || retained.some(file => !items(latest).some(item => String(item.id) === file.id))) throw failure || new Error('GRID_SOURCE_CHANGED');
            const previousSignature = payload.partSignatures[0], previousStatic = payload.firstStaticSignature;
            payload.partSignatures[0] = cards.fingerprint(latest);
            payload.firstStaticSignature = cards.fingerprint(latest, true);
            if (shared) {
                payload.sharedInline = true; payload.embedEnd = parentEmbeds.length;
                await updateInlineSiblings(query, interaction, payload, latest, oldEnd, previousSignature, previousStatic);
                const uploaded = files.map(file => items(latest).filter(item => item.name === file.name));
                if (uploaded.some(matches => matches.length !== 1)) throw new Error('GRID_SOURCE_CHANGED');
                if (payload.embedWitness) payload.embedWitness.attachments = uploaded.map(matches => ({ id: String(matches[0].id), name: matches[0].name }));
            }
            await persist();
            await interaction.editReply({ content: require('./locales').t('finishActionLocales', interaction.locale), ephemeral: true });
            return { intent };
        } catch (error) { return { error, intent, safeClear: error?.safeClear === true || definitelyRejected(error) }; }
        finally { activeSourceUploads--; }
    }
    let base, suffix = [], siblingRows = [];
    try {
        if (!current.embeds?.length) throw new Error('GRID_SOURCE_CHANGED');
        base = cards.cleanEmbed(current.embeds[0]); delete base.image;
        // Older summary-mode posts did not set sharedInline even though the
        // recorded parent range excludes a later quote summary. Their signed
        // extra embeds remain part of the same message and must be preserved.
        if (!payload.sharedInline && Number.isInteger(payload.embedEnd) && payload.embedEnd >= 1
            && payload.embedEnd < current.embeds.length) payload.sharedInline = true;
        if (payload.sharedInline) {
            if (!payload.isPrimary || payload.embedStart !== 0 || !Number.isInteger(payload.embedEnd)
                || payload.embedEnd < 1 || payload.embedEnd > current.embeds.length) throw new Error('GRID_SOURCE_CHANGED');
            suffix = current.embeds.slice(payload.embedEnd).map(cards.cleanEmbed);
            const rows = await relatedRows(query, interaction, rootId);
            siblingRows = rows.map(row => ({ row, data: JSON.parse(row.payload_json) })).filter(item => item.data.lockId === payload.lockId && item.data.id !== payload.id);
            if (siblingRows.some(({ data }) => data.kind !== 'twitter-image-grid-v1'
                || data.partSignatures?.[0] !== signatures[0] && !(items(current).some(file => new RegExp(`^tg-${data.id}\\.(jpg|png|webp)$`).test(file.name || ''))
                    && data.firstStaticSignature === payload.firstStaticSignature)
                || !Number.isInteger(data.embedStart) || !Number.isInteger(data.embedEnd) || data.embedStart < payload.embedEnd)) throw new Error('GRID_SOURCE_CHANGED');
        }
        for (let i = 0; i < messages.length; i++) {
            if (!messages[i] && combined) continue;
            if (payload.partSizes?.[i] === 0 && payload.partContainsNonImage?.[i] === true) continue;
            const embeds = messages[i].embeds || [];
            const targetEnd = i === 0 && payload.sharedInline ? payload.embedEnd : embeds.length;
            for (let j = 0; j < embeds.length; j++) {
                const raw = buttonData(embeds[j]), clean = cards.cleanEmbed(embeds[j]);
                // Rich video/audio embeds cannot be reconstructed by editing
                // only their image URLs. Keep the whole post untouched.
                if (raw.video || raw.audio) throw new Error('GRID_SOURCE_CHANGED');
                if (j < targetEnd && (i > 0 || j > 0)
                    && Object.keys(clean).some(key => !['url', 'color', 'image'].includes(key))) throw new Error('GRID_SOURCE_CHANGED');
            }
            if (currentAttachments(messages[i], payload).length !== (combined && i === 0 ? 1 : payload.partSizes?.[i])) throw new Error('GRID_SOURCE_CHANGED');
            if (i && (messages[i].content || (messages[i].components || []).length)) throw new Error('GRID_SOURCE_CHANGED');
        }
    } catch (error) { return { error, intent, safeClear: definitelyRejected(error) }; }
    // Work from the tail so the original control remains available on failure.
    try {
        const initialRootSignature = originalRootSignature;
        for (let i = messages.length - 1; i >= 0; i--) {
            checkDeadline();
            if (!messages[i]) continue;
            const nonImageOnly = payload.partSizes?.[i] === 0 && payload.partContainsNonImage?.[i] === true;
            if (nonImageOnly && i > 0) continue;
            const root = await channel.messages.fetch({ message: rootId, force: true });
            if (!own(root, interaction, rootId) || cards.fingerprint(root) !== initialRootSignature) throw new Error('GRID_SOURCE_CHANGED');
            const old = i === 0 ? root : await channel.messages.fetch({ message: ids[i], force: true });
            if (!own(old, interaction, ids[i]) || i > 0 && !cards.matchesFingerprint(old, signatures[i])) throw new Error('GRID_SOURCE_CHANGED');
            const edit = nonImageOnly
                ? { content: old.content || '', embeds: (old.embeds || []).map(cards.cleanEmbed),
                    attachments: items(old).map(file => ({ id: String(file.id) })), components: switchRows(old, options, action),
                    allowedMentions: { parse: [] } }
                : makeEdit(old, base, action, i === 0, options, suffix, payload);
            // MessageManager.fetch may patch the same instance returned here.
            // Freeze the before-state before any edit, not after the fetch.
            const before = { content: old.content || '', attachments: items(old).map(file => ({ id: file.id, name: file.name })) };
            if (matchesEdit(old, edit, before.attachments, interaction.channelId)) continue;
            await authorize(root);
            await plan({ type: 'edit', index: i, id: ids[i], before: signatures[i], expected: editDigest(edit, items(old), false, interaction.channelId),
                oldEnd: payload.embedEnd, beforeStatic: payload.firstStaticSignature, suffixCount: suffix.length });
            // Journal I/O is another interleaving point. Check again after it
            // commits and immediately before the irreversible Discord edit.
            try { await authorize(root); } catch (error) { error.safeClear = true; throw error; }
            checkDeadline();
            const guardedRoot = await channel.messages.fetch({ message: rootId, force: true });
            const guarded = i === 0 ? guardedRoot : await channel.messages.fetch({ message: ids[i], force: true });
            if (!own(guardedRoot, interaction, rootId) || cards.fingerprint(guardedRoot) !== initialRootSignature
                || !own(guarded, interaction, ids[i]) || i > 0 && !cards.matchesFingerprint(guarded, signatures[i]))
                throw Object.assign(new Error('GRID_SOURCE_CHANGED'), { safeClear: true });
            let failure;
            try { await guarded.edit(edit); } catch (error) { failure = error; }
            const latest = await channel.messages.fetch({ message: ids[i], force: true });
            if (!own(latest, interaction, ids[i]) || !sameAttachments(before, latest) || before.content !== (latest.content || '')
                || !matchesEdit(latest, edit, before.attachments, interaction.channelId))
                throw failure || new Error('GRID_SOURCE_CHANGED');
            if (!own(latest, interaction, ids[i]))
                throw new Error('GRID_SOURCE_CHANGED');
            const previousSignature = payload.partSignatures[i];
            const previousStatic = payload.firstStaticSignature;
            payload.partSignatures[i] = cards.fingerprint(latest);
            if (!i) {
                payload.firstStaticSignature = cards.fingerprint(latest, true);
                if (payload.sharedInline) {
                    const previousEnd = payload.embedEnd, newEnd = latest.embeds.length - suffix.length;
                    payload.embedEnd = newEnd;
                    await updateInlineSiblings(query, interaction, payload, latest, previousEnd, previousSignature, previousStatic);
                }
            }
            await persist();
        }
        const { t } = require('./locales');
        const hasUnembedded = action === 'showAttachmentsAsEmbedsImage' && suffix.length > 0
            && currentAttachments(messages[0], payload).length > Math.max(1, 10 - suffix.length);
        const notice = String(interaction.locale || '').startsWith('ja')
            ? '引用も表示するため、一部の画像は添付ファイルで表示しています。'
            : 'Some images remain attachments so the quoted post can also be displayed.';
        await interaction.editReply({ content: hasUnembedded ? notice : t('finishActionLocales', interaction.locale), ephemeral: true });
        return { value: undefined, intent };
    } catch (error) { return { error, intent, safeClear: error?.safeClear === true || definitelyRejected(error) }; }
}
module.exports = { run, recover, matchesEdit, _internal: { approvedPhotoPart, currentAttachments, hiddenImageEvidence, makeEdit, relatedRows } };
