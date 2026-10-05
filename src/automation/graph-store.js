'use strict';

// Storage primitives only. Do not route live notifications here until the
// completion-aware executor and membership-aware transport are integrated.
const { randomUUID } = require('node:crypto');
const { hash } = require('./service');
const { copyData } = require('./graph-plan');
const MINUTE = 60000;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const uuid = value => { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const fault = code => Object.assign(new Error(code), { code });
function namespaceKey(context) {
    if (!context || !['private', 'guild'].includes(context.scope) || !context.ownerUserId || !context.workflowId || !Number.isSafeInteger(context.revision) || context.revision < 1 || context.scope === 'guild' && !context.guildId) throw fault('FLOW_NAMESPACE_INVALID');
    return hash(JSON.stringify([2, context.ownerUserId, context.scope, context.scope === 'guild' ? context.guildId : null, context.workflowId, context.revision]));
}
function encode(value) {
    // Reject getters, cycles and oversized trees before JSON allocation; the
    // same materialization contract applies to the pure kernel and storage.
    const text = JSON.stringify(copyData(value));
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw fault('FLOW_SNAPSHOT_LIMIT');
    return text;
}
function createGraphStore(db) {
    async function locked(namespace, work) {
        if (!/^[a-f0-9]{64}$/.test(namespace || '')) throw fault('FLOW_NAMESPACE_INVALID');
        // These public primitives own a top-level transaction. A future source
        // handoff must expose an explicit in-transaction variant, not nest this
        // retry loop inside a transaction owned by another service.
        for (let attempt = 0; ; attempt++) {
            try {
                return await db.withDatabaseTransaction(async query => {
                    // INSERT IGNORE takes a shared duplicate-key lock; two
                    // workers then upgrading to FOR UPDATE can deadlock. The
                    // no-op upsert obtains the exclusive namespace lock directly.
                    await query('INSERT INTO automation_flow_locks (namespace_key) VALUES (?) ON DUPLICATE KEY UPDATE namespace_key=VALUES(namespace_key)', [namespace]);
                    return work(query);
                });
            } catch (error) {
                // Retry only a known server rollback, never an uncertain COMMIT
                // or connection failure. Emissions have deterministic identities.
                if (error.code !== 'ER_LOCK_DEADLOCK' || attempt >= 2) throw error;
            }
        }
    }
    async function putUnit(query, namespace, unit, now) {
        if (!unit || !['event', 'batch', 'fragment'].includes(unit.kind) || !Array.isArray(unit.members) || !unit.members.length || unit.members.length > 10000 || new Set(unit.members.map(member => member.id)).size !== unit.members.length) throw fault('FLOW_UNIT_INVALID');
        for (const member of unit.members) if (!/^[a-zA-Z0-9_-]{1,64}$/.test(member.id || '') || !/^[a-f0-9-]{36}$/.test(member.runId || '')) throw fault('FLOW_MEMBER_INVALID');
        const runIds = [...new Set(unit.members.map(member => member.runId))].sort();
        const runs = await query('SELECT run_id,namespace_key FROM automation_flow_runs WHERE run_id IN (?)', [runIds]);
        if (runs.length !== runIds.length || runs.some(row => row.namespace_key !== namespace)) throw fault('FLOW_MEMBER_NAMESPACE');
        const body = encode(unit), checksum = hash(body);
        const rows = await query('SELECT checksum FROM automation_flow_units WHERE id=?', [unit.id]);
        if (rows.length) {
            if (rows[0].checksum !== checksum) throw fault('FLOW_UNIT_CONFLICT');
            return unit.id;
        }
        await query('INSERT INTO automation_flow_units (id,namespace_key,kind,payload_json,checksum,created_at_ms) VALUES (?,?,?,?,?,?)', [unit.id, namespace, unit.kind, body, checksum, now]);
        for (let index = 0; index < unit.members.length; index++) {
            const member = unit.members[index];
            await query('INSERT INTO automation_flow_members (unit_id,member_id,run_id,ordinal) VALUES (?,?,?,?)', [unit.id, member.id, member.runId, index]);
        }
        return unit.id;
    }
    async function putStep(query, namespace, key, nodeId, unitId, viaEdgeId, due, now) {
        const activationKey = hash(key), id = uuid(`step:${key}`);
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(nodeId || '') || !Number.isFinite(due)) throw fault('FLOW_STEP_INVALID');
        await query('INSERT IGNORE INTO automation_flow_steps (id,activation_key,namespace_key,node_id,input_unit_id,via_edge_id,wake_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [id, activationKey, namespace, nodeId, unitId, viaEdgeId || null, due, now, now]);
        const stored = (await query('SELECT namespace_key,node_id,input_unit_id,via_edge_id FROM automation_flow_steps WHERE id=?', [id]))[0];
        if (stored.namespace_key !== namespace || stored.node_id !== nodeId || stored.input_unit_id !== unitId || stored.via_edge_id !== (viaEdgeId || null)) throw fault('FLOW_STEP_CONFLICT');
        return id;
    }
    async function initializeQuery(query, { runId, context, unit, nodeId = 'start', now }) {
        const namespace = namespaceKey(context);
        // This upsert is also the namespace lock. Callers already inside an
        // outer source-delivery transaction use initializeInTransaction so the
        // legacy handoff and first graph activation cannot tear apart.
        await query('INSERT INTO automation_flow_locks (namespace_key) VALUES (?) ON DUPLICATE KEY UPDATE namespace_key=VALUES(namespace_key)', [namespace]);
        const source = (await query('SELECT owner_user_id,guild_id,scope,workflow_id,revision FROM automation_runs WHERE id=? FOR UPDATE', [runId]))[0];
        if (!source || source.owner_user_id !== context.ownerUserId || source.scope !== context.scope || source.scope === 'guild' && source.guild_id !== context.guildId || source.workflow_id !== context.workflowId || Number(source.revision) !== context.revision) throw fault('FLOW_ORIGIN_MISMATCH');
        const previous = await query('SELECT * FROM automation_flow_runs WHERE run_id=?', [runId]);
        const contextJson = encode(context);
        if (previous.length && (previous[0].namespace_key !== namespace || previous[0].context_json !== contextJson)) throw fault('FLOW_RUN_CONFLICT');
        if (!previous.length) await query('INSERT INTO automation_flow_runs (run_id,namespace_key,context_json) VALUES (?,?,?)', [runId, namespace, contextJson]);
        const initial = { ...unit, id: uuid(`initial:${runId}`) };
        if (initial.members.some(member => member.runId !== runId)) throw fault('FLOW_ORIGIN_MISMATCH');
        await putUnit(query, namespace, initial, now);
        const stepId = await putStep(query, namespace, `initial:${runId}`, nodeId, initial.id, null, now, now);
        return { namespace, unitId: initial.id, stepId };
    }
    async function initialize(input) {
        const namespace = namespaceKey(input.context);
        return locked(namespace, query => initializeQuery(query, input));
    }
    async function readUnit(query, unitId, eligibleOnly = false) {
        const row = (await query('SELECT * FROM automation_flow_units WHERE id=?', [unitId]))[0];
        if (!row || hash(row.payload_json) !== row.checksum) throw fault('FLOW_UNIT_CORRUPT');
        const unit = parse(row.payload_json);
        if (!eligibleOnly) return unit;
        const revoked = await query('SELECT DISTINCT r.run_id FROM automation_flow_members m JOIN automation_flow_runs r ON r.run_id=m.run_id WHERE m.unit_id=? AND r.revoked_at_ms IS NOT NULL', [unitId]);
        const ids = new Set(revoked.map(item => item.run_id));
        return { ...unit, members: unit.members.filter(member => !ids.has(member.runId)) };
    }
    async function claim(now) {
        const candidates = await db.queryDatabase("SELECT id,namespace_key FROM automation_flow_steps WHERE (state='pending' AND wake_at_ms<=?) OR (state='leased' AND lease_until_ms<=?) ORDER BY wake_at_ms,id LIMIT 1", [now, now]);
        if (!candidates.length) return null;
        return locked(candidates[0].namespace_key, async query => {
            const row = (await query('SELECT * FROM automation_flow_steps WHERE id=? FOR UPDATE', [candidates[0].id]))[0];
            if (!row || !(row.state === 'pending' && Number(row.wake_at_ms) <= now || row.state === 'leased' && Number(row.lease_until_ms) <= now)) return null;
            const token = randomUUID(), evaluatedAt = row.evaluation_at_ms == null ? now : Number(row.evaluation_at_ms);
            await query("UPDATE automation_flow_steps SET state='leased',lease_token=?,lease_until_ms=?,evaluation_at_ms=?,version=version+1,updated_at_ms=? WHERE id=?", [token, now + 120000, evaluatedAt, now, row.id]);
            return { ...row, state: 'leased', lease_token: token, lease_until_ms: now + 120000, evaluation_at_ms: evaluatedAt, version: Number(row.version) + 1, unit: await readUnit(query, row.continuation_unit_id || row.input_unit_id, true) };
        });
    }
    async function owned(query, step, now) {
        const row = (await query('SELECT * FROM automation_flow_steps WHERE id=? FOR UPDATE', [step.id]))[0];
        if (row && row.namespace_key !== step.namespace_key) return { lost: true };
        if (row && ['complete', 'excluded', 'aggregating'].includes(row.state)) return { done: true, row };
        if (!row || row.namespace_key !== step.namespace_key || row.state !== 'leased' || row.lease_token !== step.lease_token || Number(row.lease_until_ms) <= now) return { lost: true };
        return { row };
    }
    async function finish(query, row, state, decision, now, wakeAtMs = null) {
        await query('UPDATE automation_flow_steps SET state=?,decision_json=?,wake_at_ms=COALESCE(?,wake_at_ms),evaluation_at_ms=IF(?=\'pending\',NULL,evaluation_at_ms),lease_token=NULL,lease_until_ms=0,updated_at_ms=? WHERE id=?', [state, encode(decision), wakeAtMs, state, now, row.id]);
        await query('UPDATE automation_flow_runs r JOIN automation_flow_members m ON m.run_id=r.run_id SET r.needs_sync=1 WHERE m.unit_id=?', [row.input_unit_id]);
    }
    async function successors(query, row, transition, now) {
        const emitted = [];
        for (let index = 0; index < (transition.outputs || []).length; index++) {
            const output = transition.outputs[index], unit = { ...output.unit, id: uuid(`output:${row.id}:${index}`) };
            await putUnit(query, row.namespace_key, unit, now);
            const next = [];
            if (output.resumeNodeId) next.push(await putStep(query, row.namespace_key, `partition:${row.id}:${index}`, output.resumeNodeId, unit.id, row.via_edge_id, output.wakeAtMs ?? now, now));
            for (const edge of output.edges || []) {
                const nextId = await putStep(query, row.namespace_key, `successor:${row.id}:${index}:${edge.id}`, edge.target, unit.id, edge.id, output.wakeAtMs ?? now, now);
                next.push(nextId);
                for (const runId of [...new Set(unit.members.map(member => member.runId))]) await receipt(query, row, { runId, edgeId: edge.id, kind: 'data', unitId: unit.id }, now);
            }
            emitted.push({ unitId: unit.id, stepIds: next });
        }
        for (const edge of transition.closedEdges || []) await receipt(query, row, { ...edge, kind: 'closed', unitId: null }, now);
        return emitted;
    }
    async function receipt(query, row, value, now) {
        const key = hash(JSON.stringify([row.namespace_key, value.runId, value.edgeId, value.kind, value.kind === 'closed' ? null : value.unitId]));
        await query('INSERT IGNORE INTO automation_flow_edges (receipt_key,namespace_key,run_id,edge_id,activation_id,receipt_kind,unit_id,created_at_ms) VALUES (?,?,?,?,?,?,?,?)', [key, row.namespace_key, value.runId, value.edgeId, row.id, value.kind, value.unitId, now]);
    }
    async function settle(step, transition, now) {
        return locked(step.namespace_key, async query => {
            const current = await owned(query, step, now);
            if (current.lost) return { state: 'lease_lost' };
            if (current.done) return { state: 'already_settled', decision: parse(current.row.decision_json) };
            const row = current.row, eligible = await readUnit(query, row.continuation_unit_id || row.input_unit_id, true);
            if (!eligible.members.length) { await successors(query, row, { closedEdges: transition.closedEdges }, now); await finish(query, row, 'excluded', { code: 'ALL_MEMBERS_REVOKED' }, now); return { state: 'excluded' }; }
            const currentIds = new Set(eligible.members.map(member => member.id));
            for (const output of transition.outputs || []) if (output.unit.members.some(member => !currentIds.has(member.id))) throw fault('FLOW_STALE_MEMBERSHIP');
            if (transition.state === 'wait') {
                if (!Number.isFinite(transition.wakeAtMs) || transition.wakeAtMs <= now) throw fault('FLOW_WAIT_INVALID');
                if (transition.continuation) {
                    if (transition.continuation.members.some(member => !currentIds.has(member.id))) throw fault('FLOW_STALE_MEMBERSHIP');
                    const continuation = { ...transition.continuation, id: uuid(`continuation:${row.id}:${row.version}`) };
                    await putUnit(query, row.namespace_key, continuation, now);
                    await query('UPDATE automation_flow_steps SET continuation_unit_id=? WHERE id=?', [continuation.id, row.id]);
                }
                for (const edge of transition.closedEdges || []) await receipt(query, row, { ...edge, kind: 'closed', unitId: null }, now);
                await finish(query, row, 'pending', transition.decision || {}, now, transition.wakeAtMs);
                return { state: 'pending', wakeAtMs: transition.wakeAtMs };
            }
            if (transition.gate) {
                const gate = transition.gate;
                if (!Number.isSafeInteger(gate.count) || gate.count < 1 || !Number.isSafeInteger(gate.minutes) || gate.minutes < 1 || !['drop', 'defer'].includes(gate.overflow)) throw fault('FLOW_GATE_INVALID');
                const window = Math.floor(now / (gate.minutes * MINUTE)), until = (window + 1) * gate.minutes * MINUTE;
                const counterKey = hash(JSON.stringify(['flow-limit-v2', row.namespace_key, row.node_id, gate.key, window]));
                await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,?)', [counterKey, until]);
                const used = Number((await query('SELECT used_count FROM automation_counters WHERE counter_key=? FOR UPDATE', [counterKey]))[0].used_count);
                if (used >= gate.count) {
                    const deferred = gate.overflow === 'defer', decision = { code: deferred ? 'RATE_GATE_DEFERRED' : 'RATE_GATE_LIMIT', counterKey };
                    if (!deferred) await successors(query, row, { closedEdges: transition.closedEdges }, now);
                    await finish(query, row, deferred ? 'pending' : 'excluded', decision, now, deferred ? until : null);
                    return { state: deferred ? 'pending' : 'excluded', wakeAtMs: deferred ? until : null };
                }
                await query('UPDATE automation_counters SET used_count=used_count+1 WHERE counter_key=?', [counterKey]);
            }
            const emitted = await successors(query, row, transition, now);
            await finish(query, row, transition.state === 'excluded' ? 'excluded' : 'complete', { ...transition.decision, emitted }, now);
            return { state: transition.state === 'excluded' ? 'excluded' : 'complete', emitted };
        });
    }
    async function revokeRun(runId, code, now) {
        const origin = (await db.queryDatabase('SELECT namespace_key FROM automation_flow_runs WHERE run_id=?', [runId]))[0];
        if (!origin) return false;
        return locked(origin.namespace_key, async query => {
            const result = await query('UPDATE automation_flow_runs SET revoked_at_ms=COALESCE(revoked_at_ms,?),revocation_code=COALESCE(revocation_code,?),needs_sync=1 WHERE run_id=?', [now, String(code).slice(0, 96), runId]);
            return Number(result.affectedRows) > 0;
        });
    }
    async function admitBatch(step, config, groups, now) {
        if (!Number.isSafeInteger(config.minutes) || config.minutes < 1 || !Number.isSafeInteger(config.maxItems) || config.maxItems < 1 || config.maxItems > 100 || !['all', 'latest'].includes(config.mode) || !Array.isArray(groups) || !groups.length) throw fault('FLOW_BATCH_INVALID');
        return locked(step.namespace_key, async query => {
            const current = await owned(query, step, now);
            if (current.lost) return { state: 'lease_lost' };
            if (current.done) return { state: 'already_settled', decision: parse(current.row.decision_json) };
            const row = current.row, eligible = await readUnit(query, row.continuation_unit_id || row.input_unit_id, true), currentIds = new Set(eligible.members.map(member => member.id));
            const groupMembers = groups.flatMap(group => group.unit.members.map(member => member.id));
            if (new Set(groupMembers).size !== groupMembers.length) throw fault('FLOW_PARTITION_OVERLAP');
            const batches = [], width = config.minutes * MINUTE, starts = Math.floor(now / width) * width;
            for (let index = 0; index < groups.length; index++) {
                const group = groups[index];
                if (!group.unit.members.length || group.unit.members.some(member => !currentIds.has(member.id))) throw fault('FLOW_STALE_MEMBERSHIP');
                const keyJson = encode(group.key), key = hash(JSON.stringify([row.namespace_key, row.node_id, group.key, starts]));
                const recent = (await query('SELECT * FROM automation_flow_batches WHERE group_key=? ORDER BY segment DESC LIMIT 1', [key]))[0];
                let batch = recent;
                if (!batch || batch.state !== 'open' || Number(batch.received_count) >= config.maxItems) {
                    const segment = recent ? Number(recent.segment) + 1 : 0, id = uuid(`batch:${key}:${segment}`);
                    await query('INSERT INTO automation_flow_batches (id,namespace_key,group_key,segment,node_id,key_json,window_start_ms,closes_at_ms,max_items,mode,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, row.namespace_key, key, segment, row.node_id, keyJson, starts, starts + width, config.maxItems, config.mode, now, now]);
                    batch = { id, received_count: 0 };
                } else if (batch.mode !== config.mode || Number(batch.max_items) !== config.maxItems) throw fault('FLOW_BATCH_CONFIG_CONFLICT');
                const input = { ...group.unit, id: uuid(`batch-input:${row.id}:${index}`) }, ordinal = Number(batch.received_count);
                await putUnit(query, row.namespace_key, input, now);
                await query('INSERT INTO automation_flow_batch_inputs (admission_key,batch_id,activation_id,input_unit_id,ordinal,created_at_ms) VALUES (?,?,?,?,?,?)', [hash(`batch-admission:${row.id}:${index}`), batch.id, row.id, input.id, ordinal, now]);
                await query('UPDATE automation_flow_batches SET received_count=received_count+1,updated_at_ms=? WHERE id=?', [now, batch.id]);
                batches.push(batch.id);
            }
            await finish(query, row, 'aggregating', { batches }, now);
            return { state: 'aggregating', batches };
        });
    }
    async function dueBatch(now) {
        return (await db.queryDatabase("SELECT * FROM automation_flow_batches WHERE state='open' AND closes_at_ms<=? ORDER BY closes_at_ms,id LIMIT 1", [now]))[0] || null;
    }
    async function parkMerge(step, now) {
        return locked(step.namespace_key, async query => {
            const current = await owned(query, step, now);
            if (current.lost) return { state: 'lease_lost' };
            if (current.done) return { state: 'already_settled' };
            await finish(query, current.row, 'joining', { code: 'WAIT_FOR_PATH_COMPLETION' }, now);
            return { state: 'joining' };
        });
    }
    async function closeBatch(batch, edges, now) {
        return locked(batch.namespace_key, async query => {
            const row = (await query('SELECT * FROM automation_flow_batches WHERE id=? FOR UPDATE', [batch.id]))[0];
            if (!row || row.namespace_key !== batch.namespace_key) throw fault('FLOW_BATCH_MISSING');
            if (row.state !== 'open') return { state: 'already_sealed', unitId: row.output_unit_id, outcome: parse(row.outcome_json) };
            if (Number(row.closes_at_ms) > now) return { state: 'waiting', wakeAtMs: Number(row.closes_at_ms) };
            const inputs = await query('SELECT * FROM automation_flow_batch_inputs WHERE batch_id=? ORDER BY ordinal', [row.id]);
            const eligible = [], excluded = [], affectedRuns = new Set();
            for (const input of inputs) {
                const snapshot = await readUnit(query, input.input_unit_id), unit = await readUnit(query, input.input_unit_id, true);
                for (const member of snapshot.members) affectedRuns.add(member.runId);
                const retained = unit.members.filter(member => now <= Math.min(member.deadlineMs ?? Infinity, member.scheduleDeadlineMs ?? Infinity));
                const ids = new Set(retained.map(member => member.id));
                excluded.push(...snapshot.members.filter(member => !ids.has(member.id)).map(member => ({ memberId: member.id, runId: member.runId, inputUnitId: unit.id, code: unit.members.some(item => item.id === member.id) ? 'DEADLINE_EXCEEDED' : 'MONITOR_CHANGED' })));
                if (retained.length) eligible.push({ ...input, unit: { ...unit, members: retained } });
            }
            const selected = row.mode === 'latest' ? eligible.slice(-1) : eligible;
            const members = selected.flatMap(input => input.unit.members.map(member => ({ ...member, id: hash(JSON.stringify([row.id, input.ordinal, member.id])), lineageId: member.lineageId || member.id })));
            let unitId = null;
            const steps = [];
            if (members.length) {
                const unit = { id: uuid(`sealed:${row.id}`), kind: 'batch', members, ancestry: [...new Map(selected.flatMap(input => input.unit.ancestry || []).map(item => [encode(item), item])).values(), { batchId: row.id, nodeId: row.node_id }],
                    batchInputs: selected.map(input => ({ unitId: input.input_unit_id, ordinal: Number(input.ordinal) })), receivedCount: Number(row.received_count) };
                unitId = await putUnit(query, row.namespace_key, unit, now);
                for (const edge of edges) {
                    steps.push(await putStep(query, row.namespace_key, `batch-output:${row.id}:${edge.id}`, edge.target, unitId, edge.id, now, now));
                    for (const runId of [...new Set(members.map(member => member.runId))]) {
                        const input = selected.find(item => item.unit.members.some(member => member.runId === runId));
                        await receipt(query, { ...row, id: input.activation_id }, { runId, edgeId: edge.id, kind: 'data', unitId }, now);
                    }
                }
            }
            const outcome = { receivedCount: Number(row.received_count), retainedInputs: selected.length, retainedMembers: members.length, excluded, runIds: [...affectedRuns],
                supersededInputs: row.mode === 'latest' ? eligible.slice(0, -1).map(input => input.input_unit_id) : [] };
            await query('UPDATE automation_flow_batches SET state=?,output_unit_id=?,outcome_json=?,updated_at_ms=? WHERE id=?', [unitId ? 'sealed' : 'empty', unitId, encode(outcome), now, row.id]);
            for (const id of [...new Set(inputs.map(input => input.activation_id))]) {
                const open = await query("SELECT b.id FROM automation_flow_batch_inputs i JOIN automation_flow_batches b ON b.id=i.batch_id WHERE i.activation_id=? AND b.state='open' LIMIT 1", [id]);
                if (!open.length) {
                    const activation = (await query('SELECT * FROM automation_flow_steps WHERE id=? FOR UPDATE', [id]))[0];
                    await query("UPDATE automation_flow_steps SET state='complete',updated_at_ms=? WHERE id=? AND state='aggregating'", [now, id]);
                    // A sealed aggregate has emitted every segment originating
                    // from this activation. Close its graph edges now, not when
                    // the first segment seals, so another segment cannot be
                    // mistaken for an absent merge path.
                    if (activation) {
                        const source = await readUnit(query, activation.continuation_unit_id || activation.input_unit_id);
                        for (const edge of edges || []) for (const runId of [...new Set(source.members.map(member => member.runId))]) await receipt(query, activation, { runId, edgeId: edge.id, kind: 'closed', unitId: null }, now);
                    }
                }
            }
            if (affectedRuns.size) await query('UPDATE automation_flow_runs SET needs_sync=1 WHERE run_id IN (?)', [[...affectedRuns]]);
            return { state: unitId ? 'sealed' : 'empty', unitId, stepIds: steps, outcome };
        });
    }
    async function recordSend(step, unit, destination, now) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(destination || '')) throw fault('FLOW_DESTINATION_INVALID');
        return locked(step.namespace_key, async query => {
            const current = await owned(query, step, now);
            if (current.lost) return { state: 'lease_lost' };
            if (current.done) return { state: 'already_settled', decision: parse(current.row.decision_json) };
            const row = current.row, eligible = await readUnit(query, row.continuation_unit_id || row.input_unit_id, true), ids = new Set(eligible.members.map(member => member.id));
            if (unit.members.some(member => !ids.has(member.id))) throw fault('FLOW_STALE_MEMBERSHIP');
            const output = { ...unit, id: uuid(`send-unit:${row.id}`) }, id = uuid(`send-intent:${row.id}`);
            await putUnit(query, row.namespace_key, output, now);
            await query('INSERT INTO automation_flow_sends (id,activation_id,namespace_key,unit_id,destination_alias,created_at_ms) VALUES (?,?,?,?,?,?)', [id, row.id, row.namespace_key, output.id, destination, now]);
            await finish(query, row, 'complete', { sendIntentId: id }, now);
            return { state: 'unprojected', id };
        });
    }
    async function synchronizationBatch() {
        const first = (await db.queryDatabase('SELECT namespace_key FROM automation_flow_runs WHERE needs_sync=1 ORDER BY namespace_key,run_id LIMIT 1'))[0];
        if (!first) return null;
        const rows = await db.queryDatabase('SELECT run_id FROM automation_flow_runs WHERE needs_sync=1 AND namespace_key=? ORDER BY run_id LIMIT 1000', [first.namespace_key]);
        return { namespace: first.namespace_key, runIds: rows.map(row => row.run_id) };
    }
    const joins = require('./graph-join-store').createJoinStore({ db, locked, putUnit, putStep, receipt, readUnit, uuid, encode, fault });
    return { initialize, initializeInTransaction: initializeQuery, claim, settle, admitBatch, dueBatch, closeBatch, parkMerge, recordSend, synchronizationBatch, revokeRun, ...joins, readUnit: (id, eligibleOnly = false) => readUnit(db.queryDatabase, id, eligibleOnly) };
}
module.exports = { createGraphStore, namespaceKey, uuid };
