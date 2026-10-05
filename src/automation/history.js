'use strict';

const { requireActor, assertAccess, AutomationError, hash } = require('./service');
const { scheduleDelivery } = require('./schedule');
const { FIELDS } = require('./schema');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
function version(row) { return hash(JSON.stringify([row.state, row.due_at_ms, row.updated_at_ms, row.lease_token, row.attempts, row.plan_json])); }
function snapshot(row) {
    let invalid = false;
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const eventObject = value => object(value) && Object.entries(FIELDS).every(([key, type]) => value[key] == null || (type === 'array' ? Array.isArray(value[key]) && value[key].every(item => typeof item === 'string') : typeof value[key] === type && (type !== 'number' || Number.isFinite(value[key]))));
    const traceArray = value => Array.isArray(value) && value.every(item => object(item) && typeof item.nodeId === 'string' && typeof item.outcome === 'string');
    const displayText = value => value == null || typeof value === 'string';
    const read = (raw, fallback, validate) => {
        try { const value = parse(raw); if (value == null) return fallback; if (!validate(value)) throw new Error('INVALID'); return value; }
        catch { invalid = true; return fallback; }
    };
    const plan = read(row.plan_json, {}, value => object(value) && displayText(value.text) && displayText(value.defaultPriceText));
    const fallbackEvent = read(plan.event, {}, eventObject), originalEvent = read(row.event_json, fallbackEvent, eventObject), originalTrace = read(row.trace_json, [], traceArray);
    const members = plan.members === undefined ? [] : read(plan.members, [], value => Array.isArray(value) && value.every(member => object(member) && eventObject(member.event) && displayText(member.text) && displayText(member.defaultPriceText)));
    const latest = plan.aggregate?.mode === 'latest' && members.length > 0;
    const event = latest ? members.at(-1).event : originalEvent;
    const trace = latest && plan.latestTrace != null ? read(plan.latestTrace, [], traceArray) : originalTrace;
    return { plan, members, event, trace, originalEvent, originalTrace, invalid };
}
function formatJob(row) {
    const { plan, members, event, invalid } = snapshot(row);
    return { id: row.id, runId: row.run_id, state: row.state, version: version(row), dueAtMs: Number(row.due_at_ms), deadlineMs: row.deadline_ms == null ? null : Number(row.deadline_ms),
        title: event?.title, url: event?.url, providerId: event?.providerId, scope: row.scope, workflowId: row.workflow_id, ruleRevision: row.revision,
        targetKind: row.target_kind, targetId: String(row.target_id), destinationId: row.destination_id, parentJobId: row.parent_job_id,
        attempts: Number(row.attempts), sentSteps: Number(row.sent_steps), messageId: row.discord_message_id, errorCode: row.last_error_code,
        aggregateItems: members.length || null, aggregateReceived: plan.aggregateCount || members.length || null, aggregateMode: plan.aggregate?.mode || null,
        snapshotInvalid: invalid, preview: invalid ? '保存された配信データを読み取れません。この通知は再送せず、設定から新しい通知を作成してください。' : members.length ? members.map(member => member.defaultPriceText || member.text).join('\n\n') : plan.defaultPriceText || plan.text,
        createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) };
}
function createHistory(db, service) {
    const selection = `SELECT j.*,r.owner_user_id,r.guild_id,r.scope,r.workflow_id,r.revision,r.target_kind,r.target_id,r.event_json,r.trace_json
        FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id`;
    async function getRow(actor, id, write = false, query = db.queryDatabase, lock = false) {
        requireActor(actor);
        if (!/^[0-9a-f-]{36}$/.test(id || '')) fail('NOT_FOUND', '配信が見つかりません。', 404);
        const rows = await query(`${selection} WHERE j.id=?${lock ? ' FOR UPDATE' : ''}`, [id]);
        assertAccess(actor, rows[0], write);
        return rows[0];
    }
    async function list(actor, input = {}) {
        requireActor(actor);
        const states = ['pending', 'held', 'leased', 'sending', 'aggregated', 'sent', 'unknown', 'partial', 'failed', 'expired', 'cancelled', 'excluded'];
        if (input.state && !states.includes(input.state)) fail('INVALID_STATE', '配信状態が不正です。');
        let cursor;
        if (input.cursor) {
            try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); } catch { fail('INVALID_CURSOR', 'ページ位置が不正です。'); }
            if (!Number.isSafeInteger(cursor.at) || cursor.at < 0 || !/^[0-9a-f-]{36}$/.test(cursor.id || '')) fail('INVALID_CURSOR', 'ページ位置が不正です。');
        }
        const conditions = ["((r.scope='private' AND r.owner_user_id=?) OR (r.scope='guild' AND r.guild_id=? AND ?=1))"];
        const params = [actor.userId, actor.guildId || null, actor.canView ? 1 : 0];
        if (input.state) { conditions.push('j.state=?'); params.push(input.state); }
        if (cursor) { conditions.push('(j.created_at_ms<? OR (j.created_at_ms=? AND j.id<?))'); params.push(cursor.at, cursor.at, cursor.id); }
        const rows = await db.queryDatabase(`${selection} WHERE ${conditions.join(' AND ')} ORDER BY j.created_at_ms DESC,j.id DESC LIMIT 51`, params);
        const selected = rows.slice(0, 50), last = selected.at(-1);
        return { items: selected.map(formatJob), nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify({ at: Number(last.created_at_ms), id: last.id })).toString('base64url') : null };
    }
    async function detail(actor, id) {
        const row = await getRow(actor, id);
        const data = snapshot(row);
        return { ...formatJob(row), event: data.event, trace: data.trace, plan: data.plan, originalEvent: data.originalEvent };
    }
    async function change(actor, id, input) {
        if (!['cancel', 'reschedule', 'retry'].includes(input.action)) fail('INVALID_ACTION', '配信操作が不正です。');
        return db.withDatabaseTransaction(async query => {
            const row = await getRow(actor, id, true, query, true);
            if (version(row) !== input.expectedVersion) fail('REVISION_CONFLICT', '配信状態が変わりました。再読み込みしてください。', 409);
            if (row.parent_job_id) fail('AGGREGATED_MEMBER', 'まとめ通知の親の配信を操作してください。');
            if (['unknown', 'partial', 'sending', 'sent'].includes(row.state) || Number(row.sent_steps) > 0 || row.discord_message_id) fail('DELIVERY_NOT_REPLAYABLE', '送信済み・送信中・結果不明の通知は二重送信を避けるため、この操作を実行できません。');
            if (input.action !== 'cancel' && snapshot(row).invalid) fail('HISTORY_SNAPSHOT_INVALID', '保存された配信データを読み取れないため、再送・再予約はできません。');
            let state = row.state, due = Number(row.due_at_ms);
            const now = Date.now();
            if (input.action === 'cancel') state = 'cancelled';
            else {
                if (input.action === 'reschedule' && !['pending', 'leased'].includes(state)) fail('NOT_PENDING', '未送信の配信だけ時刻を変更できます。');
                if (input.action === 'retry' && (state !== 'failed' || Number(row.sent_steps) !== 0)) fail('NOT_RETRYABLE', '送信結果が不明でなく、送信実績がない失敗だけ再試行できます。');
                const requested = input.action === 'retry' ? now : Number(input.dueAtMs);
                if (!Number.isSafeInteger(requested) || requested < now || requested > now + 366 * 86400000) fail('INVALID_DUE_TIME', '配信時刻は現在から1年以内で指定してください。');
                const plan = parse(row.plan_json);
                due = scheduleDelivery(requested, plan.schedules, row.deadline_ms == null ? Infinity : Number(row.deadline_ms));
                if (due === null) fail('DEADLINE_EXCEEDED', 'ルールの期限・通知可能時間内に予約できません。');
                state = 'pending';
            }
            await query('UPDATE automation_jobs SET state=?,due_at_ms=?,lease_token=NULL,lease_until_ms=0,attempts=IF(?=\'retry\',0,attempts),last_error_code=?,updated_at_ms=? WHERE id=?',
                [state, due, input.action, `USER_${input.action.toUpperCase()}`, now, id]);
            if (state === 'cancelled') await query("UPDATE automation_jobs SET state='cancelled',last_error_code='PARENT_CANCELLED',updated_at_ms=? WHERE parent_job_id=? AND state='aggregated'", [now, id]);
            await service.audit(query, actor, id, `job.${input.action}`, { previousState: row.state, dueAtMs: due }, row.guild_id);
            return { state, dueAtMs: due };
        });
    }
    async function excluded(actor, after = '') {
        requireActor(actor);
        const rows = await db.queryDatabase(`SELECT id,workflow_id,revision,target_kind,target_id,event_json,trace_json,state,created_at_ms FROM automation_runs
            WHERE state='excluded' AND id>? AND ((scope='private' AND owner_user_id=?) OR (scope='guild' AND guild_id=? AND ?=1)) ORDER BY id LIMIT 51`, [after, actor.userId, actor.guildId || null, actor.canView ? 1 : 0]);
        return { items: rows.slice(0, 50).map(r => ({ ...r, event: parse(r.event_json), trace: parse(r.trace_json), event_json: undefined, trace_json: undefined })), nextCursor: rows.length > 50 ? rows[49].id : null };
    }
    return { list, detail, change, excluded };
}
module.exports = { createHistory, formatJob, version };
