'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const { assertWorkflow, newWorkflow } = require('./schema');
const { validateDictionary } = require('./dictionary');
const compress = promisify(gzip), decompress = promisify(gunzip);
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const TABLES = { workflow: 'automation_workflows', dictionary: 'automation_dictionaries', destination: 'automation_destinations' };
let dictionaryValidator;

class AutomationError extends Error {
    constructor(code, message, status = 400) { super(message); this.name = 'AutomationError'; this.code = code; this.status = status; }
}
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
function requireActor(actor) {
    if (!/^\d{1,32}$/.test(actor?.userId || '')) fail('AUTH_REQUIRED', 'ログインが必要です。', 401);
}
function assertAccess(actor, row, write = false) {
    requireActor(actor);
    if (!row || row.deleted_at_ms) fail('NOT_FOUND', '対象が見つかりません。', 404);
    if (row.scope === 'private') {
        if (String(row.owner_user_id) !== actor.userId) fail('NOT_FOUND', '対象が見つかりません。', 404);
    } else if (row.scope !== 'guild' || row.guild_id !== actor.guildId || !(write ? actor.canEdit : actor.canView)) fail('FORBIDDEN', 'このサーバーの操作権限がありません。', 403);
}
function scopeFor(actor, scope) {
    requireActor(actor);
    if (!['private', 'guild'].includes(scope)) fail('INVALID_SCOPE', '公開範囲が不正です。');
    if (scope === 'guild' && (!actor.guildId || !actor.canEdit)) fail('FORBIDDEN', 'サーバー編集権限が必要です。', 403);
    return { scope, owner_user_id: actor.userId, guild_id: scope === 'guild' ? actor.guildId : null };
}
function publicWorkflow(row) {
    return { id: row.id, scope: row.scope, ownerId: row.owner_user_id, guildId: row.guild_id, name: row.name,
        revision: Number(row.revision), activeRevision: row.active_revision == null ? null : Number(row.active_revision), enabled: !!row.enabled,
        draft: parse(row.draft_json), bindings: parse(row.draft_bindings_json), updatedAtMs: Number(row.updated_at_ms) };
}
function publicDestination(row) {
    return { id: row.id, name: row.name, scope: row.scope, kind: row.kind, channelId: row.channel_id, guildId: row.guild_id,
        enabled: !!row.enabled, revision: Number(row.revision), createdByBot: !!row.created_by_bot };
}
function safeName(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 120) fail('NAME_REQUIRED', '名前は1〜120文字です。');
    return value.trim();
}

function createService(db) {
    async function audit(query, actor, id, action, detail, guildId) {
        // Only bounded IDs/revisions/hashes enter this log; no endpoint URLs or
        // dictionary text. Definitions are in explicitly authorized resources.
        await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,?,?,?,?,?)',
            [actor.userId, id, guildId || null, action, JSON.stringify(detail), Date.now()]);
    }
    async function getRow(kind, actor, id, write = false, query = db.queryDatabase, lock = false) {
        requireActor(actor);
        if (!TABLES[kind] || !/^[0-9a-f-]{36}$/i.test(id || '')) fail('NOT_FOUND', '対象が見つかりません。', 404);
        const rows = await query(`SELECT * FROM ${TABLES[kind]} WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [id]);
        assertAccess(actor, rows[0], write);
        return rows[0];
    }
    async function list(kind, actor, afterId = '', limit = 100) {
        requireActor(actor);
        if (!TABLES[kind]) fail('NOT_FOUND', '対象が見つかりません。', 404);
        const pageSize = Math.min(100, Math.max(1, Math.floor(Number(limit) || 100)));
        const rows = await db.queryDatabase(`SELECT * FROM ${TABLES[kind]} WHERE deleted_at_ms IS NULL AND id>? AND
            ((scope='private' AND owner_user_id=?) OR (scope='guild' AND guild_id=? AND ?=1)) ORDER BY id LIMIT ?`,
            [afterId, actor.userId, actor.guildId || null, actor.canView ? 1 : 0, pageSize + 1]);
        const selected = rows.slice(0, pageSize);
        const format = kind === 'workflow' ? publicWorkflow : kind === 'destination' ? publicDestination : row => ({ id: row.id, name: row.name, scope: row.scope, revision: Number(row.revision), entryCount: Number(row.entry_count) });
        return { items: selected.map(format), nextCursor: rows.length > pageSize ? selected.at(-1).id : null };
    }
    async function validateBindings(actor, workflow, bindings, query = db.queryDatabase, strict = false) {
        if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).some(k => !['destinations', 'dictionaries'].includes(k))) fail('INVALID_BINDINGS', '通知先・辞書の割り当てが不正です。');
        const safe = { destinations: Object.create(null), dictionaries: Object.create(null) };
        for (const [alias, id] of Object.entries(bindings.destinations || {})) {
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias) || ['constructor', 'prototype'].includes(alias)) fail('INVALID_BINDINGS', '通知先の名前が不正です。');
            const row = await getRow('destination', actor, id, true, query);
            safe.destinations[alias] = row.id;
        }
        for (const [alias, ref] of Object.entries(bindings.dictionaries || {})) {
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias) || ['constructor', 'prototype'].includes(alias) || !ref || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail('INVALID_BINDINGS', '辞書の名前・版が不正です。');
            const dictionary = await getRow('dictionary', actor, ref.id, false, query);
            const exists = await query('SELECT revision FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [dictionary.id, ref.revision]);
            if (!exists.length) fail('DICTIONARY_VERSION_MISSING', '辞書の版が見つかりません。');
            safe.dictionaries[alias] = { id: dictionary.id, revision: ref.revision };
        }
        if (strict) for (const node of workflow.nodes) {
            if (node.type === 'dictionary' && !safe.dictionaries[node.config.dictionary]) fail('DICTIONARY_REQUIRED', `辞書 ${node.config.dictionary} の割り当てが必要です。`);
            if (node.type === 'send' && node.config.destination !== 'default' && !safe.destinations[node.config.destination]) fail('DESTINATION_REQUIRED', `通知先 ${node.config.destination} の割り当てが必要です。`);
        }
        return safe;
    }
    async function saveWorkflowRevision(query, actor, id, revision, definition, bindings, now) {
        const body = JSON.stringify(definition), refs = JSON.stringify(bindings), checksum = hash(body + refs);
        await query('INSERT IGNORE INTO automation_revisions (workflow_id,revision,definition_json,bindings_json,checksum,actor_user_id,created_at_ms) VALUES (?,?,?,?,?,?,?)',
            [id, revision, body, refs, checksum, actor.userId, now]);
        const rows = await query('SELECT checksum,definition_json,bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [id, revision]);
        if (rows[0]?.checksum !== checksum || hash(rows[0].definition_json + rows[0].bindings_json) !== checksum) fail('REVISION_SNAPSHOT_CONFLICT', '保存済みの版と内容が一致しません。適用せずに停止しました。', 409);
    }
    async function createWorkflow(actor, input) {
        const owner = scopeFor(actor, input.scope || 'private');
        const definition = assertWorkflow(input.definition || newWorkflow());
        const bindings = await validateBindings(actor, definition, input.bindings || {});
        const id = randomUUID(), now = Date.now();
        await db.withDatabaseTransaction(async query => {
            await query('INSERT INTO automation_workflows (id,owner_user_id,guild_id,scope,name,draft_json,draft_bindings_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
                [id, owner.owner_user_id, owner.guild_id, owner.scope, definition.name, JSON.stringify(definition), JSON.stringify(bindings), now, now]);
            await saveWorkflowRevision(query, actor, id, 1, definition, bindings, now);
            await audit(query, actor, id, 'workflow.create', { revision: 1 }, owner.guild_id);
        });
        return getWorkflow(actor, id);
    }
    async function getWorkflow(actor, id) { return publicWorkflow(await getRow('workflow', actor, id)); }
    async function updateWorkflow(actor, id, input) {
        const definition = assertWorkflow(input.definition);
        return db.withDatabaseTransaction(async query => {
            const current = await getRow('workflow', actor, id, true, query, true);
            if (Number(current.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '別の変更が保存されています。再読み込みしてください。', 409);
            const bindings = await validateBindings(actor, definition, input.bindings || parse(current.draft_bindings_json), query);
            const now = Date.now(), revision = Number(current.revision) + 1;
            // Capture the current draft as well: installations from the early
            // schema retained only applied editions. Never invent overwritten
            // history, but do retain the edition that is still available now.
            await saveWorkflowRevision(query, actor, id, current.revision, parse(current.draft_json), parse(current.draft_bindings_json), now);
            await saveWorkflowRevision(query, actor, id, revision, definition, bindings, now);
            await query('UPDATE automation_workflows SET name=?,draft_json=?,draft_bindings_json=?,revision=revision+1,updated_at_ms=? WHERE id=?',
                [definition.name, JSON.stringify(definition), JSON.stringify(bindings), now, id]);
            await audit(query, actor, id, 'workflow.update', { before: Number(current.revision), after: Number(current.revision) + 1 }, current.guild_id);
            return { revision: Number(current.revision) + 1 };
        });
    }
    async function activateWorkflow(actor, id, input) {
        return db.withDatabaseTransaction(async query => {
            const row = await getRow('workflow', actor, id, true, query, true);
            if (Number(row.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '編集内容が変更されています。', 409);
            const definition = assertWorkflow(parse(row.draft_json));
            const bindings = await validateBindings(actor, definition, parse(row.draft_bindings_json), query, true);
            // Shared workflows cannot smuggle a personal DM destination or
            // private dictionary to other editors through resource bindings.
            if (row.scope === 'guild') {
                for (const resourceId of Object.values(bindings.destinations)) {
                    const resource = await getRow('destination', actor, resourceId, true, query);
                    if (resource.scope !== 'guild' || resource.guild_id !== row.guild_id) fail('PRIVATE_BINDING', '共有ルールでは同じサーバーの共有通知先を使ってください。');
                }
                for (const resource of Object.values(bindings.dictionaries)) {
                    const dictionary = await getRow('dictionary', actor, resource.id, false, query);
                    if (dictionary.scope !== 'guild' || dictionary.guild_id !== row.guild_id) fail('PRIVATE_BINDING', '共有ルールでは同じサーバーの共有辞書を使ってください。');
                }
            }
            await saveWorkflowRevision(query, actor, id, row.revision, definition, bindings, Date.now());
            await query('UPDATE automation_workflows SET active_revision=revision,enabled=1,updated_at_ms=? WHERE id=?', [Date.now(), id]);
            await audit(query, actor, id, 'workflow.activate', { revision: Number(row.revision) }, row.guild_id);
            return { activeRevision: Number(row.revision), enabled: true };
        });
    }
    async function setWorkflowState(actor, id, input) {
        return db.withDatabaseTransaction(async query => {
            const row = await getRow('workflow', actor, id, true, query, true);
            if (Number(row.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '編集内容が変更されています。', 409);
            if (input.enabled && !row.active_revision) fail('NOT_ACTIVE', 'ルールを適用してから有効にしてください。');
            await query('UPDATE automation_workflows SET enabled=?,revision=revision+1,updated_at_ms=? WHERE id=?', [input.enabled ? 1 : 0, Date.now(), id]);
            await audit(query, actor, id, 'workflow.state', { enabled: !!input.enabled }, row.guild_id);
            return { enabled: !!input.enabled, revision: Number(row.revision) + 1 };
        });
    }
    async function remove(kind, actor, id, expectedRevision) {
        return db.withDatabaseTransaction(async query => {
            const row = await getRow(kind, actor, id, true, query, true);
            if (Number(row.revision) !== expectedRevision) fail('REVISION_CONFLICT', '対象が更新されています。', 409);
            await query(`UPDATE ${TABLES[kind]} SET deleted_at_ms=?,revision=revision+1,updated_at_ms=? WHERE id=?`, [Date.now(), Date.now(), id]);
            if (kind === 'workflow') await query("UPDATE automation_jobs j JOIN automation_runs r ON r.id=j.run_id SET j.state='cancelled',j.updated_at_ms=? WHERE r.workflow_id=? AND j.state IN ('pending','held','leased','aggregated')", [Date.now(), id]);
            await audit(query, actor, id, `${kind}.delete`, { revision: expectedRevision }, row.guild_id);
            return { deleted: true };
        });
    }
    async function history(actor, id) {
        await getRow('workflow', actor, id);
        const rows = await db.queryDatabase('SELECT revision,checksum,actor_user_id,created_at_ms FROM automation_revisions WHERE workflow_id=? ORDER BY revision DESC LIMIT 100', [id]);
        return rows.map(r => ({ revision: Number(r.revision), checksum: r.checksum, actorId: r.actor_user_id, createdAtMs: Number(r.created_at_ms) }));
    }
    async function restoreRevision(actor, id, revision, expectedRevision) {
        await getRow('workflow', actor, id, true);
        const rows = await db.queryDatabase('SELECT definition_json,bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [id, revision]);
        if (!rows.length) fail('NOT_FOUND', '版が見つかりません。', 404);
        return updateWorkflow(actor, id, { expectedRevision, definition: parse(rows[0].definition_json), bindings: parse(rows[0].bindings_json) });
    }
    async function saveDictionary(actor, input, id = null) {
        if (id) await getRow('dictionary', actor, id, true); else scopeFor(actor, input.scope || 'private');
        const data = validateDictionary(input.dictionary);
        dictionaryValidator ||= require('./evaluation').createEvaluator(null);
        const analysis = await dictionaryValidator.dictionaryTask({ operation: 'analyze', dictionary: data, summaryOnly: true });
        if (analysis.conflictCount) fail('DICTIONARY_CONFLICT', '正規化後に同じ語となる、異なる設定が含まれています。');
        const bytes = Buffer.from(JSON.stringify(data));
        if (bytes.length > 128 * 1024 * 1024) fail('DICTIONARY_SIZE', '辞書サイズが上限を超えました。');
        const compressed = await compress(bytes), checksum = hash(bytes);
        return db.withDatabaseTransaction(async query => {
            let owner, revision = 1;
            const resourceId = id || randomUUID();
            if (id) {
                owner = await getRow('dictionary', actor, id, true, query, true);
                if (Number(owner.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '辞書が更新されています。', 409);
                revision = Number(owner.revision) + 1;
                await query('UPDATE automation_dictionaries SET name=?,revision=?,entry_count=?,updated_at_ms=? WHERE id=?', [data.name, revision, data.entries.length, Date.now(), id]);
            } else {
                owner = scopeFor(actor, input.scope || 'private');
                await query('INSERT INTO automation_dictionaries (id,owner_user_id,guild_id,scope,name,revision,entry_count,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
                    [resourceId, owner.owner_user_id, owner.guild_id, owner.scope, data.name, revision, data.entries.length, Date.now(), Date.now()]);
            }
            await query('INSERT INTO automation_dictionary_revisions (dictionary_id,revision,data_gzip,checksum,entry_count,source_text,license_text,created_at_ms) VALUES (?,?,?,?,?,?,?,?)',
                [resourceId, revision, compressed, checksum, data.entries.length, String(data.source || '').slice(0, 8000), String(data.license || '').slice(0, 8000), Date.now()]);
            await audit(query, actor, resourceId, 'dictionary.save', { revision, checksum, entryCount: data.entries.length }, owner.guild_id);
            return { id: resourceId, revision, checksum, entryCount: data.entries.length };
        });
    }
    async function getDictionary(actor, id, revision, offset = 0, count = 100, search = '') {
        const row = await getRow('dictionary', actor, id);
        const version = Number(revision || row.revision);
        const data = await dictionaryData(id, version);
        const needle = String(search || '').normalize('NFKC').toLowerCase();
        const filtered = needle ? data.entries.filter(e => (typeof e === 'string' ? e : e.term).normalize('NFKC').toLowerCase().includes(needle)) : data.entries;
        const at = Math.max(0, Math.floor(Number(offset) || 0)), size = Math.min(1000, Math.max(1, Math.floor(Number(count) || 100)));
        return { ...data, id, revision: version, entries: filtered.slice(at, at + size), total: filtered.length, offset: at, nextOffset: at + size < filtered.length ? at + size : null };
    }
    async function dictionaryData(id, revision) {
        const rows = await db.queryDatabase('SELECT data_gzip,checksum FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [id, revision]);
        if (!rows.length) fail('DICTIONARY_VERSION_MISSING', '辞書の版が見つかりません。', 404);
        const bytes = await decompress(rows[0].data_gzip, { maxOutputLength: 128 * 1024 * 1024 });
        if (hash(bytes) !== rows[0].checksum) fail('DICTIONARY_CHECKSUM', '辞書の整合性を確認できません。', 503);
        return validateDictionary(JSON.parse(bytes.toString('utf8')));
    }
    async function saveDestination(actor, input, verified = {}, id = null) {
        const owner = scopeFor(actor, input.scope || 'private');
        const name = safeName(input.name);
        if (!['dm', 'webhook', 'channel'].includes(input.kind)) fail('INVALID_DESTINATION', '通知先の種類が不正です。');
        if (input.kind === 'dm' && owner.scope !== 'private') fail('PRIVATE_DM', 'DM通知先は個人用です。');
        if (input.kind !== 'dm' && (!verified.webhookEndpointId || !verified.channelId || verified.guildId !== actor.guildId)) fail('DESTINATION_NOT_VERIFIED', '通知先の検証が必要です。');
        const resourceId = id || randomUUID();
        return db.withDatabaseTransaction(async query => {
            if (id) {
                const previous = await getRow('destination', actor, id, true, query, true);
                if (Number(previous.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '通知先が更新されています。', 409);
                if (previous.scope !== owner.scope) fail('SCOPE_IMMUTABLE', '公開範囲は変更できません。複製してください。');
                if (previous.kind !== (input.kind === 'dm' ? 'dm' : 'webhook') || previous.channel_id !== (verified.channelId || null) || String(previous.webhook_endpoint_id || '') !== String(verified.webhookEndpointId || '')) {
                    // Destination identity is immutable: editing a shared alias
                    // must never redirect another person's saved subscription.
                    fail('DESTINATION_IMMUTABLE', '送信先を変える場合は新しい通知先を作り、監視・ルールへ割り当ててください。');
                }
                await query('UPDATE automation_destinations SET name=?,enabled=?,revision=revision+1,updated_at_ms=? WHERE id=?',
                    [name, input.enabled === false ? 0 : 1, Date.now(), id]);
            } else await query('INSERT INTO automation_destinations (id,owner_user_id,guild_id,scope,name,kind,dm_user_id,webhook_endpoint_id,channel_id,created_by_bot,enabled,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [resourceId, actor.userId, input.kind === 'dm' ? null : actor.guildId, owner.scope, name, input.kind === 'dm' ? 'dm' : 'webhook', input.kind === 'dm' ? actor.userId : null, verified.webhookEndpointId || null, verified.channelId || null, verified.createdByBot ? 1 : 0, input.enabled === false ? 0 : 1, Date.now(), Date.now()]);
            await audit(query, actor, resourceId, 'destination.save', { kind: input.kind, channelId: verified.channelId || null }, actor.guildId);
            return { id: resourceId };
        });
    }
    async function attach(actor, workflowId, targetKind, targetId) {
        if (!['auto', 'price'].includes(targetKind) || !/^\d{1,20}$/.test(String(targetId))) fail('INVALID_TARGET', '監視IDが不正です。');
        return db.withDatabaseTransaction(async query => {
            const rule = await getRow('workflow', actor, workflowId, true, query, true);
            const rows = await query(`SELECT t.*,m.scope FROM ${targetKind === 'auto' ? 'auto_watch_targets' : 'price_watch_targets'} t LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id WHERE t.id=? FOR UPDATE`, [targetKind, String(targetId)]);
            const target = rows[0];
            const { assertMonitorAccess, scopeOf } = require('./monitors');
            assertMonitorAccess(actor, target, true);
            if (rule.scope !== scopeOf(target)) fail('TARGET_SCOPE', '監視とルールの公開範囲を一致させてください。');
            if (rule.scope === 'guild' && (target.guild_id !== rule.guild_id || target.destination_type === 'dm')) fail('TARGET_SCOPE', '共有ルールは同じサーバーの共有通知に割り当ててください。');
            if (rule.scope === 'private' && target.user_id !== actor.userId) fail('TARGET_SCOPE', '個人ルールは自分の監視に割り当ててください。');
            await query('INSERT INTO automation_assignments (target_kind,target_id,workflow_id,created_at_ms) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE workflow_id=VALUES(workflow_id)', [targetKind, String(targetId), workflowId, Date.now()]);
            await audit(query, actor, workflowId, 'workflow.attach', { targetKind, targetId: String(targetId) }, target.guild_id);
            return { attached: true };
        });
    }
    return { list, getRow, getWorkflow, createWorkflow, updateWorkflow, activateWorkflow, setWorkflowState, remove, history,
        restoreRevision, validateBindings, saveDictionary, getDictionary, dictionaryData, saveDestination, attach, audit };
}
module.exports = { createService, AutomationError, assertAccess, scopeFor, requireActor, hash, publicWorkflow, publicDestination };
