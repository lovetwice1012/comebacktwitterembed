'use strict';

const { randomUUID } = require('node:crypto');
const { validateBundle } = require('./bundle');
const { AutomationError, requireActor, assertAccess, scopeFor, hash } = require('./service');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
function createInstalls(db, service, getPackage, evaluator) {
    async function importBundle(actor, bundle, input = {}, origin = null) {
        validateBundle(bundle); const owner = scopeFor(actor, input.scope || 'private');
        if (input.workflowId) fail('INSTALL_REQUIRES_UPDATE_PREVIEW', '既存ルールの更新は更新プレビューから実行してください。');
        return db.withDatabaseTransaction(async query => {
            const refs = Object.create(null);
            for (const [alias, dictionary] of Object.entries(bundle.dictionaries)) { const created = await service.saveDictionary(actor, { scope: owner.scope, dictionary }); refs[alias] = { id: created.id, revision: created.revision }; }
            if (bundle.kind === 'dictionary') {
                const installId = origin ? randomUUID() : null;
                if (origin) await query('INSERT INTO automation_package_dictionary_installs (id,package_id,version,dictionary_bindings_json,owner_user_id,guild_id,scope,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)', [installId, origin.id, origin.version, JSON.stringify(refs), actor.userId, owner.guild_id, owner.scope, Date.now(), Date.now()]);
                return { dictionaries: refs, installId };
            }
            const workflow = await service.createWorkflow(actor, { definition: bundle.workflow, bindings: { dictionaries: refs, destinations: input.destinations || {} }, scope: owner.scope });
            if (origin) await query('INSERT INTO automation_package_installs (package_id,version,workflow_id,actor_user_id,created_at_ms) VALUES (?,?,?,?,?)', [origin.id, origin.version, workflow.id, actor.userId, Date.now()]);
            return { workflow, dictionaries: refs };
        });
    }
    async function install(actor, id, input) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => {
            // Serialize installs with publication, withdrawal and takedown so
            // their checks cannot use a publication that changed during import.
            await query('SELECT id FROM automation_packages WHERE id=? FOR UPDATE', [id]);
            const pack = await getPackage(actor, id, input.version, input.shareKey);
            if (pack.status !== 'active' || ['withdrawn', 'revoked'].includes(pack.packageStatus) || pack.packageVisibility === 'private') fail('MARKET_NOT_ACTIVE', '現在公開されている機械チェック済みの版を選んでください。');
            return importBundle(actor, pack.bundle, input, { id, version: pack.version });
        });
    }
    async function installations(actor, input = {}) {
        requireActor(actor);
        if (input.kind === 'dictionary') {
            const rows = await db.queryDatabase(`SELECT i.*,v.title,p.published_version FROM automation_package_dictionary_installs i JOIN automation_packages p ON p.id=i.package_id LEFT JOIN automation_package_versions v ON v.package_id=p.id AND v.version=p.published_version WHERE i.id>?
                AND ((i.scope='private' AND i.owner_user_id=?) OR (i.scope='guild' AND i.guild_id=? AND ?=1)) ORDER BY i.id LIMIT 51`, [input.afterId || '', actor.userId, actor.guildId || null, actor.canView ? 1 : 0]);
            return { items: rows.slice(0, 50).map(row => ({ kind: 'dictionary', installId: row.id, packageId: row.package_id, version: Number(row.version), availableVersion: Number(row.published_version || row.version), name: row.title || '辞書パック', scope: row.scope, dictionaries: parse(row.dictionary_bindings_json) })), nextCursor: rows.length > 50 ? rows[49].id : null };
        }
        const rows = await db.queryDatabase(`SELECT i.*,w.name,w.scope,w.revision,p.published_version FROM automation_package_installs i JOIN automation_workflows w ON w.id=i.workflow_id JOIN automation_packages p ON p.id=i.package_id
            WHERE i.workflow_id>? AND w.deleted_at_ms IS NULL AND ((w.scope='private' AND w.owner_user_id=?) OR (w.scope='guild' AND w.guild_id=? AND ?=1)) ORDER BY i.workflow_id LIMIT 51`, [input.afterId || '', actor.userId, actor.guildId || null, actor.canView ? 1 : 0]);
        return { items: rows.slice(0, 50).map(row => ({ kind: 'workflow', workflowId: row.workflow_id, packageId: row.package_id, version: Number(row.version), availableVersion: Number(row.published_version || row.version), name: row.name, scope: row.scope, revision: Number(row.revision) })), nextCursor: rows.length > 50 ? rows[49].workflow_id : null };
    }
    async function updatePlan(actor, id, input) {
        const pack = await getPackage(actor, id, input.version, input.shareKey);
        if (pack.status !== 'active' || ['withdrawn', 'revoked'].includes(pack.packageStatus) || pack.packageVisibility === 'private') fail('MARKET_NOT_ACTIVE', '現在公開されている機械チェック済みの版を選んでください。');
        let record, workflow = null, refs, scope, currentRevision = null;
        if (input.workflowId) {
            const row = await service.getRow('workflow', actor, input.workflowId, true);
            workflow = await service.getWorkflow(actor, input.workflowId); scope = row.scope; currentRevision = workflow.revision;
            record = (await db.queryDatabase('SELECT version FROM automation_package_installs WHERE package_id=? AND workflow_id=?', [id, input.workflowId]))[0]; refs = workflow.bindings.dictionaries;
        } else {
            record = (await db.queryDatabase('SELECT * FROM automation_package_dictionary_installs WHERE id=? AND package_id=?', [input.installId, id]))[0];
            assertAccess(actor, record, true); scope = record.scope; refs = parse(record.dictionary_bindings_json);
        }
        if (!record) fail('INSTALLATION_MISSING', 'このパッケージの導入記録がありません。');
        let old, baselineUnavailable = false;
        try { old = await getPackage(actor, id, Number(record.version), input.shareKey); }
        catch (error) { if (error.status !== 404) throw error; old = { bundle: { workflow: null, dictionaries: {} } }; baselineUnavailable = true; }
        const dictionaryDiffs = [], currentDictionaryRevisions = {};
        let localChanges = baselineUnavailable || (workflow ? JSON.stringify(workflow.draft) !== JSON.stringify(old.bundle.workflow) : false)
            || JSON.stringify(Object.keys(refs).sort()) !== JSON.stringify(Object.keys(old.bundle.dictionaries).sort());
        const diffFn = evaluator ? (before, after) => evaluator.dictionaryTask({ operation: 'diff', before, after }) : (before, after) => require('./dictionary-format').diffDictionaries(before, after);
        for (const alias of new Set([...Object.keys(refs), ...Object.keys(pack.bundle.dictionaries)])) {
            let before;
            if (refs[alias]) {
                const dictionary = await service.getRow('dictionary', actor, refs[alias].id, !workflow), revision = workflow ? refs[alias].revision : Number(dictionary.revision);
                currentDictionaryRevisions[alias] = revision; before = await service.dictionaryData(refs[alias].id, revision);
                if (old.bundle.dictionaries[alias]) { const delta = await diffFn(old.bundle.dictionaries[alias], before); if (delta.added || delta.removed || delta.changed || delta.metadataChanged.length) localChanges = true; } else localChanges = true;
            }
            const after = pack.bundle.dictionaries[alias];
            dictionaryDiffs.push({ alias, ...(before && after ? await diffFn(before, after) : { added: after?.entries.length || 0, removed: before?.entries.length || 0, changed: 0, samples: [] }) });
        }
        const token = hash(JSON.stringify([id, pack.version, pack.checksum, input.workflowId || input.installId, Number(record.version), currentRevision, currentDictionaryRevisions, refs]));
        return { token, fromVersion: Number(record.version), toVersion: pack.version, localChanges, baselineUnavailable, dictionaryDiffs, scope, currentRevision, currentDictionaryRevisions,
            workflowPreview: pack.bundle.workflow || null, previousWorkflow: workflow?.draft || null, preservedDestinations: workflow?.bindings.destinations || {}, _pack: pack, _refs: refs };
    }
    async function previewUpdate(actor, id, input) { const { _pack, _refs, ...result } = await updatePlan(actor, id, input); return result; }
    async function updateInstall(actor, id, input) {
        requireActor(actor);
        return db.withDatabaseTransaction(async query => {
            await query('SELECT id FROM automation_packages WHERE id=? FOR UPDATE', [id]);
            const plan = await updatePlan(actor, id, input);
            if (plan.token !== input.expectedToken) fail('REVISION_CONFLICT', '導入済み設定または更新する版が変わりました。差分を再確認してください。', 409);
            if (plan.localChanges && input.replaceLocalChanges !== true) fail('LOCAL_CHANGES', 'ローカル編集を置き換えることの確認が必要です。');
            const refs = Object.create(null);
            for (const [alias, dictionary] of Object.entries(plan._pack.bundle.dictionaries)) {
                const prior = !input.workflowId && plan._refs[alias];
                const saved = await service.saveDictionary(actor, { scope: plan.scope, dictionary, ...(prior ? { expectedRevision: plan.currentDictionaryRevisions[alias] } : {}) }, prior ? prior.id : null);
                refs[alias] = { id: saved.id, revision: saved.revision };
            }
            if (input.workflowId) {
                await service.updateWorkflow(actor, input.workflowId, { expectedRevision: plan.currentRevision, definition: plan._pack.bundle.workflow, bindings: { dictionaries: refs, destinations: plan.preservedDestinations } });
                await query('UPDATE automation_package_installs SET version=? WHERE package_id=? AND workflow_id=?', [plan.toVersion, id, input.workflowId]);
            } else {
                const updated = await query('UPDATE automation_package_dictionary_installs SET version=?,dictionary_bindings_json=?,updated_at_ms=? WHERE id=? AND version=?', [plan.toVersion, JSON.stringify(refs), Date.now(), input.installId, plan.fromVersion]);
                if (Number(updated.affectedRows) !== 1) fail('REVISION_CONFLICT', '導入済み辞書が更新されています。', 409);
            }
            await service.audit(query, actor, input.workflowId || input.installId, 'package.update-install', { packageId: id, from: plan.fromVersion, to: plan.toVersion }, actor.guildId);
            return { version: plan.toVersion, workflowId: input.workflowId || null, dictionaries: refs, activated: false };
        });
    }
    return { importBundle, install, installations, previewUpdate, updateInstall };
}
module.exports = { createInstalls };
