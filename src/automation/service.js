'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { createRateLimiter } = require('./rate-limits');
const { withRateOperation } = require('./rate-operation');
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
function validateAssignmentGuards(guards) {
    if (!guards || typeof guards !== 'object' || Array.isArray(guards)
        || Object.keys(guards).some(key => !['expectedRevision', 'expectedWorkflowId'].includes(key))
        || !Object.hasOwn(guards, 'expectedWorkflowId') || !Number.isSafeInteger(guards.expectedRevision) || guards.expectedRevision < 1
        || guards.expectedWorkflowId !== null && (typeof guards.expectedWorkflowId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(guards.expectedWorkflowId)))
        fail('INVALID_ASSIGNMENT_GUARD', '現在の監視設定と通知ルールを確認してください。');
    return { expectedRevision: guards.expectedRevision, expectedWorkflowId: guards.expectedWorkflowId };
}

/** @param {any} db @param {{rateLimiter?:any,rateOptions?:any,verifyChannel?:any,verifyWebhook?:any}} [options] */
function createService(db, options = {}) {
    const rateLimiter = options.rateLimiter || createRateLimiter(db, options.rateOptions);
    async function withOperation(actor, group, work) {
        requireActor(actor);
        return withRateOperation(db, actor, group, work, { rateLimiter });
    }
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
        const usedDestinations = new Set(workflow.nodes.filter(node => node.type === 'send' && node.config.destination !== 'default').map(node => node.config.destination));
        const usedDictionaries = new Set(workflow.nodes.filter(node => node.type === 'dictionary').map(node => node.config.dictionary));
        for (const [alias, id] of Object.entries(bindings.destinations || {})) {
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias) || ['constructor', 'prototype'].includes(alias)) fail('INVALID_BINDINGS', '通知先の名前が不正です。');
            if (!usedDestinations.has(alias)) continue;
            const row = await getRow('destination', actor, id, true, query);
            safe.destinations[alias] = row.id;
        }
        for (const [alias, ref] of Object.entries(bindings.dictionaries || {})) {
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias) || ['constructor', 'prototype'].includes(alias) || !ref || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail('INVALID_BINDINGS', '辞書の名前・版が不正です。');
            let dictionary;
            try { dictionary = await getRow('dictionary', actor, ref.id, false, query); }
            catch (error) {
                // Optional package dictionaries remain portable while readable.
                // A removed unused reference cannot block an unrelated edit or
                // restore; referenced dictionaries still require full access.
                if (!usedDictionaries.has(alias) && [403, 404].includes(error.status)) continue;
                throw error;
            }
            const exists = await query('SELECT revision FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [dictionary.id, ref.revision]);
            if (!exists.length) {
                if (!usedDictionaries.has(alias)) continue;
                fail('DICTIONARY_VERSION_MISSING', '辞書の版が見つかりません。');
            }
            safe.dictionaries[alias] = { id: dictionary.id, revision: ref.revision };
        }
        if (strict) for (const node of workflow.nodes) {
            if (node.type === 'dictionary' && !safe.dictionaries[node.config.dictionary]) fail('DICTIONARY_REQUIRED', `辞書 ${node.config.dictionary} の割り当てが必要です。`);
            if (node.type === 'send' && node.config.destination !== 'default' && !safe.destinations[node.config.destination]) fail('DESTINATION_REQUIRED', `通知先 ${node.config.destination} の割り当てが必要です。`);
        }
        return safe;
    }
    async function validateWorkflowDestinations(query, workflow, ownerIds, snapshot = null) {
        if (!ownerIds.length) return;
        if (!snapshot) {
            if (!workflow.active_revision) return;
            snapshot = (await query('SELECT definition_json,bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [workflow.id, workflow.active_revision]))[0];
            if (!snapshot) fail('NOT_ACTIVE', '適用済みのルールを確認できません。再度適用してください。');
        }
        const definition = assertWorkflow(parse(snapshot.definition_json)), bindings = parse(snapshot.bindings_json);
        const aliases = [...new Set(definition.nodes.filter(node => node.type === 'send' && node.config.destination !== 'default').map(node => node.config.destination))];
        for (const alias of aliases) {
            const id = bindings?.destinations?.[alias];
            if (!id) fail('DESTINATION_REQUIRED', `通知先 ${alias} の割り当てが必要です。`);
            const destination = (await query('SELECT * FROM automation_destinations WHERE id=? FOR UPDATE', [id]))[0];
            if (!destination || destination.deleted_at_ms) fail('NOT_FOUND', '通知先が見つかりません。', 404);
            if (!destination.enabled) fail('DESTINATION_DISABLED', '通知先を有効にしてから通知を再開してください。', 409);
            if (workflow.scope === 'guild' && (destination.scope !== 'guild' || destination.guild_id !== workflow.guild_id || destination.kind === 'dm')
                || workflow.scope === 'private' && destination.scope === 'private' && destination.owner_user_id !== workflow.owner_user_id)
                fail('PRIVATE_BINDING', 'ルールと同じ公開範囲の通知先を指定してください。');
            await validateDestinationOwners(destination, ownerIds, query);
        }
    }
    const destinationIdentity = row => JSON.stringify([row.id, Number(row.revision), row.scope, row.owner_user_id, row.guild_id, row.kind, row.channel_id, row.dm_user_id, row.webhook_endpoint_id, Number(row.enabled), row.deleted_at_ms]);
    async function validateDestinationOwners(destination, ownerIds, query = undefined) {
        if (!query) return db.withDatabaseTransaction(q => validateDestinationOwners(destination, ownerIds, q));
        if (!destination || destination.deleted_at_ms) fail('NOT_FOUND', '通知先が見つかりません。', 404);
        if (!destination.enabled) fail('DESTINATION_DISABLED', '通知先を有効にしてから通知を再開してください。', 409);
        const fresh = (await query('SELECT * FROM automation_destinations WHERE id=? FOR UPDATE', [destination.id]))[0];
        if (!fresh || fresh.deleted_at_ms) fail('NOT_FOUND', '通知先が見つかりません。', 404);
        if (destinationIdentity(fresh) !== destinationIdentity(destination)) fail('DESTINATION_CHANGED', '通知先が変更されています。設定を確認し直してください。', 409);
        const principals = [...new Set(ownerIds)];
        for (const ownerId of principals) {
            if (fresh.scope === 'private' && fresh.owner_user_id !== ownerId) fail('NOT_FOUND', '通知先が見つかりません。', 404);
            if (fresh.kind === 'dm' && fresh.dm_user_id !== ownerId) fail('DM_OWNER_MISMATCH', '登録した本人のDMを指定してください。', 403);
        }
        if (fresh.kind === 'dm') return;
        if (fresh.kind !== 'webhook') fail('INVALID_DESTINATION', '通知先を選び直してください。');
        const helpers = require('./destinations'), defaults = helpers.createDestinations(db, service);
        const verify = options.verifyChannel || defaults.verifyChannel;
        const endpoint = await helpers.verifyWebhookEndpoint(query, fresh, options.verifyWebhook || defaults.verifyWebhook, true);
        // Check the actual remote endpoint once, then every delivery principal.
        // A moved webhook never silently changes a saved resource's channel.
        for (const ownerId of principals) await verify({ userId: ownerId }, fresh.guild_id, fresh.channel_id);
        await helpers.lockWebhookEndpoint(query, endpoint);
        const checked = (await query('SELECT * FROM automation_destinations WHERE id=? FOR UPDATE', [fresh.id]))[0];
        if (!checked || destinationIdentity(checked) !== destinationIdentity(fresh)) fail('DESTINATION_CHANGED', '通知先が変更されています。設定を確認し直してください。', 409);
    }
    async function validateRegistrationWorkflow(query, actor, kind, targetId) {
        requireActor(actor);
        if (!['auto', 'price'].includes(kind)) fail('INVALID_MONITOR', '監視の種類が不正です。');
        const table = kind === 'auto' ? 'auto_watch' : 'price_watch';
        const target = (await query(`SELECT t.user_id,t.guild_id,t.destination_type,m.scope,a.workflow_id,m.destination_id FROM ${table}_targets t
            LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id
            LEFT JOIN automation_assignments a ON a.target_kind=? AND a.target_id=t.id WHERE t.id=? AND t.user_id=? FOR UPDATE`, [kind, kind, targetId, actor.userId]))[0];
        if (!target) fail('NOT_FOUND', '監視が見つかりません。', 404);
        const scope = target.scope || (target.destination_type === 'dm' || !target.guild_id ? 'private' : 'guild');
        if (target.workflow_id) {
            const workflow = (await query('SELECT * FROM automation_workflows WHERE id=? AND deleted_at_ms IS NULL FOR UPDATE', [target.workflow_id]))[0];
            if (!workflow || workflow.scope !== scope || scope === 'private' && workflow.owner_user_id !== target.user_id
                || scope === 'guild' && workflow.guild_id !== target.guild_id) fail('TARGET_SCOPE', '監視に割り当てたルールを確認してください。');
            await validateWorkflowDestinations(query, workflow, [target.user_id]);
        }
        if (target.destination_id) {
            const destination = (await query('SELECT * FROM automation_destinations WHERE id=? FOR UPDATE', [target.destination_id]))[0];
            if (!destination || destination.deleted_at_ms) fail('NOT_FOUND', '通知先が見つかりません。', 404);
            if (scope === 'guild' && (destination.scope !== 'guild' || destination.guild_id !== target.guild_id || destination.kind === 'dm')
                || scope === 'private' && destination.scope === 'guild' && (destination.guild_id !== target.guild_id || destination.kind === 'dm')
                || !['private', 'guild'].includes(destination.scope)) fail('DESTINATION_SCOPE', '監視と同じ公開範囲・サーバーの通知先を選び直してください。', 409);
            if (destination.kind !== target.destination_type) fail('DESTINATION_CHANGED', '通知方法が変更されています。通知一覧で通知先を確認してください。', 409);
            // Existing bound shared resources are use-only: the native owner
            // needs actual recipient access, not new resource-edit privileges.
            await validateDestinationOwners(destination, [target.user_id], query);
        }
    }
    async function saveWorkflowRevision(query, actor, id, revision, definition, bindings, now, serialized = false) {
        const body = serialized && typeof definition === 'string' ? definition : JSON.stringify(definition);
        const refs = serialized && typeof bindings === 'string' ? bindings : JSON.stringify(bindings), checksum = hash(body + refs);
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
        return db.withDatabaseTransaction(async query => {
            let origin = null;
            if (input.sourceWorkflowId !== undefined) {
                // Ordinary UI copies retain the source's server-verified
                // installation identity, including when copying a copy. Raw
                // JSON imports continue to use their explicit rights workflow.
                await require('./flow-history').lockFlowWorkflows(query, [input.sourceWorkflowId]);
                const source = await getRow('workflow', actor, input.sourceWorkflowId, false, query, true);
                if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 1 || input.expectedSourceRevision > Number(source.revision))
                    fail('REVISION_CONFLICT', '複製元のルールが更新されています。再読み込みしてから複製してください。', 409);
                const provenance = require('./workflow-package-provenance');
                origin = provenance.requireKnownEdition(await provenance.revisionOrigin(query, input.sourceWorkflowId, input.expectedSourceRevision, Number(source.revision)));
            }
            await query('INSERT INTO automation_workflows (id,owner_user_id,guild_id,scope,name,draft_json,draft_bindings_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
                [id, owner.owner_user_id, owner.guild_id, owner.scope, definition.name, JSON.stringify(definition), JSON.stringify(bindings), now, now]);
            await saveWorkflowRevision(query, actor, id, 1, definition, bindings, now);
            if (origin) {
                await require('./workflow-package-provenance').rememberOrigin(query, id, 1, origin);
                await query('INSERT INTO automation_package_installs (package_id,version,workflow_id,actor_user_id,created_at_ms) VALUES (?,?,?,?,?)', [origin.id, origin.version, id, actor.userId, now]);
            }
            await audit(query, actor, id, 'workflow.create', { revision: 1 }, owner.guild_id);
            // A response-read failure must abort creation rather than leave a
            // committed resource behind an API error that invites another POST.
            return publicWorkflow(await getRow('workflow', actor, id, false, query));
        });
    }
    async function getWorkflow(actor, id) { return publicWorkflow(await getRow('workflow', actor, id)); }
    async function updateWorkflow(actor, id, input, restoredRevision = undefined) {
        const definition = assertWorkflow(input.definition);
        return db.withDatabaseTransaction(async query => {
            const current = await getRow('workflow', actor, id, true, query, true);
            if (Number(current.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '別の変更が保存されています。再読み込みしてください。', 409);
            const bindings = await validateBindings(actor, definition, input.bindings || parse(current.draft_bindings_json), query);
            const now = Date.now(), revision = Number(current.revision) + 1;
            const provenance = require('./workflow-package-provenance');
            const origin = await provenance.revisionOrigin(query, id, restoredRevision === undefined ? Number(current.revision) : restoredRevision, Number(current.revision));
            // Capture the current draft as well: installations from the early
            // schema retained only applied editions. Never invent overwritten
            // history, but do retain the edition that is still available now.
            await saveWorkflowRevision(query, actor, id, current.revision, parse(current.draft_json), parse(current.draft_bindings_json), now);
            await saveWorkflowRevision(query, actor, id, revision, definition, bindings, now);
            await provenance.rememberOrigin(query, id, revision, origin);
            await query('UPDATE automation_workflows SET name=?,draft_json=?,draft_bindings_json=?,revision=revision+1,updated_at_ms=? WHERE id=?',
                [definition.name, JSON.stringify(definition), JSON.stringify(bindings), now, id]);
            await audit(query, actor, id, 'workflow.update', { before: Number(current.revision), after: Number(current.revision) + 1 }, current.guild_id);
            return { revision: Number(current.revision) + 1 };
        });
    }
    async function activationPreview(actor, id) {
        return db.withDatabaseTransaction(async query => {
            const row = await getRow('workflow', actor, id, true, query, true);
            const { workflowTargets, targetsToken } = require('./workflow-targets');
            const affectedTargets = await workflowTargets(query, row);
            return { expectedRevision: Number(row.revision), affectedTargets, expectedTargetsToken: targetsToken(row, affectedTargets) };
        });
    }
    async function activateWorkflow(actor, id, input, options = {}) {
        const activate = async (query, row, lockedTargets) => {
            if (Number(row.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '編集内容が変更されています。', 409);
            const { workflowTargets, targetsToken } = require('./workflow-targets');
            const affectedTargets = lockedTargets || (input.expectedTargetsToken !== undefined || options.requireTargetsToken ? await workflowTargets(query, row) : []);
            if ((input.expectedTargetsToken !== undefined || options.requireTargetsToken && affectedTargets.length)
                && input.expectedTargetsToken !== targetsToken(row, affectedTargets))
                fail('WORKFLOW_TARGETS_CHANGED', 'このルールを使う通知が変更されています。適用先を再確認してください。', 409);
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
            await validateWorkflowDestinations(query, row, [...affectedTargets.map(target => target.ownerId), actor.userId], { definition_json: definition, bindings_json: bindings });
            // Validation may omit a deleted, unused binding. Activation does
            // not edit the immutable draft edition: a later save/restore
            // records that normalization as a new revision instead.
            await saveWorkflowRevision(query, actor, id, row.revision, definition, parse(row.draft_bindings_json), Date.now());
            await query('UPDATE automation_workflows SET active_revision=revision,enabled=1,updated_at_ms=? WHERE id=?', [Date.now(), id]);
            await audit(query, actor, id, 'workflow.activate', { revision: Number(row.revision) }, row.guild_id);
            return { activeRevision: Number(row.revision), enabled: true };
        };
        return require('./workflow-deletion').withLockedWorkflowTargets(db, actor, id, input.expectedRevision, { getRow, audit }, activate);
    }
    async function setWorkflowState(actor, id, input) {
        if (typeof input?.enabled !== 'boolean') fail('INVALID_STATE', '有効・停止の状態を確認してください。');
        const change = async (query, row, targets = []) => {
            if (Number(row.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '編集内容が変更されています。', 409);
            if (input.enabled && !row.active_revision) fail('NOT_ACTIVE', 'ルールを適用してから有効にしてください。');
            if (input.enabled) {
                const snapshots = await query('SELECT definition_json,bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [id, row.active_revision]);
                if (!snapshots.length) fail('NOT_ACTIVE', '適用済みのルールを確認できません。再度適用してください。');
                const definition = assertWorkflow(parse(snapshots[0].definition_json));
                await validateBindings(actor, definition, parse(snapshots[0].bindings_json), query, true);
                await validateWorkflowDestinations(query, row, [...targets.map(target => target.ownerId), actor.userId], snapshots[0]);
            }
            const now = Date.now(), revision = Number(row.revision) + 1, provenance = require('./workflow-package-provenance');
            const origin = await provenance.revisionOrigin(query, id, Number(row.revision), Number(row.revision));
            // A state CAS also advances the displayed draft revision. Preserve
            // that edition's source without validating/parsing a legacy broken
            // draft: its owner must always be able to pause notifications.
            await saveWorkflowRevision(query, actor, id, revision, row.draft_json, row.draft_bindings_json, now, true);
            await provenance.rememberOrigin(query, id, revision, origin);
            await query('UPDATE automation_workflows SET enabled=?,revision=revision+1,updated_at_ms=? WHERE id=?', [input.enabled ? 1 : 0, now, id]);
            await audit(query, actor, id, 'workflow.state', { enabled: !!input.enabled }, row.guild_id);
            return { enabled: !!input.enabled, revision: Number(row.revision) + 1 };
        };
        return input.enabled ? require('./workflow-deletion').withLockedWorkflowTargets(db, actor, id, input.expectedRevision, { getRow, audit }, change)
            : db.withDatabaseTransaction(async query => change(query, await getRow('workflow', actor, id, true, query, true)));
    }
    async function remove(kind, actor, id, expectedRevision) {
        if (kind === 'workflow') return require('./workflow-deletion').removeWorkflow(db, actor, id, expectedRevision, { getRow, audit });
        return db.withDatabaseTransaction(async query => {
            const row = await getRow(kind, actor, id, true, query, true);
            if (Number(row.revision) !== expectedRevision) fail('REVISION_CONFLICT', '対象が更新されています。', 409);
            await query(`UPDATE ${TABLES[kind]} SET deleted_at_ms=?,revision=revision+1,updated_at_ms=? WHERE id=?`, [Date.now(), Date.now(), id]);
            await audit(query, actor, id, `${kind}.delete`, { revision: expectedRevision }, row.guild_id);
            return { deleted: true };
        });
    }
    async function history(actor, id, options) {
        await getRow('workflow', actor, id);
        const paged = options !== undefined, limit = options?.limit ?? 50, before = options?.beforeRevision;
        if (paged && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== undefined && (!Number.isSafeInteger(before) || before < 1))) fail('INVALID_CURSOR', '変更履歴の取得位置を確認してください。');
        const rows = await db.queryDatabase(`SELECT revision,checksum,actor_user_id,created_at_ms FROM automation_revisions WHERE workflow_id=?${paged && before !== undefined ? ' AND revision<?' : ''} ORDER BY revision DESC${paged ? ' LIMIT ?' : ''}`,
            [id, ...(paged && before !== undefined ? [before] : []), ...(paged ? [limit + 1] : [])]);
        // Recheck access after the read as well: a concurrent delete or scope
        // change must not disclose the previous owner's history.
        await getRow('workflow', actor, id);
        const items = (paged ? rows.slice(0, limit) : rows).map(r => ({ revision: Number(r.revision), checksum: r.checksum, actorId: r.actor_user_id, createdAtMs: Number(r.created_at_ms) }));
        return paged ? { items, nextRevision: rows.length > limit ? items[items.length - 1].revision : null } : items;
    }
    async function restoreRevision(actor, id, revision, expectedRevision) {
        await getRow('workflow', actor, id, true);
        const rows = await db.queryDatabase('SELECT definition_json,bindings_json FROM automation_revisions WHERE workflow_id=? AND revision=?', [id, revision]);
        if (!rows.length) fail('NOT_FOUND', '版が見つかりません。', 404);
        return updateWorkflow(actor, id, { expectedRevision, definition: parse(rows[0].definition_json), bindings: parse(rows[0].bindings_json) }, revision);
    }
    async function saveDictionary(actor, input, id = null, sourceRevision = undefined) {
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
            let origin = null;
            const resourceId = id || randomUUID();
            if (id) {
                owner = await getRow('dictionary', actor, id, true, query, true);
                if (Number(owner.revision) !== input.expectedRevision) fail('REVISION_CONFLICT', '辞書が更新されています。', 409);
                const inherited = sourceRevision === undefined ? Number(owner.revision) : sourceRevision;
                if (!Number.isSafeInteger(inherited) || inherited < 1) fail('DICTIONARY_VERSION_MISSING', '辞書の版が見つかりません。', 404);
                origin = (await query('SELECT source_package_id,source_package_version,origin_reviewed,package_dependencies_json FROM automation_dictionary_revisions WHERE dictionary_id=? AND revision=?', [id, inherited]))[0];
                if (!origin) fail('DICTIONARY_VERSION_MISSING', '辞書の版が見つかりません。', 404);
                revision = Number(owner.revision) + 1;
                await query('UPDATE automation_dictionaries SET name=?,revision=?,entry_count=?,updated_at_ms=? WHERE id=?', [data.name, revision, data.entries.length, Date.now(), id]);
            } else {
                owner = scopeFor(actor, input.scope || 'private');
                await query('INSERT INTO automation_dictionaries (id,owner_user_id,guild_id,scope,name,revision,entry_count,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
                    [resourceId, owner.owner_user_id, owner.guild_id, owner.scope, data.name, revision, data.entries.length, Date.now(), Date.now()]);
            }
            await query('INSERT INTO automation_dictionary_revisions (dictionary_id,revision,data_gzip,checksum,entry_count,source_text,license_text,source_package_id,source_package_version,origin_reviewed,package_dependencies_json,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                [resourceId, revision, compressed, checksum, data.entries.length, String(data.source || '').slice(0, 8000), String(data.license || '').slice(0, 8000), origin?.source_package_id || null, origin?.source_package_version || null, id ? origin?.origin_reviewed ?? null : 1, origin?.package_dependencies_json ?? null, Date.now()]);
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
    async function attach(actor, workflowId, targetKind, targetId, guards = undefined) {
        requireActor(actor);
        if (!['auto', 'price'].includes(targetKind) || !/^\d{1,20}$/.test(String(targetId))) fail('INVALID_TARGET', '監視IDが不正です。');
        const guarded = guards === undefined ? null : validateAssignmentGuards(guards);
        const { assertMonitorAccess, scopeOf, lockMonitorSource, advanceMonitorRevision, cancelPending } = require('./monitors');
        const table = targetKind === 'auto' ? 'auto_watch_targets' : 'price_watch_targets';
        // Discover the immutable owner before the transaction. Acquire its
        // fence before any consistent snapshot, then use current locking reads
        // for the target revision, old assignment and new workflow.
        const candidate = (await db.queryDatabase(`SELECT t.*,m.scope FROM ${table} t LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id WHERE t.id=?`, [targetKind, String(targetId)]))[0];
        assertMonitorAccess(actor, candidate, true);
        return db.withDatabaseTransaction(async query => {
            await require('./entitlements').lockOwner(query, candidate.user_id);
            await lockMonitorSource(query, candidate.user_id, targetKind, targetId);
            const rows = await query(`SELECT t.*,m.scope,m.revision AS monitor_revision FROM ${table} t LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id WHERE t.id=? FOR UPDATE`, [targetKind, String(targetId)]);
            const target = rows[0];
            assertMonitorAccess(actor, target, true);
            if (target.user_id !== candidate.user_id) fail('NOT_FOUND', '監視が見つかりません。', 404);
            const beforeRevision = Number(target.monitor_revision || 1);
            const assignment = (await query('SELECT workflow_id FROM automation_assignments WHERE target_kind=? AND target_id=? FOR UPDATE', [targetKind, String(targetId)]))[0];
            const beforeWorkflowId = assignment?.workflow_id ?? null;
            if (guarded && (beforeRevision !== guarded.expectedRevision || beforeWorkflowId !== guarded.expectedWorkflowId)) fail('REVISION_CONFLICT', '監視設定または通知ルールが別の操作で変更されています。最新の通知を読み直してください。', 409);
            const rule = await getRow('workflow', actor, workflowId, true, query, true);
            if (rule.scope !== scopeOf(target)) fail('TARGET_SCOPE', '監視とルールの公開範囲を一致させてください。');
            if (rule.scope === 'guild' && (target.guild_id !== rule.guild_id || target.destination_type === 'dm')) fail('TARGET_SCOPE', '共有ルールは同じサーバーの共有通知に割り当ててください。');
            if (rule.scope === 'private' && target.user_id !== actor.userId) fail('TARGET_SCOPE', '個人ルールは自分の監視に割り当ててください。');
            await validateWorkflowDestinations(query, rule, [target.user_id, actor.userId]);
            if (beforeWorkflowId === workflowId) return { attached: true, unchanged: true, revision: beforeRevision };
            await query('INSERT INTO automation_assignments (target_kind,target_id,workflow_id,created_at_ms) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE workflow_id=VALUES(workflow_id)', [targetKind, String(targetId), workflowId, Date.now()]);
            const revision = await advanceMonitorRevision(query, targetKind, targetId, scopeOf(target), beforeRevision);
            await cancelPending(query, targetKind, targetId);
            await audit(query, actor, workflowId, 'workflow.attach', { targetKind, targetId: String(targetId), ...(guarded ? { guarded: true,
                beforeWorkflowId, afterWorkflowId: workflowId, beforeRevision, afterRevision: revision } : {}) }, target.guild_id);
            return { attached: true, revision };
        });
    }
    const service = { list, getRow, getWorkflow, createWorkflow, updateWorkflow, activationPreview, activateWorkflow, setWorkflowState, remove, history,
        restoreRevision, validateBindings, validateWorkflowDestinations, validateDestinationOwners, validateRegistrationWorkflow, saveDictionary, getDictionary, dictionaryData, saveDestination, attach, audit,
        withOperation, rateLimiter };
    for (const name of ['createWorkflow', 'updateWorkflow', 'activateWorkflow', 'restoreRevision', 'saveDictionary', 'saveDestination', 'attach']) {
        const operation = /** @type {Function} */ (service[name]);
        service[name] = (actor, ...args) => withOperation(actor, 'write', () => operation(actor, ...args));
    }
    service.setWorkflowState = async (actor, id, input) => input?.enabled ? withOperation(actor, 'write', () => setWorkflowState(actor, id, input)) : setWorkflowState(actor, id, input);
    return service;
}
module.exports = { createService, AutomationError, assertAccess, scopeFor, requireActor, hash, publicWorkflow, publicDestination, validateAssignmentGuards };
