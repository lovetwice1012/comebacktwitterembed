'use strict';

const { AutomationError, requireActor, scopeFor, hash } = require('./service');
const fail = (code, message, status = 400) => { throw new AutomationError(code, message, status); };
const tableFor = kind => {
    if (!['auto', 'price'].includes(kind)) fail('INVALID_MONITOR', '監視の種類が不正です。');
    return kind === 'auto' ? 'auto_watch' : 'price_watch';
};
const scopeOf = row => row.scope || (row.destination_type !== 'dm' && row.guild_id ? 'guild' : 'private');
function assertMonitorAccess(actor, row, write = false) {
    requireActor(actor);
    if (!row) fail('NOT_FOUND', '監視が見つかりません。', 404);
    // Private rules and destinations cannot be disclosed to a guild editor
    // merely because the original command was invoked in that guild.
    if (scopeOf(row) === 'private' || row.destination_type === 'dm') {
        if (String(row.user_id) !== actor.userId) fail('NOT_FOUND', '監視が見つかりません。', 404);
    } else if (row.guild_id !== actor.guildId || !(write ? actor.canEdit : actor.canView)) fail('FORBIDDEN', 'サーバーの操作権限がありません。', 403);
}
function publicMonitor(kind, row) {
    return { kind, id: String(row.id), ownerId: row.user_id, scope: scopeOf(row), guildId: row.guild_id,
        name: row.monitor_name || row.product_name || row.source_url || row.product_url, revision: Number(row.revision || 1),
        providerId: row.provider_id, source: row.source_url || row.product_url, locale: row.source_locale || 'ja', enabled: !!row.enabled,
        destinationId: row.destination_id, destinationType: row.destination_type, channelId: row.origin_channel_id,
        workflowId: row.workflow_id, mode: row.watch_mode, maxPriceAmount: row.max_price_amount == null ? null : Number(row.max_price_amount),
        minDiscountPercent: row.min_discount_percent == null ? null : Number(row.min_discount_percent),
        lastCheckedAtMs: Number(row.last_checked_at_ms || 0), nextCheckAtMs: Number(row.next_check_at_ms || 0),
        errorCode: row.last_error_code, premium: !!row.premium_slot };
}

function createMonitors(db, service, destinations, options = {}) {
    const auto = options.auto || require('../providers/autoWatch');
    const price = options.price || require('../providers/priceWatch');
    const slotDecision = options.slotDecision || require('../providers/autoWatch/store')._internal.slotDecision;
    const normalizeRule = options.normalizeRule || require('../providers/priceWatch/store').normalizeRule;
    async function lockSlots(query, kind) {
        if (kind !== 'auto') return;
        await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,0)', [hash('auto-watch-slots')]);
        await query('SELECT counter_key FROM automation_counters WHERE counter_key=? FOR UPDATE', [hash('auto-watch-slots')]);
    }
    function providers() {
        return { auto: Object.values(auto.PROVIDERS).map(p => ({ id: p.id, intervalMs: p.defaultPollMs, rate: auto.ratePolicy(p.id) })),
            price: Object.values(price.PROVIDERS).map(p => ({ id: p.id, intervalMs: p.defaultPollMs })), twitterRegistrationEnabled: false };
    }
    function selection(kind) {
        const table = tableFor(kind);
        return `SELECT t.*,s.provider_id,${kind === 'auto' ? 's.source_key,s.source_url' : 's.product_key,s.product_url,s.product_name,s.source_locale'},
            s.last_checked_at_ms,s.next_check_at_ms,s.last_error_code,m.name AS monitor_name,m.scope,m.destination_id,m.revision,a.workflow_id
            FROM ${table}_targets t JOIN ${table}_sources s ON s.id=t.source_id
            LEFT JOIN automation_monitors m ON m.target_kind='${kind}' AND m.target_id=t.id
            LEFT JOIN automation_assignments a ON a.target_kind='${kind}' AND a.target_id=t.id`;
    }
    async function getRow(actor, kind, id, write = false, query = db.queryDatabase, lock = false) {
        if (!/^\d{1,20}$/.test(String(id))) fail('NOT_FOUND', '監視が見つかりません。', 404);
        const rows = await query(`${selection(kind)} WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`, [String(id)]);
        assertMonitorAccess(actor, rows[0], write);
        return rows[0];
    }
    async function list(actor, kind, afterId = '0') {
        requireActor(actor);
        if (!/^\d{1,20}$/.test(afterId)) fail('INVALID_CURSOR', 'ページ位置が不正です。');
        const rows = await db.queryDatabase(`${selection(kind)} WHERE t.id>? AND
            ((t.user_id=? AND (COALESCE(m.scope,IF(t.destination_type='dm' OR t.guild_id IS NULL,'private','guild'))='private' OR t.destination_type='dm'))
            OR (t.guild_id=? AND ?=1 AND t.destination_type<>'dm' AND COALESCE(m.scope,'guild')='guild')) ORDER BY t.id LIMIT 101`,
        [afterId, actor.userId, actor.guildId || null, actor.canView ? 1 : 0]);
        const selected = rows.slice(0, 100);
        return { items: selected.map(row => publicMonitor(kind, row)), nextCursor: rows.length > 100 ? String(selected.at(-1).id) : null };
    }
    async function destination(actor, id, scope, ownerId, query = db.queryDatabase) {
        const row = await service.getRow('destination', actor, id, true, query);
        if (!row.enabled) fail('DESTINATION_DISABLED', '通知先が停止中です。');
        if (scope === 'guild' && (row.scope !== 'guild' || row.guild_id !== actor.guildId || row.kind === 'dm')) fail('DESTINATION_SCOPE', '共有監視には同じサーバーの共有通知先を使ってください。');
        if (row.kind === 'dm' && row.dm_user_id !== ownerId) fail('DM_OWNER', '他の人の監視を自分のDMへ変更できません。');
        let nsfw = false;
        if (row.kind !== 'dm') {
            if (row.guild_id !== actor.guildId) fail('DESTINATION_SCOPE', '通知先のサーバーで操作してください。');
            const verified = await destinations.verifyChannel(actor, row.guild_id, row.channel_id);
            nsfw = verified.channel.nsfw === true;
        }
        return { row, nsfw, key: row.kind === 'dm' ? `dm:${ownerId}` : `webhook:${row.webhook_endpoint_id}` };
    }
    async function cancelPending(query, kind, id) {
        await query(`UPDATE ${tableFor(kind)}_deliveries SET status='cancelled',lease_token=NULL,lease_expires_at_ms=0 WHERE target_id=? AND status='pending'`, [id]);
        await query("UPDATE automation_jobs j JOIN automation_runs r ON r.id=j.run_id SET j.state='cancelled',j.updated_at_ms=? WHERE r.target_kind=? AND r.target_id=? AND j.state IN ('pending','held','leased','aggregated') AND j.execution_version=1", [Date.now(), kind, id]);
        // Execution-v2 may have grouped this monitor with other healthy
        // monitors. Revoke only this run's membership; the flow coordinator
        // will preserve eligible peers instead of cancelling a shared batch.
        await query("UPDATE automation_flow_runs f JOIN automation_runs r ON r.id=f.run_id SET f.revoked_at_ms=COALESCE(f.revoked_at_ms,?),f.revocation_code=COALESCE(f.revocation_code,'MONITOR_CHANGED'),f.needs_sync=1 WHERE r.target_kind=? AND r.target_id=?", [Date.now(), kind, id]);
    }
    async function save(actor, kind, input, id = null) {
        requireActor(actor); tableFor(kind);
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '設定が不正です。');
        const current = id ? await getRow(actor, kind, id, true) : null;
        if (current && Number(current.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。再読み込みしてください。', 409);
        const ownerId = current?.user_id || actor.userId;
        const scope = current ? scopeOf(current) : scopeFor(actor, input.scope || 'private').scope;
        if (current && input.scope && input.scope !== scope) fail('SCOPE_IMMUTABLE', '公開範囲は変更できません。');
        const providerId = input.providerId || current?.provider_id;
        if (['twitter', 'x'].includes(String(providerId).toLowerCase())) fail('TWITTER_REGISTRATION_PAUSED', 'Twitterの新規監視登録は停止しています。');
        const name = String(input.name ?? current?.monitor_name ?? '新しい監視').trim();
        if (!name || name.length > 120) fail('NAME_REQUIRED', '名前は1〜120文字です。');
        const sourceInput = input.source || current?.source_url || current?.product_url;
        if (typeof sourceInput !== 'string' || sourceInput.length > 2000) fail('INVALID_SOURCE', '監視URLは2000文字以内で入力してください。');
        const locale = String(input.locale || current?.source_locale || 'ja');
        if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(locale)) fail('INVALID_LOCALE', '言語・地域の指定が不正です。');
        let normalized, rule;
        try {
            normalized = kind === 'auto' ? auto.normalizeSource(providerId, sourceInput) : price.normalizeSource(providerId, { url: sourceInput, locale });
            if (kind === 'price') rule = normalizeRule({ mode: input.mode ?? current?.watch_mode, maxPriceAmount: input.maxPriceAmount === undefined ? current?.max_price_amount : input.maxPriceAmount, minDiscountPercent: input.minDiscountPercent === undefined ? current?.min_discount_percent : input.minDiscountPercent });
        } catch { fail('INVALID_SOURCE_OR_RULE', '監視URL・プロバイダー・価格条件を確認してください。'); }
        const destId = input.destinationId || current?.destination_id;
        // Legacy targets can be paused/deleted without knowing or redisclosing
        // the old secret. Editing their source/destination requires choosing a
        // newly verified destination explicitly.
        if (current && Object.keys(input).every(k => ['expectedRevision', 'enabled', 'name'].includes(k))) {
            return db.withDatabaseTransaction(async query => {
                await lockSlots(query, kind);
                const locked = await getRow(actor, kind, id, true, query, true);
                if (Number(locked.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
                const enabled = input.enabled === undefined ? !!locked.enabled : input.enabled === true;
                if (enabled && !locked.enabled && kind === 'auto') {
                    const slot = await slotDecision(query, ownerId);
                    await query('UPDATE auto_watch_targets SET premium_slot=? WHERE id=?', [slot.premiumSlot, id]);
                }
                await query(`UPDATE ${tableFor(kind)}_targets SET enabled=? WHERE id=?`, [enabled ? 1 : 0, id]);
                if (enabled && !locked.enabled) await query(`UPDATE ${tableFor(kind)}_targets SET baseline_at_ms=NULL,created_at_ms=?${kind === 'price' ? ',condition_active=0' : ''} WHERE id=?`, [Date.now(), id]);
                await query('INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,?,2) ON DUPLICATE KEY UPDATE name=VALUES(name),revision=revision+1', [kind, id, name, scope]);
                if (!enabled) await cancelPending(query, kind, id);
                await service.audit(query, actor, `${kind}:${id}`, 'monitor.update', { enabled }, locked.guild_id);
                return { id: String(id), revision: Number(locked.revision || 1) + 1 };
            });
        }
        if (!destId) fail('DESTINATION_REQUIRED', '検証済みの通知先を選んでください。');
        const dest = await destination(actor, destId, scope, ownerId);
        const enabled = input.enabled === undefined ? current ? !!current.enabled : true : input.enabled === true;
        return db.withDatabaseTransaction(async query => {
            await lockSlots(query, kind);
            let locked;
            if (id) {
                locked = await getRow(actor, kind, id, true, query, true);
                if (Number(locked.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
            }
            // Lock the destination against concurrent disable/delete after its
            // remote permission check and before adopting its identity.
            const freshDest = await service.getRow('destination', actor, destId, true, query, true);
            if (!freshDest.enabled || freshDest.revision !== dest.row.revision) fail('DESTINATION_CHANGED', '通知先が変更されました。再試行してください。', 409);
            await query('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,?)', [ownerId, Date.now()]);
            let premium = Number(locked?.premium_slot || 0);
            if (kind === 'auto' && enabled && !locked?.enabled) {
                premium = (await slotDecision(query, ownerId)).premiumSlot;
            }
            const now = Date.now(), initialDue = now + Math.floor(Math.random() * 300000);
            const table = tableFor(kind);
            if (kind === 'auto') await query(`INSERT INTO ${table}_sources (provider_id,source_key,source_url,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [providerId, normalized.sourceKey, normalized.sourceUrl, auto.provider(providerId).defaultPollMs, initialDue, now]);
            else await query(`INSERT INTO ${table}_sources (provider_id,product_key,product_url,source_locale,poll_interval_ms,next_check_at_ms,created_at_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [providerId, normalized.productKey, normalized.productUrl, normalized.sourceLocale, price.nextIntervalMs(providerId), initialDue, now]);
            const sourceRows = await query(`SELECT id FROM ${table}_sources WHERE provider_id=? AND ${kind === 'auto' ? 'source_key=?' : 'product_key=? AND source_locale=?'}`, kind === 'auto' ? [providerId, normalized.sourceKey] : [providerId, normalized.productKey, normalized.sourceLocale]);
            const sourceId = sourceRows[0].id;
            const duplicate = await query(`SELECT id FROM ${table}_targets WHERE user_id=? AND source_id=? AND destination_key=?${kind === 'price' ? ' AND watch_mode=? AND rule_key=?' : ''} AND id<>?`, [ownerId, sourceId, dest.key, ...(kind === 'price' ? [rule.mode, rule.ruleKey] : []), id || 0]);
            if (duplicate.length) fail('MONITOR_EXISTS', '同じ対象・通知先・条件の監視が既にあります。既存の監視を編集してください。', 409);
            const guildId = dest.row.kind === 'dm' ? current?.guild_id || actor.guildId || null : dest.row.guild_id;
            const fields = /** @type {Record<string,any>} */ ({ source_id: sourceId, user_id: ownerId, guild_id: guildId, origin_channel_id: dest.row.channel_id,
                destination_type: dest.row.kind, destination_key: dest.key, webhook_endpoint_id: dest.row.webhook_endpoint_id,
                enabled: enabled ? 1 : 0, ...(kind === 'auto' ? { premium_slot: premium, source_locale: locale, origin_channel_nsfw: dest.nsfw ? 1 : 0 }
                    : { watch_mode: rule.mode, rule_key: rule.ruleKey, max_price_amount: rule.maxPriceAmount, min_discount_percent: rule.minDiscountPercent, condition_active: 0 }) });
            const identityChanged = !locked || String(locked.source_id) !== String(sourceId) || locked.destination_key !== dest.key || kind === 'price' && locked.rule_key !== rule.ruleKey || !locked.enabled && enabled;
            if (identityChanged) fields.baseline_at_ms = null;
            if (kind === 'price' && !identityChanged) fields.condition_active = Number(locked.condition_active || 0);
            let targetId = id;
            if (id) {
                await query(`UPDATE ${table}_targets SET ${Object.keys(fields).map(k => `${k}=?`).join(',')} WHERE id=?`, [...Object.values(fields), id]);
                await cancelPending(query, kind, id);
            } else {
                const values = { ...fields, created_at_ms: now };
                const inserted = await query(`INSERT INTO ${table}_targets (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`, Object.values(values));
                targetId = String(inserted.insertId);
            }
            await query('INSERT INTO automation_monitors (target_kind,target_id,name,scope,destination_id,revision) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),destination_id=VALUES(destination_id),revision=revision+1', [kind, targetId, name, scope, destId, id ? Number(locked.revision || 1) + 1 : 1]);
            await service.audit(query, actor, `${kind}:${targetId}`, id ? 'monitor.update' : 'monitor.create', { providerId, destinationId: destId, enabled, usagePolicyVersion: require('./safety').POLICY_VERSION }, guildId);
            return { id: String(targetId), revision: id ? Number(locked.revision || 1) + 1 : 1 };
        });
    }
    async function remove(actor, kind, id, expectedRevision) {
        return db.withDatabaseTransaction(async query => {
            const row = await getRow(actor, kind, id, true, query, true);
            if (Number(row.revision || 1) !== expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
            await cancelPending(query, kind, id);
            await query('DELETE FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, id]);
            await query('DELETE FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, id]);
            await query(`DELETE FROM ${tableFor(kind)}_targets WHERE id=?`, [id]);
            // Keep source observations shared with other targets and forensic
            // run history. Orphan-source GC is a separate retention operation.
            await service.audit(query, actor, `${kind}:${id}`, 'monitor.delete', {}, row.guild_id);
            return { deleted: true };
        });
    }
    async function detach(actor, kind, id, expectedRevision) {
        return db.withDatabaseTransaction(async query => {
            const row = await getRow(actor, kind, id, true, query, true);
            if (Number(row.revision || 1) !== expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
            await query('DELETE FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, id]);
            await cancelPending(query, kind, id);
            await service.audit(query, actor, `${kind}:${id}`, 'monitor.detach', {}, row.guild_id);
            return { detached: true };
        });
    }
    return { providers, list, getRow, save, remove, detach };
}
module.exports = { createMonitors, assertMonitorAccess, scopeOf, publicMonitor };
