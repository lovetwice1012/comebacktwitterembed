'use strict';
const { AutomationError, hash } = require('./service');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const MAX_PROJECTION_BYTES = 4 * 1024 * 1024, PAGE_ENTRIES = 50, PAGE_BYTES = 256 * 1024;
const active = state => ['pending','leased','joining','aggregating'].includes(state);
const indexedTrace = trace => Array.isArray(trace) && trace.length === 1 && trace[0]?.traceIndex?.version === 1;
const changed = () => { throw new AutomationError('HISTORY_TRACE_CHANGED', '処理履歴が更新されました。先頭から読み直してください。', 409); };
const checkBody = (body, source) => { if (hash(body || '') !== source.stamp) changed(); return parse(body); };
const revision = (run, sources) => hash(JSON.stringify([run.id, run.owner_user_id, run.scope, run.guild_id, run.workflow_id, run.revision, run.state, sources]));

function traceProjection() {
    let entries = [], bytes = 2, count = 0, indexed = false, permanent = false, expired = false;
    const digest = require('node:crypto').createHash('sha256');
    return {
        push(...values) { for (const value of values) {
            const body = JSON.stringify(value); count++; digest.update(body).update('\n');
            permanent ||= require('./graph-failure').permanentFailure({ code: value.reason }); expired ||= value.outcome === 'expired';
            if (!indexed && bytes + Buffer.byteLength(body) + 1 <= MAX_PROJECTION_BYTES) { entries.push(value); bytes += Buffer.byteLength(body) + 1; }
            else if (!indexed) { indexed = true; entries = []; }
        } },
        get permanent() { return permanent; }, get expired() { return expired; },
        result() { return indexed ? [{ nodeId: 'history', outcome: 'indexed', traceIndex: { version: 1, projectedEntries: count, digest: digest.digest('hex') } }] : entries; },
    };
}

async function manifest(query, run) {
    const origin = (await query('SELECT namespace_key,revoked_at_ms,revocation_code FROM automation_flow_runs WHERE run_id=?', [run.id]))[0];
    if (!origin) {
        const legacy = (await query('SELECT trace_json FROM automation_runs WHERE id=?', [run.id]))[0];
        return [{ kind: 'legacy', id: run.id, stamp: hash(legacy?.trace_json || '[]') }];
    }
    // This is a read-only optimistic snapshot. Dashboard transactions acquire
    // mutation authority, so history must neither take a write lease nor lock
    // a graph writer. Check this metadata again after reading the page bodies.
    const sources = [];
    const steps = await query(`SELECT s.id,s.node_id,s.state,s.version,s.updated_at_ms,s.wake_at_ms,s.created_at_ms,SHA2(COALESCE(s.decision_json,''),256) AS stamp FROM automation_flow_steps s
        WHERE EXISTS (SELECT 1 FROM automation_flow_members m WHERE m.unit_id=s.input_unit_id AND m.run_id=?) ORDER BY s.created_at_ms,s.id`, [run.id]);
    for (const row of steps) sources.push({ kind: 'step', ...row });
    const batches = await query(`SELECT b.id,b.node_id,b.state,b.updated_at_ms,b.created_at_ms,SHA2(COALESCE(b.outcome_json,''),256) AS stamp FROM automation_flow_batches b
        WHERE b.state<>'open' AND EXISTS (SELECT 1 FROM automation_flow_batch_inputs i JOIN automation_flow_members m ON m.unit_id=i.input_unit_id WHERE i.batch_id=b.id AND m.run_id=?) ORDER BY b.created_at_ms,b.id`, [run.id]);
    for (const row of batches) sources.push({ kind: 'batch', ...row });
    const batchEdges = await query(`SELECT b.id,b.node_id,JSON_UNQUOTE(JSON_EXTRACT(b.outcome_json,'$.code')) AS code,COUNT(*) AS members,MAX(e.receipt_key) AS stamp FROM automation_flow_batches b
        JOIN automation_flow_batch_inputs i ON i.batch_id=b.id JOIN automation_flow_members m ON m.unit_id=i.input_unit_id
        JOIN automation_flow_edges e ON e.activation_id=i.activation_id AND e.unit_id=i.input_unit_id AND e.run_id=m.run_id AND e.edge_id=SHA2(CONCAT(b.id,':',m.member_id),256)
        WHERE m.run_id=? AND b.state<>'open' AND e.receipt_kind IN ('batch_changed','batch_expired','batch_failed') GROUP BY b.id,b.node_id,b.outcome_json ORDER BY b.id`, [run.id]);
    for (const row of batchEdges) sources.push({ kind: 'batchEdges', ...row });
    const failures = await query(`SELECT e.receipt_key AS id,e.unit_id,e.edge_id,s.node_id,(SELECT COUNT(*) FROM automation_flow_members m WHERE m.unit_id=e.unit_id AND m.run_id=e.run_id) AS members
        FROM automation_flow_edges e JOIN automation_flow_steps s ON s.id=e.activation_id WHERE e.run_id=? AND e.receipt_kind='step_failed' ORDER BY e.receipt_key`, [run.id]);
    for (const row of failures) sources.push({ kind: 'stepFailure', ...row });
    const merges = await query(`SELECT node_id,JSON_UNQUOTE(JSON_EXTRACT(decision_json,'$.code')) AS code,SHA2(decision_json,256) AS stamp FROM automation_flow_merge_decisions
        WHERE run_id=? AND state='excluded' AND JSON_UNQUOTE(JSON_EXTRACT(decision_json,'$.terminalFailure'))='true' ORDER BY node_id`, [run.id]);
    for (const row of merges) sources.push({ kind: 'mergeFailure', id: row.node_id, ...row });
    const sends = await query(`SELECT s.id,s.unit_id,s.state,s.activation_id,COALESCE(a.node_id,'send') AS node_id FROM automation_flow_sends s LEFT JOIN automation_flow_steps a ON a.id=s.activation_id
        WHERE EXISTS (SELECT 1 FROM automation_flow_members m WHERE m.unit_id=s.unit_id AND m.run_id=?) ORDER BY s.id`, [run.id]);
    const sendIds = new Set(sends.map(row => row.id));
    if (sends.length) {
        const jobs = await query(`SELECT j.id,j.state,j.updated_at_ms,j.attempts,SHA2(j.plan_json,256) AS stamp,JSON_UNQUOTE(JSON_EXTRACT(j.plan_json,'$.flowV2.sendId')) AS send_id FROM automation_jobs j
            WHERE j.execution_version=2 AND j.run_id IN (SELECT m.run_id FROM automation_flow_members m JOIN automation_flow_sends s ON s.unit_id=m.unit_id WHERE s.id IN (?)) ORDER BY j.id`, [[...sendIds]]);
        for (const row of jobs) if (sendIds.has(row.send_id)) sources.push({ kind: 'job', ...row });
    }
    if (origin.revoked_at_ms != null) sources.push({ kind: 'revoked', id: run.id, code: origin.revocation_code || 'RUN_REVOKED', at: String(origin.revoked_at_ms), node_id: steps[0]?.node_id || 'start' });
    for (const row of sends) if (['failed','cancelled','expired'].includes(row.state)) sources.push({ kind: 'send', ...row });
    return sources;
}

async function block(query, source, runId, position) {
    const own = entries => entries.filter(entry => !entry.runId || entry.runId === runId);
    let entries;
    if (source.kind === 'batchEdges') {
        if (typeof position !== 'string' || position && !/^[a-f0-9]{64}$/.test(position)) throw new AutomationError('INVALID_CURSOR', 'ページ位置を確認してください。');
        const rows = await query(`SELECT e.receipt_key,m.member_id,e.receipt_kind,i.input_unit_id FROM automation_flow_batch_inputs i JOIN automation_flow_members m ON m.unit_id=i.input_unit_id
            JOIN automation_flow_edges e ON e.activation_id=i.activation_id AND e.unit_id=i.input_unit_id AND e.run_id=m.run_id
                AND e.edge_id=SHA2(CONCAT(i.batch_id,':',m.member_id),256)
            WHERE i.batch_id=? AND m.run_id=? AND e.receipt_kind IN ('batch_changed','batch_expired','batch_failed') AND e.receipt_key>? ORDER BY e.receipt_key LIMIT 51`, [source.id, runId, position]);
        return { done: rows.length < 51, rows: rows.map(row => ({ next: row.receipt_key, entry: { nodeId: source.node_id, memberId: row.member_id, runId, inputUnitId: row.input_unit_id,
            outcome: row.receipt_kind === 'batch_expired' ? 'expired' : 'excluded', reason: row.receipt_kind === 'batch_expired' ? 'DEADLINE_EXCEEDED' : row.receipt_kind === 'batch_changed' ? 'MONITOR_CHANGED' : source.code || 'FLOW_UNIT_INVALID' } })) };
    }
    if (!Number.isSafeInteger(position) || position < 0) throw new AutomationError('INVALID_CURSOR', 'ページ位置を確認してください。');
    if (source.kind === 'stepFailure') {
        const rows = await query('SELECT member_id,ordinal FROM automation_flow_members WHERE unit_id=? AND run_id=? AND ordinal>=? ORDER BY ordinal LIMIT 51', [source.unit_id, runId, position]);
        return { done: rows.length < 51, rows: rows.map(row => ({ next: Number(row.ordinal) + 1, entry: { nodeId: source.node_id, memberId: row.member_id, runId, outcome: 'excluded', reason: source.edge_id.slice(37) } })) };
    }
    if (source.kind === 'step') {
        const row = (await query('SELECT decision_json FROM automation_flow_steps WHERE id=?', [source.id]))[0], decision = checkBody(row?.decision_json, source) || {};
        entries = own(decision.trace || []);
        if (!entries.length && !decision.terminalFailure && (decision.code || active(source.state))) entries = [{ nodeId: source.node_id, outcome: active(source.state) ? 'wait' : 'excluded', reason: decision.code || 'FLOW_WAITING', wakeAtMs: Number(source.wake_at_ms) }];
    } else if (source.kind === 'batch') {
        const row = (await query('SELECT outcome_json FROM automation_flow_batches WHERE id=?', [source.id]))[0];
        entries = (checkBody(row?.outcome_json, source)?.excluded || []).filter(entry => entry.runId === runId).map(entry => ({ ...entry, nodeId: source.node_id, outcome: entry.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'excluded', reason: entry.code }));
    } else if (source.kind === 'job') {
        const row = (await query('SELECT plan_json FROM automation_jobs WHERE id=?', [source.id]))[0];
        entries = (checkBody(row?.plan_json, source)?.flowV2?.excludedMembers || []).filter(entry => entry.runId === runId).map(entry => ({ ...entry, nodeId: 'send', outcome: entry.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'excluded', reason: entry.code }));
    } else if (source.kind === 'mergeFailure' || source.kind === 'revoked') entries = [{ nodeId: source.node_id, outcome: 'excluded', reason: source.code }];
    else if (source.kind === 'send') entries = [{ nodeId: source.node_id, outcome: source.state === 'expired' ? 'expired' : 'excluded', reason: source.state === 'failed' ? 'FLOW_DESTINATION_MISSING' : source.state === 'expired' ? 'DEADLINE_EXCEEDED' : 'ALL_MEMBERS_REVOKED' }];
    else { const row = (await query('SELECT trace_json FROM automation_runs WHERE id=?', [runId]))[0]; entries = checkBody(row?.trace_json || '[]', source) || []; if (!Array.isArray(entries) || indexedTrace(entries)) throw new Error('History source unavailable'); }
    return { done: position + 51 >= entries.length, rows: entries.slice(position, position + 51).map((entry, index) => ({ entry, next: position + index + 1 })) };
}

async function readTracePage(query, run, input = {}) {
    const sources = await manifest(query, run), sourceRevision = revision(run, sources);
    let sourceIndex = 0, position;
    if (input.cursor) {
        let cursor;
        try { if (typeof input.cursor !== 'string' || input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error('cursor'); cursor = JSON.parse(Buffer.from(input.cursor,'base64url').toString()); }
        catch { throw new AutomationError('INVALID_CURSOR', 'ページ位置を確認してください。'); }
        if (cursor.runId !== run.id || !/^[a-f0-9]{64}$/.test(cursor.revision || '') || !Number.isSafeInteger(cursor.source) || cursor.source < 0) throw new AutomationError('INVALID_CURSOR', 'ページ位置を確認してください。');
        if (cursor.revision !== sourceRevision) throw new AutomationError('HISTORY_TRACE_CHANGED', '処理履歴が更新されました。先頭から読み直してください。', 409);
        if (cursor.source >= sources.length) throw new AutomationError('INVALID_CURSOR', 'ページ位置を確認してください。');
        sourceIndex = cursor.source; position = cursor.position;
    }
    const items = [], provenance = []; let bytes = 2;
    while (sourceIndex < sources.length) {
        const source = sources[sourceIndex]; position ??= source.kind === 'batchEdges' ? '' : 0;
        const data = await block(query, source, run.id, position); let consumed = true;
        for (const row of data.rows) {
            const size = Buffer.byteLength(JSON.stringify(row.entry)) + 1;
            // One existing large entry remains accessible intact. Budgets
            // bound the page, never truncate a recorded diagnostic.
            if (items.length >= PAGE_ENTRIES || items.length && bytes + size > PAGE_BYTES) { consumed = false; break; }
            items.push(row.entry); provenance.push({ kind: source.kind, id: source.id, ...(row.entry.memberId ? { memberId: row.entry.memberId } : {}) }); bytes += size; position = row.next;
        }
        if (!consumed || !data.done) break;
        sourceIndex++; position = undefined;
        if (items.length >= PAGE_ENTRIES || bytes >= PAGE_BYTES) break;
    }
    const nextCursor = sourceIndex < sources.length ? Buffer.from(JSON.stringify({ runId: run.id, revision: sourceRevision, source: sourceIndex, position: position ?? (sources[sourceIndex].kind === 'batchEdges' ? '' : 0) })).toString('base64url') : null;
    if (revision(run, await manifest(query, run)) !== sourceRevision) changed();
    return { items, sources: provenance, sourceRevision, nextCursor, totalEntries: !input.cursor && !nextCursor ? items.length : null, complete: nextCursor === null };
}
module.exports = { traceProjection, indexedTrace, readTracePage, MAX_PROJECTION_BYTES };
