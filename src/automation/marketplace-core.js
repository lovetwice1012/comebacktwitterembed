'use strict';

const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { gzip, gunzip } = require('node:zlib');
const { promisify } = require('node:util');
const { validateBundle, MAX_EXPANDED } = require('./bundle');
const { createService, AutomationError, requireActor, hash } = require('./service');
const compress = promisify(gzip), decompress = promisify(gunzip);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
const textField = (value, limit, required = true) => { if (typeof value !== 'string' || value.length > limit || required && !value.trim()) fail('MARKET_TEXT', '名称・説明の長さを確認してください。'); return value.trim(); };
function equalKey(a, b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function visiblePackage(row, actor) {
    const owner = row.owner_user_id === actor.userId;
    return { id: row.id, owner_user_id: row.owner_user_id, title: owner ? row.title : row.published_title,
        description: owner ? row.description : row.published_description, category: owner ? row.category : row.published_category,
        kind: row.kind, visibility: owner ? row.visibility : row.published_visibility, status: row.status,
        latest_version: Number(owner ? row.latest_version : row.published_version), publishedVersion: row.published_version == null ? null : Number(row.published_version),
        fork_of: row.fork_of, updated_at_ms: Number(row.updated_at_ms), ...(owner ? { shareKey: row.share_key } : {}) };
}
function createMarketplace(db, options = {}) {
    const service = options.service || createService(db);
    const safety = options.safety || require('./safety').createSafety({ matcher: options.moderationMatcher });
    const selection = `SELECT p.*,v.title AS published_title,v.description AS published_description,v.category AS published_category,v.visibility AS published_visibility,v.status AS published_status FROM automation_packages p LEFT JOIN automation_package_versions v ON v.package_id=p.id AND v.version=p.published_version`;
    async function rawRow(id, query = db.queryDatabase, lock = false) {
        if (!/^[0-9a-f-]{36}$/i.test(id || '')) fail('NOT_FOUND', '共有ルールが見つかりません。', 404);
        return (await query(`${selection} WHERE p.id=?${lock ? ' FOR UPDATE' : ''}`, [id]))[0];
    }
    const privileged = (actor, row) => row.owner_user_id === actor.userId || actor.isAdmin && row.visibility !== 'private';
    async function getRow(actor, id, shareKey, write = false, query = db.queryDatabase, lock = false) {
        requireActor(actor); const row = await rawRow(id, query, lock);
        if (!row) fail('NOT_FOUND', '共有ルールが見つかりません。', 404);
        const visible = row.visibility !== 'private' && row.status !== 'withdrawn' && row.published_status === 'active' && (row.published_visibility === 'public' || row.published_visibility === 'unlisted' && equalKey(row.share_key, shareKey));
        if (write ? row.owner_user_id !== actor.userId : !privileged(actor, row) && !visible) fail('NOT_FOUND', '共有ルールが見つかりません。', 404);
        return row;
    }
    async function list(actor, filters = {}) {
        requireActor(actor); const needle = String(filters.search || '').slice(0, 120).replace(/[\\%_]/g, '\\$&');
        const rows = await db.queryDatabase(`${selection} WHERE ((v.visibility='public' AND v.status='active' AND p.visibility<>'private' AND p.status<>'withdrawn') OR p.owner_user_id=?)
            AND (?=0 OR p.owner_user_id=?) AND IF(p.owner_user_id=?,p.title,v.title) LIKE ? AND p.id>?
            AND (?=0 OR EXISTS (SELECT 1 FROM automation_feedback f WHERE f.subject_id=p.id AND f.actor_user_id=? AND f.kind='favorite' AND JSON_EXTRACT(f.value_json,'$.enabled')=true))
            AND (?=0 OR EXISTS (SELECT 1 FROM automation_author_follows a WHERE a.follower_user_id=? AND a.author_user_id=p.owner_user_id)) ORDER BY p.id LIMIT 51`,
        [actor.userId, filters.mine ? 1 : 0, actor.userId, actor.userId, `%${needle}%`, String(filters.afterId || ''), filters.favorites ? 1 : 0, actor.userId, filters.following ? 1 : 0, actor.userId]);
        return { items: rows.slice(0, 50).map(row => visiblePackage(row, actor)), nextCursor: rows.length > 50 ? rows[49].id : null, canModerate: !!actor.isAdmin };
    }
    async function save(actor, input, id = null) {
        requireActor(actor);
        const previous = id ? await getRow(actor, id, null, true) : null;
        if (previous?.status === 'revoked') fail('MARKET_REVOKED', '安全上停止されたパッケージは編集・再公開できません。');
        if (previous && Number(previous.latest_version) !== input.expectedVersion) fail('REVISION_CONFLICT', '共有ルールが更新されています。', 409);
        const bundle = validateBundle(input.bundle), title = textField(input.title, 120), description = textField(input.description || '', 8000, false), category = textField(input.category || 'general', 64), changelog = textField(input.changelog || '', 4000, false);
        if (!['private', 'unlisted', 'public'].includes(input.visibility)) fail('MARKET_VISIBILITY', '共有範囲が不正です。');
        const publish = input.visibility !== 'private', packageId = id || randomUUID(), version = previous ? Number(previous.latest_version) + 1 : 1;
        let assessment = null;
        if (publish) {
            if (input.rightsConfirmed !== true || !bundle.license?.trim()) fail('MARKET_LICENSE_REQUIRED', '内容・再配布する権利の確認とライセンス指定が必要です。');
            for (const dictionary of Object.values(bundle.dictionaries)) if (!dictionary.source?.trim() || !dictionary.license?.trim()) fail('DICTIONARY_ATTRIBUTION_REQUIRED', '共有辞書に出典とライセンスを指定してください。');
            assessment = await inspectPublication({ id: packageId, version, owner_user_id: actor.userId, title, description, category, changelog, bundle });
            options.assertPublicationAllowed?.();
        }
        if (input.forkOf) { const parent = await get(actor, input.forkOf, input.forkVersion, input.shareKey); if (!parent.bundle.license || bundle.license !== parent.bundle.license) fail('FORK_LICENSE', 'フォーク元のライセンスを保持してください。'); }
        const bytes = Buffer.from(JSON.stringify(bundle)), compressed = await compress(bytes), checksum = hash(bytes), status = publish ? 'active' : 'draft';
        return db.withDatabaseTransaction(async query => {
            if (id) {
                const row = await getRow(actor, id, null, true, query, true);
                if (row.status === 'revoked') fail('MARKET_REVOKED', '安全上停止されたパッケージは編集・再公開できません。');
                if (Number(row.latest_version) !== input.expectedVersion) fail('REVISION_CONFLICT', '共有ルールが更新されています。', 409);
                if (row.kind !== bundle.kind) fail('PACKAGE_KIND_IMMUTABLE', 'パッケージの種類は変更できません。新規作成してください。');
                await query('UPDATE automation_packages SET title=?,description=?,category=?,visibility=?,status=?,latest_version=?,updated_at_ms=? WHERE id=?', [title, description, category, input.visibility, status, version, Date.now(), id]);
                await query("UPDATE automation_package_versions SET status='superseded' WHERE package_id=? AND status='pending'", [id]);
            } else await query('INSERT INTO automation_packages (id,owner_user_id,title,description,category,kind,visibility,status,share_key,latest_version,fork_of,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [packageId, actor.userId, title, description, category, bundle.kind, input.visibility, status, randomBytes(32).toString('hex'), version, input.forkOf || null, Date.now(), Date.now()]);
            if (publish) options.assertPublicationAllowed?.();
            await query('INSERT INTO automation_package_versions (package_id,version,bundle_gzip,checksum,changelog,title,description,category,visibility,status,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [packageId, version, compressed, checksum, changelog, title, description, category, input.visibility, status, Date.now()]);
            if (publish) await query('UPDATE automation_packages SET published_version=? WHERE id=?', [version, packageId]);
            await service.audit(query, actor, packageId, 'package.save', { version, checksum, visibility: input.visibility, assessment, responsibility: publish ? { acknowledged: true, policyVersion: require('./safety').POLICY_VERSION } : null }, null);
            return { id: packageId, version, checksum, status };
        });
    }
    async function inspectPublication(pack) {
        if (!pack.bundle.license?.trim()) fail('MARKET_LICENSE_REQUIRED', '共有にはライセンス指定が必要です。');
        for (const dictionary of Object.values(pack.bundle.dictionaries)) if (!dictionary.source?.trim() || !dictionary.license?.trim()) fail('DICTIONARY_ATTRIBUTION_REQUIRED', '共有辞書に出典とライセンスを指定してください。');
        try { return await safety.assertPublication(pack); }
        catch (error) {
            if (error instanceof require('./safety').SafetyError) fail(error.decision === 'deny' ? 'PUBLICATION_REJECTED' : 'PUBLICATION_CHECK_FAILED',
                error.decision === 'deny' ? '機械チェックで公開を拒否しました。内容・リンク・禁止語を修正してください。' : '機械チェックに失敗しました。公開せず終了しました。後で再試行してください。',
                error.decision === 'deny' ? 400 : 503);
            fail('PUBLICATION_CHECK_FAILED', '機械チェックに失敗しました。公開せず終了しました。後で再試行してください。', 503);
        }
    }
    async function get(actor, id, version = null, shareKey = null) {
        const row = await getRow(actor, id, shareKey), selected = Number(version || (privileged(actor, row) ? row.latest_version : row.published_version));
        if (!Number.isInteger(selected) || selected < 1) fail('MARKET_VERSION', '版が不正です。');
        const record = (await db.queryDatabase('SELECT * FROM automation_package_versions WHERE package_id=? AND version=?', [id, selected]))[0];
        const canInspect = record && (row.owner_user_id === actor.userId || actor.isAdmin && row.visibility !== 'private' && record.visibility !== 'private');
        if (!record || !canInspect && (record.status !== 'active' || !(record.visibility === 'public' || record.visibility === 'unlisted' && equalKey(row.share_key, shareKey)))) fail('NOT_FOUND', '公開された版が見つかりません。', 404);
        let bundle;
        try {
            const bytes = await decompress(record.bundle_gzip, { maxOutputLength: MAX_EXPANDED });
            if (hash(bytes) !== record.checksum) throw new Error('BUNDLE_CHECKSUM');
            bundle = validateBundle(JSON.parse(bytes.toString('utf8')));
        } catch { fail('BUNDLE_CHECK_FAILED', 'パッケージの整合性を確認できません。', 503); }
        const feedback = await db.queryDatabase('SELECT kind,value_json FROM automation_feedback WHERE subject_id=? AND actor_user_id=?', [id, actor.userId]);
        const following = await db.queryDatabase('SELECT 1 FROM automation_author_follows WHERE follower_user_id=? AND author_user_id=?', [actor.userId, row.owner_user_id]);
        const stats = (await db.queryDatabase("SELECT (SELECT COUNT(*) FROM automation_package_installs WHERE package_id=?) + (SELECT COUNT(*) FROM automation_package_dictionary_installs WHERE package_id=?) AS installs,(SELECT AVG(CAST(JSON_UNQUOTE(JSON_EXTRACT(value_json,'$.rating')) AS DECIMAL(3,2))) FROM automation_feedback WHERE subject_id=? AND kind='rating') AS rating", [id, id, id]))[0];
        return { ...visiblePackage(row, actor), latest_version: Number(privileged(actor, row) ? row.latest_version : row.published_version), packageStatus: row.status, packageVisibility: row.visibility,
            title: record.title, description: record.description, category: record.category, visibility: record.visibility, status: record.status,
            version: selected, checksum: record.checksum, changelog: record.changelog, reviewNote: privileged(actor, row) ? record.review_note : undefined, bundle,
            mine: row.owner_user_id === actor.userId, canModerate: !!actor.isAdmin, feedback: Object.fromEntries(feedback.map(f => [f.kind, parse(f.value_json)])), following: following.length > 0, installs: Number(stats.installs), rating: stats.rating == null ? null : Number(stats.rating) };
    }
    async function versions(actor, id, input = {}) {
        const row = await getRow(actor, id, input.shareKey), owner = row.owner_user_id === actor.userId;
        const clause = owner ? '' : actor.isAdmin ? "AND visibility<>'private'" : "AND status='active' AND (visibility='public' OR (visibility='unlisted' AND ?=1))";
        const rows = await db.queryDatabase(`SELECT version,checksum,changelog,status,visibility,created_at_ms FROM automation_package_versions WHERE package_id=? AND version<? ${clause} ORDER BY version DESC LIMIT 51`, [id, Number(input.before || Number.MAX_SAFE_INTEGER), ...(owner || actor.isAdmin ? [] : [equalKey(row.share_key, input.shareKey) ? 1 : 0])]);
        return { items: rows.slice(0, 50).map(r => ({ ...r, version: Number(r.version) })), nextVersion: rows.length > 50 ? Number(rows[49].version) : null };
    }
    async function exportWorkflow(actor, id) {
        const rule = await service.getWorkflow(actor, id), dictionaries = Object.create(null);
        for (const [alias, ref] of Object.entries(rule.bindings.dictionaries || {})) { await service.getRow('dictionary', actor, ref.id); dictionaries[alias] = await service.dictionaryData(ref.id, ref.revision); }
        return validateBundle({ schemaVersion: 1, kind: 'workflow', workflow: rule.draft, dictionaries });
    }
    async function setStatus(actor, id, input) {
        let assessment = null;
        if (input.status === 'active') {
            requireActor(actor);
            if (!actor.isAdmin) fail('FORBIDDEN', '公開審査の権限が必要です。', 403);
            const pack = await get(actor, id);
            if (pack.packageStatus === 'revoked') fail('MARKET_REVOKED', '安全上の停止は通常の公開操作で解除できません。');
            if (pack.latest_version !== input.expectedVersion) fail('REVISION_CONFLICT', '共有ルールが更新されています。', 409);
            if (pack.status !== 'pending' || pack.visibility === 'private') fail('REVIEW_NOT_PENDING', 'この版は公開審査待ちではありません。');
            assessment = await inspectPublication(pack);
            options.assertPublicationAllowed?.();
        }
        return db.withDatabaseTransaction(async query => {
            requireActor(actor); const row = await rawRow(id, query, true);
            const previouslyShared = row && actor.isAdmin && input.status === 'revoked' && row.visibility === 'private'
                ? (await query("SELECT 1 FROM automation_package_versions WHERE package_id=? AND visibility<>'private' LIMIT 1", [id])).length > 0 : false;
            if (!row || !(row.owner_user_id === actor.userId || actor.isAdmin && (row.visibility !== 'private' || previouslyShared))) fail('NOT_FOUND', '対象が見つかりません。', 404);
            if (!['withdrawn', 'active', 'rejected', 'revoked'].includes(input.status)) fail('MARKET_STATUS', '公開状態が不正です。');
            if (Number(row.latest_version) !== input.expectedVersion) fail('REVISION_CONFLICT', '共有ルールが更新されています。', 409);
            if (input.status === 'revoked') {
                if (!actor.isAdmin) fail('FORBIDDEN', '安全上の停止には管理者権限が必要です。', 403);
                const note = textField(input.note, 4000), now = Date.now();
                await query("UPDATE automation_package_versions SET status='revoked',review_note=? WHERE package_id=? AND visibility<>'private'", [note, id]);
                await query("UPDATE automation_packages SET status='revoked',updated_at_ms=? WHERE id=?", [now, id]);
                await query("UPDATE automation_workflows w JOIN automation_package_installs i ON i.workflow_id=w.id SET w.enabled=0,w.updated_at_ms=? WHERE i.package_id=?", [now, id]);
                await query(`UPDATE automation_jobs j JOIN automation_runs r ON r.id=j.run_id JOIN automation_package_installs i ON i.workflow_id=r.workflow_id
                    SET j.state='excluded',j.last_error_code='SAFETY_PACKAGE_REVOKED',j.lease_token=NULL,j.lease_until_ms=0,j.updated_at_ms=?
                    WHERE i.package_id=? AND j.state IN ('pending','held','leased','aggregated')`, [now, id]);
                await service.audit(query, actor, id, 'package.revoke', { version: Number(row.latest_version) }, null);
                return { status: 'revoked' };
            }
            if (row.status === 'revoked') fail('MARKET_REVOKED', '安全上の停止は通常の公開操作で解除できません。');
            if (input.status === 'withdrawn') await query("UPDATE automation_packages SET status='withdrawn',updated_at_ms=? WHERE id=?", [Date.now(), id]);
            else {
                if (!actor.isAdmin) fail('FORBIDDEN', '公開審査の権限が必要です。', 403);
                const v = (await query('SELECT status,visibility FROM automation_package_versions WHERE package_id=? AND version=? FOR UPDATE', [id, row.latest_version]))[0];
                if (row.status === 'withdrawn' || !v || v.visibility === 'private' || v.status !== 'pending') fail('REVIEW_NOT_PENDING', 'この版は公開審査待ちではありません。');
                if (input.status === 'active') options.assertPublicationAllowed?.();
                await query('UPDATE automation_package_versions SET status=?,review_note=? WHERE package_id=? AND version=?', [input.status, textField(input.note || '', 4000, false), id, row.latest_version]);
                await query('UPDATE automation_packages SET status=?,published_version=?,updated_at_ms=? WHERE id=?', [input.status === 'active' || row.published_version ? 'active' : 'rejected', input.status === 'active' ? row.latest_version : row.published_version, Date.now(), id]);
            }
            await service.audit(query, actor, id, 'package.status', { status: input.status, version: Number(row.latest_version), assessment }, null); return { status: input.status };
        });
    }
    async function reviewPending() {
        const now = Date.now();
        const next = await db.withDatabaseTransaction(async query => {
            await query(`UPDATE automation_package_versions v JOIN automation_packages p ON p.id=v.package_id
                SET v.status=CASE WHEN p.status='revoked' THEN 'revoked' WHEN p.status='withdrawn' THEN 'withdrawn' WHEN v.visibility='private' OR p.visibility='private' THEN 'draft' ELSE 'superseded' END
                WHERE v.status='pending' AND (v.visibility='private' OR p.visibility='private' OR v.version<>p.latest_version OR p.status IN ('withdrawn','revoked'))`);
            await query("UPDATE automation_packages SET status='draft' WHERE visibility='private' AND status='pending'");
            await query(`UPDATE automation_packages p LEFT JOIN automation_package_versions v ON v.package_id=p.id AND v.version=p.latest_version
                LEFT JOIN automation_package_versions published ON published.package_id=p.id AND published.version=p.published_version
                SET p.status=CASE WHEN published.status='active' THEN 'active' WHEN v.status='draft' THEN 'draft' ELSE 'rejected' END,p.updated_at_ms=?
                WHERE p.status='pending' AND (v.version IS NULL OR v.status<>'pending')`, [now]);
            const rows = await query(`SELECT p.id,p.latest_version FROM automation_packages p JOIN automation_package_versions v ON v.package_id=p.id AND v.version=p.latest_version
                LEFT JOIN automation_counters c ON c.counter_key=SHA2(CONCAT('review:',p.id,':',p.latest_version),256)
                WHERE p.visibility<>'private' AND p.status NOT IN ('withdrawn','revoked') AND v.status='pending' AND COALESCE(c.expires_at_ms,0)<=?
                ORDER BY v.created_at_ms,p.id LIMIT 1 FOR UPDATE`, [now]);
            if (!rows.length) return null;
            const row = rows[0], key = hash(`review:${row.id}:${row.latest_version}`);
            await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,0)', [key]);
            const current = (await query('SELECT expires_at_ms FROM automation_counters WHERE counter_key=? FOR UPDATE', [key]))[0];
            if (Number(current.expires_at_ms) > now) return null;
            await query('UPDATE automation_counters SET used_count=used_count+1,expires_at_ms=? WHERE counter_key=?', [now + 15 * 60000, key]);
            return row;
        });
        if (!next) return { state: 'idle' };
        // 0 is the internal system principal, never a Discord login or a value
        // accepted from the public request's actor fields.
        try { await setStatus({ userId: '0', isAdmin: true }, next.id, { status: 'active', expectedVersion: Number(next.latest_version), note: '自動安全検査' }); return { state: 'approved' }; }
        catch (error) {
            if (['PUBLICATION_REJECTED', 'PUBLICATION_CHECK_FAILED', 'BUNDLE_CHECK_FAILED', 'MARKET_LICENSE_REQUIRED', 'DICTIONARY_ATTRIBUTION_REQUIRED'].includes(error.code)) {
                try { await setStatus({ userId: '0', isAdmin: true }, next.id, { status: 'rejected', expectedVersion: Number(next.latest_version), note: error.code }); }
                catch (changed) {
                    if (['REVISION_CONFLICT','REVIEW_NOT_PENDING','MARKET_REVOKED','NOT_FOUND'].includes(changed.code)) return { state: 'changed' };
                    throw changed;
                }
                return { state: 'rejected', code: error.code };
            }
            if (['REVISION_CONFLICT','REVIEW_NOT_PENDING','MARKET_REVOKED','NOT_FOUND'].includes(error.code)) return { state: 'changed' };
            throw error;
        }
    }
    async function fork(actor, id, input) {
        const parent = await get(actor, id, input.version, input.shareKey); if (!parent.bundle.license) fail('FORK_LICENSE', 'フォーク元のライセンスが未指定です。');
        const bundle = structuredClone(parent.bundle); bundle.description = `${bundle.description || ''}\nFork of ${parent.title} (${id}) v${parent.version}; author ${parent.owner_user_id}`.trim();
        return save(actor, { bundle, title: `${parent.title} のフォーク`.slice(0, 120), description: bundle.description.slice(0, 8000), category: parent.category, visibility: 'private', forkOf: id, forkVersion: parent.version, shareKey: input.shareKey });
    }
    async function feedback(actor, id, input) {
        const row = await getRow(actor, id, input.shareKey);
        if (!['favorite', 'rating', 'report', 'follow'].includes(input.kind)) fail('MARKET_FEEDBACK', '種類が不正です。');
        if (input.kind === 'follow') {
            if (input.enabled === false) await db.queryDatabase('DELETE FROM automation_author_follows WHERE follower_user_id=? AND author_user_id=?', [actor.userId, row.owner_user_id]);
            else await db.queryDatabase('INSERT IGNORE INTO automation_author_follows (follower_user_id,author_user_id,created_at_ms) VALUES (?,?,?)', [actor.userId, row.owner_user_id, Date.now()]);
            return { saved: true };
        }
        let value;
        if (input.kind === 'rating') { if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) fail('MARKET_RATING', '評価は1〜5です。'); value = { rating: input.rating }; }
        else if (input.kind === 'report') value = { reason: textField(input.reason, 2000) }; else value = { enabled: input.enabled !== false };
        await db.queryDatabase('INSERT INTO automation_feedback (id,subject_id,actor_user_id,kind,value_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),state=\'open\',updated_at_ms=VALUES(updated_at_ms)', [randomUUID(), id, actor.userId, input.kind, JSON.stringify(value), Date.now(), Date.now()]);
        return { saved: true };
    }
    async function reviewQueue(actor) {
        requireActor(actor); if (!actor.isAdmin) fail('FORBIDDEN', '公開審査の権限が必要です。', 403);
        const packages = await db.queryDatabase("SELECT p.id,p.title,p.owner_user_id,p.latest_version,p.updated_at_ms FROM automation_packages p JOIN automation_package_versions v ON v.package_id=p.id AND v.version=p.latest_version WHERE p.status<>'withdrawn' AND v.status='pending' ORDER BY p.updated_at_ms LIMIT 100");
        const reports = await db.queryDatabase("SELECT id,subject_id,actor_user_id,value_json,created_at_ms FROM automation_feedback WHERE kind='report' AND state='open' ORDER BY created_at_ms LIMIT 100");
        return { packages, reports: reports.map(r => ({ ...r, value: parse(r.value_json) })) };
    }
    async function resolveReport(actor, id, input) {
        requireActor(actor); if (!actor.isAdmin) fail('FORBIDDEN', '公開審査の権限が必要です。', 403);
        const result = await db.queryDatabase("UPDATE automation_feedback SET state='resolved',updated_at_ms=? WHERE id=? AND kind='report' AND state='open'", [Date.now(), id]);
        if (!result.affectedRows) fail('NOT_FOUND', '未処理の通報が見つかりません。', 404);
        await service.audit(db.queryDatabase, actor, id, 'report.resolve', { note: textField(input.note || '', 1000, false) }, null); return { resolved: true };
    }
    const installs = require('./marketplace-installs').createInstalls(db, service, get, options.evaluator);
    return { list, save, get, exportWorkflow, setStatus, reviewPending, feedback, reviewQueue, resolveReport, versions, fork, ...installs };
}
module.exports = { createMarketplace, equalKey, visiblePackage };
