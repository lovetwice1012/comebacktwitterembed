'use strict';

// Adapters for verified public restoration, including shared inline quotes.
// Discord writes are fenced by the shared gallery lock and durable journal.
const cards = require('./twitterGridCards');
const { matchesUniqueReference } = require('./discordAttachmentIdentity');
const restore = require('./twitterGridRestore');
const { createRestoreJournal } = require('./twitterGridRestoreJournal');
const gallery = require('./mediaGallery');
const { getFreshProviderSettings } = require('./providers/_provider_settings');
const twitterProvider = require('./providers/twitter');

function createAdapters(interaction, galleryId, deps = {}) {
    const database = deps.db || require('./db'), grid = deps.grid || require('./components/twitterGrid')._internal;
    const getSettings = deps.getSettings || getFreshProviderSettings;
    const getAccess = deps.getAccess || grid.freshAccess;
    const storage = deps.storage || gallery.store();
    const state = { lock: null, snapshot: null, operation: null, journal: null, messages: [], firstSignature: null, afterSignature: null, retainedIds: [] };
    async function policy(snapshot) {
        const settings = await getSettings(twitterProvider, interaction.guildId), access = await getAccess(interaction);
        if (!access || settings.enabled !== true || cards.safetyHash(settings) !== snapshot.payload.settingsHash
            || snapshot.payload.nsfw && !(access.channel?.nsfw === true || access.parent?.nsfw === true)
            || !grid.currentButtonAccess(interaction, settings, access.member)
            || !grid.mayReplace(interaction, snapshot.payload, settings, access.permissions || access, access.guild?.ownerId)) return false;
        state.access = access; return true;
    }
    async function authorization(snapshot) {
        if (!await policy(snapshot)) return false;
        const access = state.access;
        let first;
        try { first = await (access.channel || interaction.channel).messages.fetch({ message: snapshot.first.id, force: true }); }
        catch { return false; }
        if (first?.author?.id !== interaction.client?.user?.id || cards.fingerprint(first) !== (state.afterSignature || state.firstSignature)) return false;
        state.current = first; state.access = access;
        return true;
    }
    async function recover(lock) {
        if (!lock.journal || lock.journal.payload?.kind !== 'twitter-grid-restore') return { status: 'blocked' };
        if (!await policy({ payload: lock.payload, first: { id: lock.scope.messageId } })) return { status: 'denied' };
        const completed = await require('./twitterGridRestoreRecovery').recoverConfirmed(lock, interaction, {
            channel: state.access.channel || interaction.channel,
            authorize: () => policy({ payload: lock.payload, first: { id: lock.scope.messageId } }),
            fetchVerifiedSource: (source, payload, options) => restore.fetchVerifiedSource(source, payload, { ...deps.sourceDependencies, ...options }),
            ...deps.recoveryDependencies,
        });
        return completed ? { status: 'recovered', recovery: completed } : { status: 'blocked' };
    }
    async function lockedScope(work) {
        const prior = await storage.get(galleryId, interaction.guildId, interaction.channelId);
        if (!prior || prior.provider_id !== 'twitter' || !prior.message_id) return { status: 'unavailable' };
        const result = await cards.withGalleryLock({ galleryId, guildId: interaction.guildId, channelId: interaction.channelId,
            messageId: String(prior.message_id) }, work, database);
        if (result?.status === 'recovered') await result.recovery.journal.clearAfterCommit(result.recovery.operation);
        return result;
    }
    const adapters = {
        recoverOnly: () => restore.withRestorationSlot(() => lockedScope(recover)),
        async withLock(request, work) {
            let result;
            result = await lockedScope(async lock => {
                if (lock.journal) return recover(lock);
                if (request.mode !== 'resume' && lock.payload.replacePhase !== 'done') return { status: 'unavailable' };
                const channel = interaction.channel;
                let first; try { first = await channel.messages.fetch({ message: lock.scope.messageId, force: true }); } catch { return { status: 'unavailable' }; }
                if (first?.author?.id !== interaction.client?.user?.id) return { status: 'denied' };
                const row = { ...lock.row, payload: lock.payload };
                if (!await grid.sourcesRemainValid(interaction, row, { channel })) return { status: 'unavailable' };
                if (request.mode === 'resume' && !restore.statusFromPartial(lock.payload, first)) return { status: 'unavailable' };
                state.lock = lock; state.firstSignature = cards.fingerprint(first); state.snapshot = { payload: lock.payload, first };
                if (lock.payload.sharedInline) {
                    const inline = require('./twitterGridRestoreInline');
                    const inspect = request.mode === 'resume' ? inline.inspectPartial : inline.inspect;
                    try { state.inline = await inspect({ query: lock.query, readRows: database.queryDatabaseIndependent,
                        interaction, payload: lock.payload, message: first, authorize: () => authorization(state.snapshot) }); }
                    catch { return { status: 'unavailable' }; }
                }
                state.journal = createRestoreJournal(database, { ...lock.scope, lockId: lock.lockId });
                return work(state.snapshot);
            });
            if (result?.status === 'done' && state.operation) await state.journal.clearAfterCommit(state.operation);
            return result;
        },
        authorize: async (_request, snapshot) => authorization(snapshot),
        latestMessageId: async () => restore.latestMessageId(state.access?.channel || interaction.channel),
        adjacency: async (_snapshot, firstId, secondId) => restore.adjacency(state.access?.channel || interaction.channel, firstId, secondId),
        fileLimit: async () => Number.isSafeInteger(interaction.attachmentSizeLimit) && interaction.attachmentSizeLimit > 0
            ? Math.min(interaction.attachmentSizeLimit, require('./providers/twitter/safeMedia').MAX_MEDIA_BYTES) : null,
        verifyLiveSource: (source, payload, deadlineAtMs) => restore.fetchVerifiedSource(source, payload, { ...deps.sourceDependencies, deadlineAtMs }),
        measureImages: (urls, limits) => restore.measureRestoreImages(urls, limits, deps.mediaDependencies),
        prepareImages: (urls, limits) => restore.prepareRestoredImages(urls, limits, deps.mediaDependencies),
        rootCapacity: async (_request, snapshot) => {
            if (!snapshot.payload.sharedInline) return 10;
            const capacity = require('./twitterGridRestoreInline').capacity(state.inline, Math.min(10, snapshot.payload.imageUrls.length));
            return Math.max(capacity.inlineUploadMax, capacity.inlineReferenceMax);
        },
        async preflight(request, snapshot, plan) {
            const all = cards.attachmentList(state.current), marker = new RegExp(`^tg-${snapshot.payload.id}\\.(jpg|png|webp)$`);
            const own = all.filter(file => marker.test(file.name || ''));
            // Unrelated retained attachments need separate ownership and
            // sibling-witness reconciliation before we can change this post.
            if (request.mode === 'resume') {
                if (!restore.statusFromPartial(snapshot.payload, state.current) || plan.edit.length) return false;
            } else if (snapshot.payload.sharedInline) {
                if (own.length !== 1 || !state.inline) return false;
                if (plan.edit.length) {
                    const inline = require('./twitterGridRestoreInline'), capacity = inline.capacity(state.inline, plan.edit.length);
                    if (capacity.inlineUploadMax >= plan.edit.length) state.inlineMode = 'uploads';
                    else if (capacity.inlineReferenceMax >= plan.edit.length) {
                        const status = restore.statusFromCombined(snapshot.payload, state.current);
                        if (!status) return false;
                        try {
                            state.inlinePlan = await inline.prepareReferenceEdit(state.inline, plan.edit, async () => {
                                const verified = await restore.fetchVerifiedSource(status, snapshot.payload, deps.sourceDependencies);
                                return verified.slice(0, plan.edit.length);
                            });
                            state.inlineMode = 'references';
                        } catch { return false; }
                    } else return false;
                }
            } else if (own.length !== 1 || all.length !== 1 || plan.edit.length > 10) return false;
            if (plan.edit.length && !(deps.editor || require('./providers/twitter/singleAttemptEditor')).forMessage(state.current)) return false;
            if (plan.sends.length && !(deps.sender || require('./providers/twitter/singleAttemptSender')).forMessage(state.current, 'channel', null)) return false;
            return true;
        },
        async begin(request, snapshot, plan, source) {
            state.operation = await state.journal.begin(request, snapshot, plan, source);
            if (request.mode !== 'new') return state.operation;
            try {
                const first = state.current, marker = cards.attachmentList(first).find(file => new RegExp(`^tg-${snapshot.payload.id}\\.(jpg|png|webp)$`).test(file.name || ''));
                if (!marker) throw new Error('GRID_SOURCE_CHANGED');
                let embeds = (first.embeds || []).map(cards.cleanEmbed);
                for (const embed of embeds) {
                    const image = embed.image?.url;
                    if (matchesUniqueReference(image, marker, cards.attachmentList(first), interaction.channelId)) delete embed.image;
                }
                if (snapshot.payload.sharedInline) embeds = [embeds[state.inline.markerIndex]];
                const components = (first.components || []).map(row => row?.toJSON ? row.toJSON() : JSON.parse(JSON.stringify(row)));
                for (const row of components) row.components = (row.components || []).filter(item => !String(item.custom_id || item.customId || '').startsWith('tg:')).map(item => {
                    const value = item.custom_id || item.customId || '';
                    if (!cards.locatorIdFromAction(value)) return item;
                    const next = { ...item, custom_id: value.split(':')[0] }; delete next.customId; return next;
                });
                const rows = components.filter(row => row.components.length);
                const parts = plan.sends.map((urls, sequence) => ({ imageUrls: urls, sequence, totalParts: plan.sends.length,
                    ...(sequence === 0 ? { embedStart: 0, embedEnd: embeds.length } : {}) }));
                const step = { content: snapshot.payload.sharedInline ? '' : first.content || '', embeds, components: rows, files: parts[0].imageUrls, twitterGrid: parts[0] };
                const following = parts.slice(1).map(part => ({ files: part.imageUrls, twitterGrid: part }));
                const independentDb = { queryDatabase: database.queryDatabaseIndependent };
                // The ordinary gallery store runs an expiry sweep after its
                // insert. Sweeping while the original row is locked can wait
                // on that same lock; this scoped store only inserts/binds.
                state.newStorage = {
                    async save(payload, sourceMessage, providerId) {
                        await independentDb.queryDatabase(`INSERT INTO bot_media_galleries
                            (gallery_id,guild_id,channel_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?)`,
                        [payload.id, sourceMessage.guildId, sourceMessage.channelId, providerId, JSON.stringify(payload), Date.now() + gallery.RETENTION_MS]);
                    },
                    async bind(id, messageId, retainForPost) {
                        const result = retainForPost
                            ? await independentDb.queryDatabase('UPDATE bot_media_galleries SET message_id=?,expires_at_ms=? WHERE gallery_id=? AND message_id IS NULL', [messageId, Number.MAX_SAFE_INTEGER, id])
                            : await independentDb.queryDatabase('UPDATE bot_media_galleries SET message_id=? WHERE gallery_id=? AND message_id IS NULL', [messageId, id]);
                        if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
                    },
                };
                state.newDb = independentDb;
                const settings = await getSettings(twitterProvider, interaction.guildId);
                const prepared = await cards.prepare(step, { guildId: interaction.guildId, channelId: interaction.channelId, channel: state.access.channel,
                    author: { id: snapshot.payload.requesterId } }, { providerId: 'twitter', url: source.url, presentationSettings: settings,
                    gridRequesterId: snapshot.payload.requesterId }, state.newStorage, following);
                if (prepared.grids?.length !== 1) throw new Error('GRID_RESTORE_UNAVAILABLE');
                state.newGrid = prepared.grids[0]; state.newParts = parts; state.newStep = prepared.step;
                if (cards.gridIdFromMessage({ components: state.newStep.components }) !== state.newGrid.id) throw new Error('GRID_RESTORE_UNAVAILABLE');
                await state.journal.registerNewGallery(state.operation, state.newGrid.id);
                return state.operation;
            } catch (error) {
                await state.journal.cancel(state.operation);
                if (state.newGrid) await cards.discardUnbound([state.newGrid], state.newDb);
                throw error;
            }
        },
        async cancel(operation) {
            await state.journal.cancel(operation);
            if (state.newGrid) await cards.discardUnbound([state.newGrid], state.newDb);
        },
        async prepareIntent(_request, snapshot, group, files) {
            if (!snapshot.payload.sharedInline || group.type !== 'edit') return null;
            const inline = require('./twitterGridRestoreInline');
            const plan = state.inlineMode === 'references' ? state.inlinePlan : inline.prepareEdit(state.inline, files);
            state.inlinePlan = plan; state.inlineFiles = files;
            const expected = { channelId: interaction.channelId, content: plan.edit.content, embeds: plan.edit.embeds, components: plan.edit.components, attachments: plan.retained };
            return { kind: plan.kind === 'references' ? 'inline-reference' : 'inline-upload', expectedFingerprint: cards.fingerprint(expected),
                expectedStatic: cards.fingerprint(expected, true), targetStart: plan.targetStart, targetEnd: plan.targetEnd,
                retainedIds: plan.retained.map(file => String(file.id)) };
        },
        plan: (operation, step) => state.journal.plan(operation, step), reject: (operation, index) => state.journal.reject(operation, index),
        markRejected413: (operation, index) => state.journal.markRejected413(operation, index),
        async repartition(operation, index, sizes) {
            if (operation.record.mode !== 'new') return state.journal.repartition(operation, index, sizes);
            if (!state.newGrid || typeof database.withIndependentTransaction !== 'function') throw new Error('GRID_RESTORE_UNAVAILABLE');
            const updated = await database.withIndependentTransaction(async query => {
                const record = await state.journal.repartition(operation, index, sizes, query);
                const previous = JSON.stringify(state.newGrid), next = { ...state.newGrid, totalParts: record.groupSizes.length };
                const messageId = state.newGrid.messageIds?.[0];
                const sql = messageId
                    ? 'UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?'
                    : 'UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id IS NULL AND BINARY payload_json=BINARY ?';
                const result = await query(sql, messageId ? [JSON.stringify(next), next.id, messageId, previous] : [JSON.stringify(next), next.id, previous]);
                if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
                return { record, next };
            });
            operation.record = updated.record; state.newGrid = updated.next;
            let offset = 0;
            state.newParts = updated.record.groupSizes.map((count, sequence) => {
                const imageUrls = state.newGrid.expectedImageUrls.slice(offset, offset + count); offset += count;
                return { imageUrls, sequence, totalParts: updated.record.groupSizes.length };
            });
            return operation.record;
        },
        confirm: (operation, receipt) => state.journal.confirm(operation, receipt), markUnknown: operation => state.journal.markUnknown(operation),
        async editOnce(_request, snapshot, files) {
            const first = state.current, all = cards.attachmentList(first), name = new RegExp(`^tg-${snapshot.payload.id}\\.(jpg|png|webp)$`);
            if (first?.author?.id !== interaction.client?.user?.id || cards.fingerprint(first) !== (state.afterSignature || state.firstSignature)) throw restore.notSubmitted();
            if (snapshot.payload.sharedInline) {
                const plan = state.inlinePlan;
                if (!plan) throw restore.notSubmitted();
                const editor = (deps.editor || require('./providers/twitter/singleAttemptEditor')).forMessage(first);
                if (!editor) throw restore.notSubmitted();
                return editor.edit(plan.edit);
            }
            const markers = all.filter(file => name.test(file.name || ''));
            if (markers.length !== 1) throw new Error('GRID_SOURCE_CHANGED');
            state.retainedIds = all.filter(file => file !== markers[0]).map(file => String(file.id));
            if (state.retainedIds.length + files.length > 10) throw new Error('GRID_RESTORE_SIZE');
            const embeds = (first.embeds || []).map(cards.cleanEmbed);
            for (const embed of embeds) {
                const image = embed.image?.url;
                if (matchesUniqueReference(image, markers[0], all, interaction.channelId)) delete embed.image;
            }
            const edit = { content: first.content || '', embeds, components: first.components || [], attachments: state.retainedIds.map(id => ({ id })),
                files: files.map(file => ({ attachment: file.data, name: file.name })), allowedMentions: { parse: [], repliedUser: false } };
            const editor = (deps.editor || require('./providers/twitter/singleAttemptEditor')).forMessage(first);
            if (!editor) throw new Error('GRID_RESTORE_UNAVAILABLE');
            return editor.edit(edit);
        },
        async sendOnce(request, _snapshot, files, _operation, index) {
            if (state.current?.author?.id !== interaction.client?.user?.id || cards.fingerprint(state.current) !== (state.afterSignature || state.firstSignature)) throw restore.notSubmitted();
            const sender = (deps.sender || require('./providers/twitter/singleAttemptSender')).forMessage(state.current, 'channel', null);
            if (!sender) throw new Error('GRID_RESTORE_UNAVAILABLE');
            const body = { files: files.map(file => ({ attachment: file.data, name: file.name })), allowedMentions: { parse: [], repliedUser: false } };
            if (request.mode === 'new' && index === 0) Object.assign(body, { content: state.newStep.content || '', embeds: state.newStep.embeds, components: state.newStep.components });
            return sender.send(body);
        },
        async verifyResult(request, snapshot, group, files, result, operation) {
            if (snapshot.payload.sharedInline && group.type === 'edit') {
                const inline = require('./twitterGridRestoreInline');
                let provisional;
                try {
                    provisional = state.inlinePlan.kind === 'references' ? inline.referenceManifest(state.inline, state.inlinePlan, result)
                        : restore.restoredManifest(snapshot.payload, operation.id, request.mode, [result], snapshot.payload.imageUrls,
                            operation.record.sourceStatusId, operation.record.groupSizes, true);
                    provisional.sourceStatusId = operation.record.sourceStatusId;
                    state.afterSignature = cards.fingerprint(result);
                    await inline.commit({ query: async () => ({ affectedRows: 1 }), interaction, snapshot: state.inline,
                        plan: state.inlinePlan, message: result, targetPayload: provisional, authorize: () => authorization(snapshot) });
                } catch { return false; }
                state.messages.push(result); return true;
            }
            if (!restore.verifyRestoredAttachments(result, { channelId: interaction.channelId, botId: interaction.client.user.id }, files,
                group.type === 'edit' ? state.retainedIds : [])) return false;
            if (group.type === 'edit') {
                if (String(result.id) !== String(snapshot.first.id) || !cards.matchesFingerprint(result, snapshot.payload.firstStaticSignature, true)) return false;
                state.afterSignature = cards.fingerprint(result);
            } else if (request.mode === 'new') {
                const index = state.messages.length, part = state.newParts[index];
                if (!part || !state.newGrid) return false;
                if (index === 0) {
                    if (cards.gridIdFromMessage(result) !== state.newGrid.id || (result.content || '') !== (state.newStep.content || '')
                        || JSON.stringify((result.embeds || []).map(cards.cleanEmbed)) !== JSON.stringify((state.newStep.embeds || []).map(cards.cleanEmbed))) return false;
                    if (!await cards.bind(state.newGrid, result, state.newStorage, state.newDb, part)) return false;
                } else if (result.content || (result.embeds || []).length || (result.components || []).length
                    || !await cards.append(state.newGrid, part, result, state.newDb)) return false;
                await cards.finish(state.newGrid, state.newDb);
            } else if (result.content || (result.embeds || []).length || (result.components || []).length) return false;
            if (request.mode === 'resume') (state.resumeFiles ||= []).push(files);
            state.messages.push(result); return true;
        },
        async finish(operation, request, snapshot) {
            if (request.mode === 'new') {
                if (!state.newGrid || state.newGrid.partsState !== 'complete') throw new Error('GRID_SOURCE_INCOMPLETE');
                await state.journal.markFinished(operation); return;
            }
            if (request.mode === 'resume') {
                if (!state.messages.length) throw new Error('GRID_SOURCE_INCOMPLETE');
                const existing = [];
                for (const [index, messageId] of snapshot.payload.messageIds.entries()) {
                    const message = await (state.access.channel || interaction.channel).messages.fetch({ message: messageId, force: true, cache: false });
                    if (message?.author?.id !== interaction.client?.user?.id || String(message.id) !== String(messageId)
                        || !cards.matchesFingerprint(message, snapshot.payload.partSignatures[index])) throw new Error('GRID_SOURCE_CHANGED');
                    existing.push(message);
                }
                if (snapshot.payload.sharedInline) {
                    await require('./twitterGridRestoreInline').commitResume({ query: state.lock.query, interaction, snapshot: state.inline,
                        first: existing, continuation: state.messages, operationId: operation.id, uploads: state.resumeFiles,
                        authorize: () => authorization(snapshot) });
                    await state.journal.markFinished(operation); return;
                }
                const next = restore.resumedManifest(snapshot.payload, operation.id, existing, state.messages);
                const changed = await state.lock.query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
                    [JSON.stringify(next), galleryId, state.lock.scope.messageId, state.lock.row.payload_json]);
                if (Number(changed?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
                await state.journal.markFinished(operation); return;
            }
            const status = restore.statusFromCombined(snapshot.payload, snapshot.first);
            // The saved status was verified before the edit and remains part of
            // the durable intent even if discord.js patched snapshot.first.
            const statusId = status?.id || operation.record.sourceStatusId;
            if (snapshot.payload.sharedInline) {
                const inline = require('./twitterGridRestoreInline');
                let target;
                if (state.inlinePlan.kind === 'references') {
                    target = inline.referenceManifest(state.inline, state.inlinePlan, state.messages[0]);
                    if (state.messages.length > 1) {
                        const groups = restore.planFromSizes(snapshot.payload.imageUrls, request.mode, operation.record.groupSizes);
                        const allGroups = [groups.edit, ...groups.sends], visible = allGroups.flat();
                        target = { ...target, imageUrls: visible, expectedImageUrls: visible,
                            partRefs: allGroups.map(group => group.map(url => ({ type: 'url', url }))), partSizes: allGroups.map(group => group.length),
                            totalParts: allGroups.length, completedParts: allGroups.length, messageIds: state.messages.map(message => String(message.id)),
                            partSignatures: state.messages.map(message => cards.fingerprint(message)), partContainsNonImage: [target.partContainsNonImage[0], ...allGroups.slice(1).map(() => false)] };
                    }
                } else target = restore.restoredManifest(snapshot.payload, operation.id, request.mode, state.messages, snapshot.payload.imageUrls, statusId, operation.record.groupSizes);
                target.sourceStatusId = statusId;
                const archived = snapshot.payload.restoreArchive;
                if (archived && (archived.sourceStatusId !== statusId || !Array.isArray(archived.imageUrls)
                    || snapshot.payload.imageUrls.length > archived.imageUrls.length
                    || snapshot.payload.imageUrls.some((url, i) => url !== archived.imageUrls[i]))) throw new Error('GRID_RESTORE_RECORD');
                target.restoreArchive = archived || { sourceStatusId: statusId, imageUrls: [...snapshot.payload.imageUrls] };
                if (request.mode === 'first' && target.imageUrls.length < target.restoreArchive.imageUrls.length)
                    target.restoreContinuation = { sourceStatusId: statusId, nextIndex: target.imageUrls.length, targetCount: target.restoreArchive.imageUrls.length };
                await inline.commit({ query: state.lock.query, interaction, snapshot: state.inline, plan: state.inlinePlan,
                    message: state.messages[0], targetPayload: target, authorize: () => authorization(snapshot) });
                await state.journal.markFinished(operation); return;
            }
            const next = restore.restoredManifest(snapshot.payload, operation.id, request.mode, state.messages, snapshot.payload.imageUrls, statusId, operation.record.groupSizes);
            const changed = await state.lock.query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
                [JSON.stringify(next), galleryId, state.lock.scope.messageId, state.lock.row.payload_json]);
            if (Number(changed?.affectedRows) !== 1) throw new Error('GRID_RECORD_CONFLICT');
            await state.journal.markFinished(operation);
        },
    };
    adapters.inPlaceAvailable = () => adapters.withLock({ mode: 'menu' }, async snapshot => {
        if (!await authorization(snapshot)) return { status: 'denied' };
        if (!snapshot.payload.sharedInline) return { status: 'ok', separateOnly: false };
        const needed = Math.min(10, snapshot.payload.imageUrls.length);
        const capacity = require('./twitterGridRestoreInline').capacity(state.inline, needed);
        return { status: 'ok', separateOnly: Math.max(capacity.inlineUploadMax, capacity.inlineReferenceMax) < 1,
            rootCapacity: Math.max(capacity.inlineUploadMax, capacity.inlineReferenceMax) };
    });
    return adapters;
}

module.exports = { createAdapters };
