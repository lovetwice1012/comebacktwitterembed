'use strict';

const { randomBytes } = require('node:crypto');
const { fingerprint } = require('./twitterGridCards');

function rejected413State(record) {
    const marker = record?.rejected413, groups = record?.groupSizes, steps = record?.steps;
    if (!marker || !['rejected', 'repartitioned'].includes(marker.phase) || !Array.isArray(marker.originalGroups)
        || !Array.isArray(groups) || !Array.isArray(steps) || !Number.isInteger(marker.index)
        || !/^[a-f0-9]{32}$/.test(record?.operationId || '') || !['here', 'first', 'rest', 'new', 'resume'].includes(record.mode)
        || marker.index < 0 || marker.index >= marker.originalGroups.length || marker.originalGroups.length > 20
        || marker.originalGroups.some(count => !Number.isInteger(count) || count < 1 || count > 10)
        || marker.step?.index !== marker.index || marker.step?.state !== 'planned'
        || marker.step.count !== marker.originalGroups[marker.index] || !['edit', 'send'].includes(marker.step.type)
        || !Number.isInteger(marker.step.start) || !/^\d{1,25}$/.test(String(marker.step.previousId || ''))
        || !Array.isArray(marker.step.proofs) || marker.step.proofs.length !== marker.step.count) return null;
    const confirmed = marker.phase === 'rejected' ? steps.slice(0, -1) : steps;
    if (confirmed.length !== marker.index || confirmed.some(step => step.state !== 'confirmed')) return null;
    const start = marker.originalGroups.slice(0, marker.index).reduce((sum, count) => sum + count, record.baseOffset || 0);
    const type = !['new', 'resume'].includes(record.mode) && marker.index === 0 ? 'edit' : 'send';
    if (!Number.isInteger(record.baseOffset ?? 0) || (record.baseOffset ?? 0) < 0 || marker.step.start !== start || marker.step.type !== type
        || marker.index && String(marker.step.previousId) !== String(confirmed.at(-1).messageId || '')
        || marker.step.proofs.some((proof, index) => !new RegExp(`^restore-${record.operationId}-${start + index}\\.(jpg|png|webp|avif)$`).test(proof?.name || '')
            || !/^[a-f0-9]{64}$/.test(proof?.sha256 || ''))) return null;
    if (marker.phase === 'rejected') {
        if (JSON.stringify(groups) !== JSON.stringify(marker.originalGroups)
            || JSON.stringify(steps.at(-1)) !== JSON.stringify(marker.step)) return null;
    } else {
        const split = marker.replacement;
        if (!Array.isArray(split) || split.length !== 2 || split.some(count => !Number.isInteger(count) || count < 1)
            || split[0] + split[1] !== marker.step.count || groups.length > 20) return null;
        const expected = [...marker.originalGroups]; expected.splice(marker.index, 1, ...split);
        if (JSON.stringify(groups) !== JSON.stringify(expected)) return null;
    }
    return marker;
}

// The caller must hold the shared gallery row lock for the whole operation.
// Writes use a distinct pool and commit independently, so an application
// transaction rollback cannot forget a Discord request already submitted.
function createRestoreJournal(db, scope, clock = () => Date.now()) {
    if (typeof db?.queryDatabaseIndependent !== 'function' || !/^[a-f0-9]{32}$/.test(scope?.lockId || '')
        || !/^[a-f0-9]{32}$/.test(scope?.galleryId || '') || !/^\d{1,25}$/.test(String(scope?.messageId || ''))
        || !/^\d{1,25}$/.test(String(scope?.guildId || '')) || !/^\d{1,25}$/.test(String(scope?.channelId || ''))) throw new Error('GRID_RESTORE_UNAVAILABLE');
    const run = (...args) => db.queryDatabaseIndependent(...args);
    const store = async (operation, next, query = run) => {
        const previous = JSON.stringify(operation.record), encoded = JSON.stringify(next);
        const result = await query(`UPDATE bot_twitter_grid_action_intents SET payload_json=?,updated_at_ms=?
            WHERE gallery_id=? AND operation_id=? AND BINARY payload_json=BINARY ?`,
        [encoded, clock(), scope.lockId, operation.id, previous]);
        if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RESTORE_JOURNAL_CONFLICT');
        operation.record = next;
    };
    return {
        async begin(request, snapshot, plan, source) {
            if (!['here', 'first', 'rest', 'new', 'resume'].includes(request?.mode) || !snapshot?.first
                || String(snapshot.first.id || '') !== String(scope.messageId) || !/^\d{1,22}$/.test(source?.id || '')
                || !plan || !Array.isArray(plan.edit) || !Array.isArray(plan.sends) || plan.sends.length > 20
                || !Array.isArray(snapshot.payload?.imageUrls) || snapshot.payload.imageUrls.length < 1 || snapshot.payload.imageUrls.length > 20)
                throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const original = request.mode === 'resume' ? snapshot.payload.restoreArchive?.imageUrls : snapshot.payload.imageUrls;
            if (!require('./twitterGridRestore').validateRestorePlan(original, request.mode, request.mode === 'here', plan, snapshot.payload.restoreContinuation)) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            if (request.mode === 'first' && plan.sends.length && request.splitConfirmed !== true) throw new Error('GRID_RESTORE_CONFIRM_REQUIRED');
            const id = randomBytes(16).toString('hex');
            // URLs, image bytes and text are intentionally absent: only the
            // exact operation and resulting message IDs are retained.
            const record = { version: 1, kind: 'twitter-grid-restore', operationId: id, galleryId: scope.galleryId,
                lockId: scope.lockId, state: 'in_progress', mode: request.mode, sourceStatusId: source.id,
                imageCount: original.length, baseOffset: request.mode === 'resume' ? snapshot.payload.restoreContinuation.nextIndex : 0,
                targetCount: request.mode === 'resume' ? (snapshot.payload.restoreContinuation.targetCount ?? original.length) : request.mode === 'first' ? Math.min(10, original.length) : original.length,
                startedAtMs: clock(), groupSizes: [plan.edit.length, ...plan.sends.map(group => group.length)].filter(Boolean),
                firstFingerprint: fingerprint(snapshot.first), steps: [] };
            await run(`INSERT INTO bot_twitter_grid_action_intents
                (gallery_id,guild_id,channel_id,message_id,operation_id,payload_json,updated_at_ms) VALUES (?,?,?,?,?,?,?)`,
            [scope.lockId, scope.guildId, scope.channelId, scope.messageId, id, JSON.stringify(record), clock()]);
            return { id, record };
        },
        async plan(operation, step) {
            const expectedCount = operation?.record?.groupSizes?.[step?.index];
            const expectedStart = operation?.record?.groupSizes?.slice(0, step?.index).reduce((sum, count) => sum + count, operation.record.baseOffset || 0);
            const expectedType = !['new', 'resume'].includes(operation?.record?.mode) && step?.index === 0 ? 'edit' : 'send';
            if (operation?.record?.state !== 'in_progress' || !Number.isInteger(step?.index)
                || step.index !== operation.record.steps.length || !['edit', 'send'].includes(step.type)
                || !Number.isInteger(step.start) || step.start < 0 || !Number.isInteger(step.count) || step.count < 1 || step.count > 10
                || step.type !== expectedType || step.count !== expectedCount || step.start !== expectedStart
                || step.start + step.count > 20 || !/^\d{1,25}$/.test(String(step.previousId || ''))
                || !Array.isArray(step.proofs) || step.proofs.length !== step.count || step.proofs.some((proof, i) =>
                    !new RegExp(`^restore-${operation.id}-${step.start + i}\\.(jpg|png|webp|avif)$`).test(proof?.name || '')
                    || !/^[a-f0-9]{64}$/.test(proof?.sha256 || ''))
                || operation.record.steps.some(value => value.state !== 'confirmed')) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const evidence = step.evidence;
            if (evidence != null && (!['inline-reference', 'inline-upload'].includes(evidence.kind)
                || !/^[a-f0-9]{64}$/.test(evidence.expectedFingerprint || '')
                || !/^[a-f0-9]{64}$/.test(evidence.expectedStatic || '')
                || !Number.isInteger(evidence.targetStart) || !Number.isInteger(evidence.targetEnd)
                || evidence.targetStart < 0 || evidence.targetEnd <= evidence.targetStart || evidence.targetEnd > 10
                || !Array.isArray(evidence.retainedIds) || evidence.retainedIds.some(id => !/^\d{1,25}$/.test(String(id || '')))
                || new Set(evidence.retainedIds.map(String)).size !== evidence.retainedIds.length)) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            if (operation.record.rejected413 && (!rejected413State(operation.record) || operation.record.rejected413.phase !== 'repartitioned'
                || operation.record.rejected413.index !== step.index)) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const { rejected413, ...prior } = operation.record;
            void rejected413;
            await store(operation, { ...prior, steps: [...operation.record.steps,
                { index: step.index, type: step.type, start: step.start, count: step.count, previousId: step.previousId,
                    proofs: step.proofs.map(proof => ({ name: proof.name, sha256: proof.sha256 })),
                    ...(evidence ? { evidence: { kind: evidence.kind, expectedFingerprint: evidence.expectedFingerprint,
                        expectedStatic: evidence.expectedStatic, targetStart: evidence.targetStart, targetEnd: evidence.targetEnd,
                        retainedIds: evidence.retainedIds.map(String) } } : {}), state: 'planned' }] });
        },
        async registerNewGallery(operation, galleryId) {
            if (operation?.record?.state !== 'in_progress' || operation.record.mode !== 'new' || operation.record.steps.length
                || operation.record.newGalleryId || !/^[a-f0-9]{32}$/.test(galleryId || '') || galleryId === scope.galleryId)
                throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            await store(operation, { ...operation.record, newGalleryId: galleryId });
        },
        async confirm(operation, receipt) {
            const steps = operation?.record?.steps || [], current = steps.at(-1);
            if (operation?.record?.state !== 'in_progress' || !current || current.state !== 'planned'
                || receipt?.index !== current.index || receipt.type !== current.type || !/^\d{1,25}$/.test(String(receipt.messageId || ''))
                || current.type === 'edit' && String(receipt.messageId) !== String(scope.messageId)) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const next = [...steps];
            next[next.length - 1] = { ...current, state: 'confirmed', messageId: String(receipt.messageId) };
            await store(operation, { ...operation.record, steps: next });
        },
        async reject(operation, index) {
            const steps = operation?.record?.steps || [], current = steps.at(-1);
            if (operation?.record?.state !== 'in_progress' || !current || current.state !== 'planned' || current.index !== index)
                throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const { rejected413, ...prior } = operation.record; void rejected413;
            await store(operation, { ...prior, steps: steps.slice(0, -1) });
        },
        async markRejected413(operation, index) {
            const steps = operation?.record?.steps || [], current = steps.at(-1), groups = operation?.record?.groupSizes;
            if (operation?.record?.state !== 'in_progress' || operation.record.rejected413 || !current || current.state !== 'planned'
                || current.index !== index || !Array.isArray(groups) || groups[index] !== current.count) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            await store(operation, { ...operation.record, rejected413: { phase: 'rejected', index, originalGroups: [...groups], step: current } });
        },
        // Only call after the submitted request has received a definitive 413.
        // Remove that planned request and replace its group in one durable CAS.
        async repartition(operation, index, sizes, queryOverride) {
            const steps = operation?.record?.steps || [], current = steps.at(-1), groups = operation?.record?.groupSizes;
            if (operation?.record?.state !== 'in_progress' || !current || current.state !== 'planned' || current.index !== index
                || !Array.isArray(groups) || groups[index] !== current.count || !Array.isArray(sizes) || sizes.length !== 2
                || sizes.some(size => !Number.isInteger(size) || size < 1 || size >= current.count)
                || sizes[0] + sizes[1] !== current.count || groups.length >= 20
                || rejected413State(operation.record)?.phase !== 'rejected') throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const nextGroups = [...groups]; nextGroups.splice(index, 1, ...sizes);
            // When joining an external transaction, leave the caller's in-memory
            // operation unchanged until it has committed successfully.
            const draft = queryOverride ? { id: operation.id, record: operation.record } : operation;
            await store(draft, { ...operation.record, steps: steps.slice(0, -1), groupSizes: nextGroups,
                rejected413: { ...operation.record.rejected413, phase: 'repartitioned', replacement: [...sizes] } }, queryOverride || run);
            return draft.record;
        },
        async resolveRejected413(operation) {
            const marker = rejected413State(operation?.record);
            if (!marker || !['in_progress', 'unknown'].includes(operation.record.state)) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const { rejected413, ...prior } = operation.record; void rejected413;
            const steps = marker.phase === 'rejected' ? operation.record.steps.slice(0, -1) : operation.record.steps;
            await store(operation, { ...prior, state: 'in_progress', steps });
        },
        async confirmUnknownEdit(operation, receipt) {
            const steps = operation?.record?.steps || [], current = steps.at(-1);
            if (operation?.record?.state !== 'unknown' || !current || current.state !== 'planned' || current.type !== 'edit'
                || receipt?.index !== current.index || String(receipt.messageId || '') !== String(scope.messageId))
                throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const next = [...steps];
            next[next.length - 1] = { ...current, state: 'confirmed', messageId: String(receipt.messageId) };
            await store(operation, { ...operation.record, state: 'in_progress', steps: next });
        },
        async confirmUnknownSend(operation, receipt) {
            const steps = operation?.record?.steps || [], current = steps.at(-1);
            if (operation?.record?.state !== 'unknown' || !current || current.state !== 'planned' || current.type !== 'send'
                || receipt?.index !== current.index || !/^\d{1,25}$/.test(String(receipt.messageId || '')))
                throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const next = [...steps];
            next[next.length - 1] = { ...current, state: 'confirmed', messageId: String(receipt.messageId) };
            await store(operation, { ...operation.record, state: 'in_progress', steps: next });
        },
        async markUnknown(operation) {
            if (operation?.record?.state !== 'in_progress') throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            await store(operation, { ...operation.record, state: 'unknown' });
        },
        async cancel(operation) {
            if (operation?.record?.state !== 'in_progress' || operation.record.steps.length) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            const result = await run('DELETE FROM bot_twitter_grid_action_intents WHERE gallery_id=? AND operation_id=? AND BINARY payload_json=BINARY ?',
                [scope.lockId, operation.id, JSON.stringify(operation.record)]);
            if (Number(result?.affectedRows) !== 1) throw new Error('GRID_RESTORE_JOURNAL_CONFLICT');
        },
        async markFinished(operation) {
            if (operation?.record?.state !== 'in_progress' || !operation.record.steps.length
                || operation.record.steps.length !== operation.record.groupSizes.length
                || operation.record.steps.some(value => value.state !== 'confirmed')) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            await store(operation, { ...operation.record, state: 'finished' });
        },
        async markPartial(operation) {
            if (operation?.record?.state !== 'in_progress' || !operation.record.steps.length
                || operation.record.steps.length >= operation.record.groupSizes.length
                || operation.record.steps.some(value => value.state !== 'confirmed')) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            await store(operation, { ...operation.record, state: 'partial_saved' });
        },
        // Call only after manifest commit is confirmed. A stale worker cannot
        // erase a successor's intent because operation_id is part of the key.
        async clearAfterCommit(operation) {
            if (!['finished', 'partial_saved'].includes(operation?.record?.state)) throw new Error('GRID_RESTORE_JOURNAL_INVALID');
            await run('DELETE FROM bot_twitter_grid_action_intents WHERE gallery_id=? AND operation_id=?', [scope.lockId, operation.id]);
        },
    };
}

module.exports = { createRestoreJournal, rejected413State };
