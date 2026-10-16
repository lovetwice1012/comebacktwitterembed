'use strict';

const { workflowTargets, targetsToken } = require('./workflow-targets');
const { lockOwner } = require('./entitlements');
const { advanceMonitorRevision } = require('./monitors');
const nativeTable = kind => kind === 'auto' ? 'auto_watch' : 'price_watch';
function changed() { throw new (require('./service').AutomationError)('WORKFLOW_TARGETS_CHANGED', 'このルールを使う通知が変更されています。最新の通知を確認してから、もう一度操作してください。', 409); }

// Hold every reviewed consumer's configuration fence before the workflow row.
// Activation and deletion share the same order as native/X registration edits.
async function withLockedWorkflowTargets(db, actor, id, expectedRevision, service, callback) {
    const candidate = await service.getRow('workflow', actor, id, true);
    const roster = await workflowTargets(db.queryDatabase, candidate);
    const sources = [];
    for (const target of roster.filter(target => target.kind !== 'x')) {
        const row = (await db.queryDatabase(`SELECT source_id FROM ${nativeTable(target.kind)}_targets WHERE id=? AND user_id=?`, [target.id, target.ownerId]))[0];
        if (!row) changed();
        sources.push({ kind: target.kind, id: String(row.source_id), targetId: target.id });
    }
    return db.withDatabaseTransaction(async query => {
        if (roster.some(target => target.kind === 'x')) {
            // X mutations serialize global pool policy before owner fences.
            await query('INSERT INTO automation_push_pool_policy (id,free_pool_limit,supporter_pool_limit,actor_user_id,updated_at_ms) VALUES (1,50,100,?,?) ON DUPLICATE KEY UPDATE id=id', [actor.userId, Date.now()]);
            await query('SELECT id FROM automation_push_pool_policy WHERE id=1 FOR UPDATE');
        }
        const owners = [...new Set([candidate.owner_user_id, ...roster.map(target => target.ownerId)])].sort();
        for (const owner of owners) await lockOwner(query, owner);
        await require('./flow-history').lockWorkflowFlowHistory(query, [id]);
        const uniqueSources = [...new Map(sources.map(source => [`${source.kind}:${source.id}`, source])).values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
        for (const source of uniqueSources) if (!(await query(`SELECT id FROM ${nativeTable(source.kind)}_sources WHERE id=? FOR UPDATE`, [source.id])).length) changed();
        for (const target of roster) {
            if (target.kind === 'x') {
                if (!(await query("SELECT id FROM automation_x_monitors WHERE id=? AND owner_user_id=? AND state<>'deleted' FOR UPDATE", [target.id, target.ownerId])).length) changed();
            } else {
                const table = nativeTable(target.kind), row = (await query(`SELECT source_id FROM ${table}_targets WHERE id=? AND user_id=? FOR UPDATE`, [target.id, target.ownerId]))[0];
                if (!row || String(row.source_id) !== sources.find(source => source.kind === target.kind && source.targetId === target.id).id) changed();
                await query('SELECT revision FROM automation_monitors WHERE target_kind=? AND target_id=? FOR UPDATE', [target.kind, target.id]);
                await query('SELECT workflow_id FROM automation_assignments WHERE target_kind=? AND target_id=? FOR UPDATE', [target.kind, target.id]);
            }
        }
        // No consistent snapshot was opened before these current locking reads.
        // New attachments use owner/source/target -> workflow. If one commits
        // before this lock, the full roster check sees it and rolls back; one
        // arriving afterwards sees a deleted workflow and cannot attach.
        const row = await service.getRow('workflow', actor, id, true, query, true);
        if (Number(row.revision) !== expectedRevision) throw new (require('./service').AutomationError)('REVISION_CONFLICT', '対象が更新されています。', 409);
        if (targetsToken(candidate, roster) !== targetsToken(row, await workflowTargets(query, row))) changed();
        return callback(query, row, roster);
    });
}

// Deletion has the same explicit stop/detach contract for native and X watches.
// It never releases a registration, slot, subscription or destination.
async function removeWorkflow(db, actor, id, expectedRevision, service) {
    return withLockedWorkflowTargets(db, actor, id, expectedRevision, service, async (query, row, roster) => {
        const now = Date.now();
        for (const target of roster) {
            if (target.kind === 'x') {
                await query("UPDATE automation_x_monitors SET enabled=0,notification_settings_json=JSON_REMOVE(notification_settings_json,'$.workflowId'),revision=revision+1,updated_at_ms=? WHERE id=? AND owner_user_id=?", [now, target.id, target.ownerId]);
            } else {
                const table = nativeTable(target.kind);
                await query(`UPDATE ${table}_targets SET enabled=0 WHERE id=? AND user_id=?`, [target.id, target.ownerId]);
                await advanceMonitorRevision(query, target.kind, target.id, target.scope, target.revision);
                await query('DELETE FROM automation_assignments WHERE target_kind=? AND target_id=? AND workflow_id=?', [target.kind, target.id, id]);
                await query(`UPDATE ${table}_deliveries SET status='cancelled',lease_token=NULL,lease_expires_at_ms=0 WHERE target_id=? AND status='pending'`, [target.id]);
            }
            await service.audit(query, actor, id, 'workflow.delete.pause', { targetKind: target.kind, targetId: target.id, ownerId: target.ownerId, beforeRevision: target.revision, afterRevision: target.revision + 1 }, target.guildId);
        }
        // Fence in-flight graph work before cancelling the projected jobs.
        // Historical sent/unknown jobs retain their exact status and receipts.
        const revokedRuns = await require('./flow-history').revokeWorkflowFlowHistory(query, [id], 'WORKFLOW_DELETED', now);
        const jobs = await query("SELECT j.* FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE r.workflow_id=? AND j.state IN ('pending','held','leased','aggregated') ORDER BY j.id FOR UPDATE", [id]);
        await query("UPDATE automation_jobs j JOIN automation_runs r ON r.id=j.run_id SET j.state='cancelled',j.last_error_code='WORKFLOW_DELETED',j.lease_token=NULL,j.lease_until_ms=0,j.updated_at_ms=? WHERE r.workflow_id=? AND j.state IN ('pending','held','leased','aggregated')", [now, id]);
        await require('./flow-history').refreshJobFlowHistory(query, jobs);
        await require('./flow-history').refreshWorkflowFlowHistory(query, revokedRuns);
        await query('UPDATE automation_workflows SET deleted_at_ms=?,enabled=0,revision=revision+1,updated_at_ms=? WHERE id=?', [now, now, id]);
        await service.audit(query, actor, id, 'workflow.delete', { revision: expectedRevision, pausedTargets: roster.map(target => ({ kind: target.kind, id: target.id })) }, row.guild_id);
        return { deleted: true, pausedTargets: roster.length };
    });
}

module.exports = { removeWorkflow, withLockedWorkflowTargets };
