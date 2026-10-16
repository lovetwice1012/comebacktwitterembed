'use strict';

const { AutomationError, requireActor, scopeFor, hash } = require('./service');
const entitlements = require('./entitlements');
const eligibility = require('../providers/autoWatch/eligibility');
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
        workflowId: row.workflow_id, workflowStatus: row.workflow_status ?? (row.workflow_id ? 'unknown' : null),
        destinationStatus: row.destination_status ?? (row.destination_id ? 'unknown' : null),
        mode: row.watch_mode, maxPriceAmount: row.max_price_amount == null ? null : Number(row.max_price_amount),
        minDiscountPercent: row.min_discount_percent == null ? null : Number(row.min_discount_percent),
        ...(kind === 'auto' ? require('../providers/autoWatch/target-timing').targetTiming(row) : {
            lastCheckedAtMs: Number(row.last_checked_at_ms || 0), nextCheckAtMs: Number(row.next_check_at_ms || 0),
        }),
        intervalMinutes: kind === 'auto' ? row.cadence_info?.intervalMs / 60000 || Number(row.user_interval_minutes ?? Number(row.poll_interval_ms) / 60000) : undefined,
        baseIntervalMinutes: kind === 'auto' ? Number(row.user_interval_minutes ?? Number(row.poll_interval_ms) / 60000) : undefined,
        slotCost: Number(row.slot_cost || 1), effectiveSlotCost: row.cadence_info?.effectiveSlotCost || 1,
        cadenceUpdatedAtMs: row.cadence_updated_at_ms == null ? null : Number(row.cadence_updated_at_ms), cadenceLimited: row.cadence_info?.limited === true,
        errorCode: row.last_error_code, premium: !!row.premium_slot };
}

// Source completion locks its source before targets. Assignment changes use
// the same order after the owner fence, including price watches.
async function lockMonitorSource(query, ownerId, kind, targetId) {
    tableFor(kind);
    if (kind === 'auto') return require('./monitor-cadence').lockTargetSource(query, ownerId, String(targetId));
    const target = (await query('SELECT source_id FROM price_watch_targets WHERE id=? AND user_id=?', [targetId, ownerId]))[0];
    if (!target) return null;
    return (await query('SELECT id FROM price_watch_sources WHERE id=? FOR UPDATE', [target.source_id]))[0] || null;
}

async function advanceMonitorRevision(query, kind, id, scope, previousRevision) {
    tableFor(kind);
    const revision = previousRevision + 1;
    // A legacy target may have no metadata row. An empty saved label keeps
    // publicMonitor's existing source/product-name fallback unchanged.
    await query("INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,'',?,?) ON DUPLICATE KEY UPDATE revision=revision+1", [kind, id, scope, revision]);
    return revision;
}

async function cancelPending(query, kind, id) {
    await query(`UPDATE ${tableFor(kind)}_deliveries SET status='cancelled',lease_token=NULL,lease_expires_at_ms=0 WHERE target_id=? AND status='pending'`, [id]);
    await query("UPDATE automation_jobs j JOIN automation_runs r ON r.id=j.run_id SET j.state='cancelled',j.updated_at_ms=? WHERE r.target_kind=? AND r.target_id=? AND j.state IN ('pending','held','leased','aggregated') AND j.execution_version=1", [Date.now(), kind, id]);
    // Preserve healthy peers in shared execution-v2 batches. The coordinator
    // removes only this target's revoked membership before physical delivery.
    await query("UPDATE automation_flow_runs f JOIN automation_runs r ON r.id=f.run_id SET f.revoked_at_ms=COALESCE(f.revoked_at_ms,?),f.revocation_code=COALESCE(f.revocation_code,'MONITOR_CHANGED'),f.needs_sync=1 WHERE r.target_kind=? AND r.target_id=?", [Date.now(), kind, id]);
}

function createMonitors(db, service, destinations, options = {}) {
    const auto = options.auto || require('../providers/autoWatch');
    const price = options.price || require('../providers/priceWatch');
    const normalizeRule = options.normalizeRule || require('../providers/priceWatch/store').normalizeRule;
    async function lockSlots(query, kind) {
        if (kind !== 'auto') return;
        await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,0)', [hash('auto-watch-slots')]);
        await query('SELECT counter_key FROM automation_counters WHERE counter_key=? FOR UPDATE', [hash('auto-watch-slots')]);
    }
    async function providers(actor) {
        requireActor(actor);
        return { auto: Object.values(auto.PROVIDERS).map(p => ({ id: p.id, intervalMs: p.defaultPollMs, rate: auto.ratePolicy(p.id) })),
            price: Object.values(price.PROVIDERS).map(p => ({ id: p.id, intervalMs: p.defaultPollMs })), twitterRegistrationEnabled: false,
            autoRegistration: await eligibility.registrationStatus(db.queryDatabase, actor.userId) };
    }
    async function preview(actor, kind, input) {
        requireActor(actor); tableFor(kind);
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '設定が不正です。');
        const providerId = String(input.providerId || '').toLowerCase(), source = String(input.source || '').trim();
        if (!source || source.length > 2000) fail('INVALID_SOURCE', '監視対象は1〜2000文字で入力してください。');
        const library = kind === 'auto' ? auto : price, adapter = library.PROVIDERS[providerId];
        if (!adapter) fail('UNSUPPORTED_PROVIDER', 'このサービスは選択した種類の監視に対応していません。');
        const locale = String(input.locale || 'ja');
        if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(locale)) fail('INVALID_LOCALE', '言語・地域を選び直してください。');
        let normalized;
        try { normalized = kind === 'auto' ? auto.normalizeSource(providerId, source) : price.normalizeSource(providerId, { url: source, locale }); }
        catch { fail('INVALID_SOURCE', require('./monitor-input').sourceGuidance(providerId).help); }
        return { providerId, kind, source: normalized.sourceUrl || normalized.productUrl,
            intervalMinutes: adapter.defaultPollMs / 60000,
            description: kind === 'auto' ? '初回は基準を記録し、その後の新しい投稿を通知します。' : '初回の価格を基準に、以降の価格変化や指定条件を確認します。',
            verified: 'format_only' };
    }
    function deliveryStateSQL() {
        const scope = "COALESCE(m.scope,IF(t.destination_type='dm' OR t.guild_id IS NULL,'private','guild'))";
        return {
            workflow: `CASE WHEN a.workflow_id IS NULL THEN NULL
                WHEN sw.id IS NULL OR sw.deleted_at_ms IS NOT NULL OR sw.scope<>${scope}
                    OR (sw.scope='private' AND sw.owner_user_id<>t.user_id)
                    OR (sw.scope='guild' AND (sw.guild_id IS NULL OR sw.guild_id<>t.guild_id OR t.destination_type='dm')) THEN 'missing'
                WHEN sw.active_revision IS NULL THEN 'unapplied'
                WHEN sr.workflow_id IS NULL THEN 'missing'
                WHEN sw.enabled<>1 THEN 'paused' ELSE 'active' END`,
            destination: `CASE WHEN m.destination_id IS NULL THEN NULL
                WHEN sd.id IS NULL OR sd.deleted_at_ms IS NOT NULL OR sd.scope NOT IN ('private','guild')
                    OR (${scope}='guild' AND sd.scope<>'guild')
                    OR (sd.scope='private' AND sd.owner_user_id<>t.user_id)
                    OR (sd.scope='guild' AND (sd.guild_id IS NULL OR sd.guild_id<>t.guild_id OR sd.kind='dm'))
                    OR (sd.kind='dm' AND sd.dm_user_id<>t.user_id) THEN 'missing'
                WHEN sd.enabled<>1 THEN 'paused' ELSE 'active' END`,
        };
    }
    function selection(kind, includeDeliveryState = false) {
        const table = tableFor(kind);
        const state = includeDeliveryState ? deliveryStateSQL() : null;
        return `SELECT t.*,s.provider_id,${kind === 'auto' ? 's.source_key,s.source_url' : 's.product_key,s.product_url,s.product_name,s.source_locale'},
            s.last_checked_at_ms,s.next_check_at_ms,s.last_error_code,s.poll_interval_ms,
            ${kind === 'auto' ? '(SELECT auto_watch_interval_minutes FROM users WHERE user_id=t.user_id) AS user_interval_minutes,' : ''}m.name AS monitor_name,m.scope,m.destination_id,m.revision,a.workflow_id,c.slot_cost,c.updated_at_ms AS cadence_updated_at_ms${state ? `,${state.workflow} AS workflow_status,${state.destination} AS destination_status` : ''}
            FROM ${table}_targets t JOIN ${table}_sources s ON s.id=t.source_id
            LEFT JOIN automation_monitors m ON m.target_kind='${kind}' AND m.target_id=t.id
            LEFT JOIN automation_monitor_cadence c ON c.target_kind='${kind}' AND c.target_id=t.id AND c.owner_user_id=t.user_id
            LEFT JOIN automation_assignments a ON a.target_kind='${kind}' AND a.target_id=t.id${state ? `
            LEFT JOIN automation_workflows sw ON sw.id=a.workflow_id
            LEFT JOIN automation_revisions sr ON sr.workflow_id=sw.id AND sr.revision=sw.active_revision
            LEFT JOIN automation_destinations sd ON sd.id=m.destination_id` : ''}`;
    }
    async function getRow(actor, kind, id, write = false, query = db.queryDatabase, lock = false) {
        if (!/^\d{1,20}$/.test(String(id))) fail('NOT_FOUND', '監視が見つかりません。', 404);
        const rows = await query(`${selection(kind)} WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`, [String(id)]);
        assertMonitorAccess(actor, rows[0], write);
        return rows[0];
    }
    async function list(actor, kind, afterId = '0', filters = {}) {
        requireActor(actor);
        if (!/^\d{1,20}$/.test(afterId)) fail('INVALID_CURSOR', 'ページ位置が不正です。');
        const needle = String(filters.query || '').trim().normalize('NFC'), state = filters.state || 'all';
        if (needle.length > 2000 || !['all', 'active', 'attention', 'paused'].includes(state)) fail('INVALID_FILTER', '検索条件を確認してください。');
        const clauses = [], params = [];
        if (needle) {
            const pattern = '%' + needle.replace(/[=%_]/g, '=$&') + '%';
            clauses.push(`(COALESCE(m.name,${kind === 'price' ? 's.product_name' : "''"},'') LIKE ? ESCAPE '=' OR s.provider_id LIKE ? ESCAPE '=' OR ${kind === 'auto' ? 's.source_url' : 's.product_url'} LIKE ? ESCAPE '=')`);
            params.push(pattern, pattern, pattern);
        }
        const status = deliveryStateSQL();
        const blocked = `(COALESCE((${status.workflow}),'active')<>'active' OR COALESCE((${status.destination}),'active')<>'active')`;
        if (state === 'active') clauses.push(`t.enabled=1 AND NOT ${blocked}`);
        if (state === 'paused') clauses.push('t.enabled=0');
        if (state === 'attention') clauses.push(`t.enabled=1 AND ((s.last_error_code IS NOT NULL AND s.last_error_code<>'') OR ${blocked})`);
        const rows = await db.queryDatabase(`${selection(kind, true)} WHERE t.id>? AND
            ((t.user_id=? AND (COALESCE(m.scope,IF(t.destination_type='dm' OR t.guild_id IS NULL,'private','guild'))='private' OR t.destination_type='dm'))
            OR (t.guild_id=? AND ?=1 AND t.destination_type<>'dm' AND COALESCE(m.scope,'guild')='guild'))${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''} ORDER BY t.id LIMIT 101`,
        [afterId, actor.userId, actor.guildId || null, actor.canView ? 1 : 0, ...params]);
        const selected = rows.slice(0, 100);
        const items = await Promise.all(selected.map(async row => {
            if (kind === 'auto' && Number(row.slot_cost) > 1) row.cadence_info = await require('./monitor-cadence').runtimeCadence(db.queryDatabase, row.user_id, kind, String(row.id), Number(row.user_interval_minutes ?? Number(row.poll_interval_ms) / 60000) * 60000);
            return { ...publicMonitor(kind, row), canAllocateCadence: kind === 'auto' && String(row.user_id) === actor.userId && (scopeOf(row) === 'private' || actor.canEdit === true) };
        }));
        return { items, nextCursor: rows.length > 100 ? String(selected.at(-1).id) : null };
    }
    async function setCadence(actor, kind, id, input) {
        requireActor(actor); tableFor(kind);
        const current = await getRow(actor, kind, id, true);
        if (String(current.user_id) !== actor.userId) fail('FORBIDDEN', '通知枠の配分は登録した本人が変更してください。', 403);
        return db.withDatabaseTransaction(async query => {
            const cadence = require('./monitor-cadence');
            await entitlements.lockOwner(query, actor.userId);
            if (kind === 'auto') await cadence.lockTargetSource(query, actor.userId, String(id));
            const row = await getRow(actor, kind, id, true, query, true);
            if (Number(row.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '通知が変更されています。読み直してください。', 409);
            await cadence.reserve(query, actor.userId, kind, String(id), input);
            const now = Date.now(), base = Number(row.user_interval_minutes ?? Number(row.poll_interval_ms) / 60000) * 60000;
            const selected = await cadence.runtimeCadence(query, actor.userId, kind, String(id), base, now);
            const next = Number(row.last_polled_at_ms ?? row.last_checked_at_ms ?? now) + selected.intervalMs;
            await query('UPDATE auto_watch_targets SET next_poll_at_ms=? WHERE id=? AND user_id=?', [next, id, actor.userId]);
            await query(`UPDATE auto_watch_deliveries d JOIN auto_watch_items i ON i.id=d.item_id
                SET d.next_attempt_at_ms=GREATEST(i.discovered_at_ms,?,?+?) WHERE d.target_id=? AND d.status='pending' AND d.attempt_count=0 AND d.lease_expires_at_ms<=?`, [next, Number(row.last_notification_window_at_ms || 0), selected.intervalMs, id, now]);
            await require('../providers/autoWatch/intervalPolicy').bringSourceForward(query, actor.userId, row.source_id, now);
            await service.audit(query, actor, `${kind}:${id}`, 'monitor.cadence', { slotCost: selected.slotCost, intervalMs: selected.intervalMs }, row.guild_id);
            return { id: String(id), ...selected };
        });
    }
    async function verifyDestinationChannel(actor, guildId, channelId, ownerId, privateOwner = false) {
        // Private ownership authorizes using the stored guild from the personal
        // page; current Discord membership and channel permissions still apply.
        if (guildId !== actor.guildId && !(privateOwner && ownerId === actor.userId)) fail('DESTINATION_SCOPE', '通知先のサーバーで操作してください。');
        const verified = await destinations.verifyChannel(actor, guildId, channelId);
        // Delivery runs as the original registration owner, not its editor.
        // Re-read that principal's actual Discord roles even for a guild editor.
        if (ownerId !== actor.userId) await destinations.verifyChannel({ ...actor, userId: ownerId }, guildId, channelId);
        return verified.channel.nsfw === true;
    }
    async function destinationForMonitor(actor, id, ownerId, current, query = db.queryDatabase, lock = false) {
        try { return { row: await service.getRow('destination', actor, id, true, query, lock), existingShared: false }; }
        catch (error) {
            // Reusing this owned registration is distinct from editing a shared
            // destination. Its existing ID and guild come only from the target.
            const ownsExisting = current && scopeOf(current) === 'private' && String(current.user_id) === actor.userId && ownerId === actor.userId
                && current.destination_id === id && current.guild_id;
            if (error.code !== 'FORBIDDEN' || !ownsExisting) throw error;
            const row = (await query(`SELECT * FROM automation_destinations WHERE id=? AND scope='guild' AND guild_id=? AND deleted_at_ms IS NULL${lock ? ' FOR UPDATE' : ''}`, [id, current.guild_id]))[0];
            if (!row) throw error;
            return { row, existingShared: true };
        }
    }
    async function destination(actor, id, scope, ownerId, query = db.queryDatabase, current = null) {
        const selected = await destinationForMonitor(actor, id, ownerId, current, query), row = selected.row;
        if (!row.enabled) fail('DESTINATION_DISABLED', '通知先が停止中です。');
        if (scope === 'guild' && (row.scope !== 'guild' || row.guild_id !== actor.guildId || row.kind === 'dm')) fail('DESTINATION_SCOPE', '共有監視には同じサーバーの共有通知先を使ってください。');
        if (row.kind === 'dm' && row.dm_user_id !== ownerId) fail('DM_OWNER', '他の人の監視を自分のDMへ変更できません。');
        let nsfw = false;
        if (row.kind !== 'dm') {
            nsfw = await verifyDestinationChannel(actor, row.guild_id, row.channel_id, ownerId,
                selected.existingShared || row.scope === 'private' && String(row.owner_user_id) === ownerId);
        }
        return { row, nsfw, key: row.kind === 'dm' ? `dm:${ownerId}` : `webhook:${row.webhook_endpoint_id}` };
    }
    const resumeIdentity = row => JSON.stringify([row.user_id, row.destination_id || null, row.destination_type, row.destination_key, row.guild_id, row.origin_channel_id, row.webhook_endpoint_id]);
    const destinationIdentity = row => JSON.stringify([row.id, Number(row.revision), row.scope, row.owner_user_id, row.guild_id, row.kind, row.channel_id, row.dm_user_id, row.webhook_endpoint_id]);
    async function resumeDestination(actor, row, scope, ownerId) {
        const managed = row.destination_id ? await destination(actor, row.destination_id, scope, ownerId, db.queryDatabase, row) : null;
        const kind = managed?.row.kind || row.destination_type;
        if (kind === 'dm' && !managed && row.destination_key !== `dm:${ownerId}`) fail('DM_OWNER', '通知先のDMを確認してください。');
        const endpointId = kind === 'dm' ? null : managed?.row.webhook_endpoint_id || row.webhook_endpoint_id;
        if (kind !== 'dm') {
            if (kind !== 'webhook' || !endpointId || !(await db.queryDatabase('SELECT id FROM webhook_endpoints WHERE id=?', [endpointId])).length) fail('DESTINATION_DELETED', '通知先を選び直してから再開してください。');
            if (!managed) await verifyDestinationChannel(actor, row.guild_id, row.origin_channel_id, ownerId, scope === 'private');
        }
        return { target: resumeIdentity(row), managed: managed?.row, endpointId };
    }
    async function lockResumeDestination(query, actor, row, checked) {
        if (resumeIdentity(row) !== checked.target) fail('REVISION_CONFLICT', '通知先が変更されています。設定を確認し直してください。', 409);
        if (checked.managed) {
            const fresh = (await destinationForMonitor(actor, checked.managed.id, String(row.user_id), row, query, true)).row;
            if (!fresh.enabled || destinationIdentity(fresh) !== destinationIdentity(checked.managed)) fail('DESTINATION_CHANGED', '通知先が変更されました。再試行してください。', 409);
        }
        if (checked.endpointId && !(await query('SELECT id FROM webhook_endpoints WHERE id=? FOR UPDATE', [checked.endpointId])).length) fail('DESTINATION_DELETED', '通知先を選び直してから再開してください。');
    }
    async function save(actor, kind, input, id = null) {
        requireActor(actor); tableFor(kind);
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '設定が不正です。');
        const current = id ? await getRow(actor, kind, id, true) : null;
        if (current && Number(current.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。再読み込みしてください。', 409);
        // A display label does not change the notification identity. Keep the
        // editor CAS revision while recording the exact harmless revision step
        // that existing queued notifications may follow.
        if (current && typeof input.name === 'string' && Object.keys(input).every(key => ['expectedRevision', 'name'].includes(key))) {
            const label = input.name.trim();
            if (!label || label.length > 120) fail('NAME_REQUIRED', '名前は1〜120文字です。');
            return db.withDatabaseTransaction(async query => {
                await entitlements.lockOwner(query, current.user_id);
                if (kind === 'auto') await require('./monitor-cadence').lockTargetSource(query, current.user_id, String(id));
                else {
                    // Price completion locks source before target. Match that order
                    // before the joined getRow locks both records for a label edit.
                    const target = (await query('SELECT source_id FROM price_watch_targets WHERE id=? AND user_id=?', [id, current.user_id]))[0];
                    if (target) await query('SELECT id FROM price_watch_sources WHERE id=? FOR UPDATE', [target.source_id]);
                }
                const locked = await getRow(actor, kind, id, true, query, true);
                const beforeRevision = Number(locked.revision || 1);
                if (beforeRevision !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。再読み込みしてください。', 409);
                if (publicMonitor(kind, locked).name === label) return { id: String(id), revision: beforeRevision };
                await query('INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),revision=revision+1', [kind, id, label, scopeOf(locked), beforeRevision + 1]);
                await service.audit(query, actor, `${kind}:${id}`, 'monitor.rename', { manual: true, metadataOnly: true,
                    ownerUserId: String(locked.user_id), beforeRevision, afterRevision: beforeRevision + 1 }, locked.guild_id);
                return { id: String(id), revision: beforeRevision + 1 };
            });
        }
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
        const enabled = input.enabled === undefined ? current ? !!current.enabled : true : input.enabled === true;
        const needsRegistration = row => kind === 'auto' && (!row || !row.enabled && enabled
            || row.provider_id !== providerId || row.source_key !== normalized.sourceKey
            || (destId || null) !== (row.destination_id || null));
        const passiveUpdate = current && Object.keys(input).every(k => ['expectedRevision', 'enabled', 'name'].includes(k));
        const assertRegistration = async (query, lock = false) => {
            await eligibility.assertRegistrationAllowed(query, actor.userId, lock);
            if (ownerId !== actor.userId) await eligibility.assertRegistrationAllowed(query, ownerId, lock);
        };
        if (kind === 'auto' && (passiveUpdate ? enabled && !current.enabled : needsRegistration(current))) {
            await assertRegistration(db.queryDatabase);
        }
        // Legacy targets can be paused/deleted without knowing or redisclosing
        // the old secret. Editing their source/destination requires choosing a
        // newly verified destination explicitly.
        if (current && Object.keys(input).every(k => ['expectedRevision', 'enabled', 'name'].includes(k))) {
            const checked = enabled && !current.enabled ? await resumeDestination(actor, current, scope, ownerId) : null;
            return db.withDatabaseTransaction(async query => {
                await entitlements.lockOwner(query, ownerId);
                await lockSlots(query, kind);
                if (kind === 'auto') await require('./monitor-cadence').lockTargetSource(query, ownerId, String(id));
                const locked = await getRow(actor, kind, id, true, query, true);
                if (Number(locked.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
                const enabled = input.enabled === undefined ? !!locked.enabled : input.enabled === true;
                if (enabled && !locked.enabled && locked.workflow_id) {
                    const workflow = await service.getRow('workflow', actor, locked.workflow_id, true, query, true);
                    await service.validateWorkflowDestinations(query, workflow, [ownerId, actor.userId]);
                }
                if (checked) await lockResumeDestination(query, actor, locked, checked);
                if (enabled) {
                    const slot = await entitlements.assertSlotAvailable(query, ownerId, kind, id);
                    if (kind === 'auto') {
                        if (!locked.enabled) await assertRegistration(query, true);
                        await query('UPDATE auto_watch_targets SET premium_slot=? WHERE id=?', [slot.priority > 0 ? 1 : 0, id]);
                    }
                }
                await query(`UPDATE ${tableFor(kind)}_targets SET enabled=? WHERE id=?`, [enabled ? 1 : 0, id]);
                if (enabled && !locked.enabled) {
                    await query(`UPDATE ${tableFor(kind)}_targets SET baseline_at_ms=NULL,created_at_ms=?${kind === 'price' ? ',condition_active=0' : ',last_polled_at_ms=NULL,next_poll_at_ms=NULL,last_notification_window_at_ms=NULL'} WHERE id=?`, [Date.now(), id]);
                    if (kind === 'auto') await require('../providers/autoWatch/intervalPolicy').bringSourceForward(query, ownerId, locked.source_id, Date.now());
                }
                await query('INSERT INTO automation_monitors (target_kind,target_id,name,scope,revision) VALUES (?,?,?,?,2) ON DUPLICATE KEY UPDATE name=VALUES(name),revision=revision+1', [kind, id, name, scope]);
                if (!enabled) await cancelPending(query, kind, id);
                await service.audit(query, actor, `${kind}:${id}`, 'monitor.update', { enabled }, locked.guild_id);
                return { id: String(id), revision: Number(locked.revision || 1) + 1 };
            });
        }
        if (!destId) fail('DESTINATION_REQUIRED', '検証済みの通知先を選んでください。');
        const dest = await destination(actor, destId, scope, ownerId, db.queryDatabase, current);
        return db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, ownerId);
            await lockSlots(query, kind);
            let locked;
            if (id) {
                if (kind === 'auto') await require('./monitor-cadence').lockTargetSource(query, ownerId, String(id));
                locked = await getRow(actor, kind, id, true, query, true);
                if (Number(locked.revision || 1) !== input.expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
            }
            if (enabled && locked && !locked.enabled && locked.workflow_id) {
                const workflow = await service.getRow('workflow', actor, locked.workflow_id, true, query, true);
                await service.validateWorkflowDestinations(query, workflow, [ownerId, actor.userId]);
            }
            if (needsRegistration(locked)) await assertRegistration(query, true);
            if (!id || enabled) await entitlements.assertSlotAvailable(query, ownerId, kind, id || undefined);
            // Lock the destination against concurrent disable/delete after its
            // remote permission check and before adopting its identity.
            const freshDest = (await destinationForMonitor(actor, destId, ownerId, locked, query, true)).row;
            if (!freshDest.enabled || freshDest.revision !== dest.row.revision) fail('DESTINATION_CHANGED', '通知先が変更されました。再試行してください。', 409);
            await query('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,?)', [ownerId, Date.now()]);
            let premium = Number(locked?.premium_slot || 0);
            if (kind === 'auto' && enabled) premium = (await entitlements.inspectPlan(query, ownerId)).priority > 0 ? 1 : 0;
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
            if (kind === 'auto' && identityChanged) Object.assign(fields, { last_polled_at_ms: null, next_poll_at_ms: null, last_notification_window_at_ms: null });
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
            if (!id || enabled) await entitlements.assignSlot(query, ownerId, kind, String(targetId));
            if (kind === 'auto' && enabled) await require('../providers/autoWatch/intervalPolicy').bringSourceForward(query, ownerId, sourceId, now);
            await query('INSERT INTO automation_monitors (target_kind,target_id,name,scope,destination_id,revision) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),destination_id=VALUES(destination_id),revision=revision+1', [kind, targetId, name, scope, destId, id ? Number(locked.revision || 1) + 1 : 1]);
            await service.audit(query, actor, `${kind}:${targetId}`, id ? 'monitor.update' : 'monitor.create', { providerId, destinationId: destId, enabled, usagePolicyVersion: require('./safety').POLICY_VERSION }, guildId);
            return { id: String(targetId), revision: id ? Number(locked.revision || 1) + 1 : 1 };
        });
    }
    async function remove(actor, kind, id, expectedRevision) {
        const current = await getRow(actor, kind, id, true);
        return db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, current.user_id);
            if (kind === 'auto') await require('./monitor-cadence').lockTargetSource(query, current.user_id, String(id));
            const row = await getRow(actor, kind, id, true, query, true);
            if (Number(row.revision || 1) !== expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
            await cancelPending(query, kind, id);
            await query('DELETE FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, id]);
            await query('DELETE FROM automation_monitors WHERE target_kind=? AND target_id=?', [kind, id]);
            await query(`DELETE FROM ${tableFor(kind)}_targets WHERE id=?`, [id]);
            await entitlements.releaseSlot(query, current.user_id, kind, id);
            // Keep source observations shared with other targets and forensic
            // run history. Orphan-source GC is a separate retention operation.
            await service.audit(query, actor, `${kind}:${id}`, 'monitor.delete', {}, row.guild_id);
            return { deleted: true };
        });
    }
    async function detach(actor, kind, id, expectedRevision, guards = undefined) {
        let guarded;
        if (guards !== undefined) {
            if (!guards || typeof guards !== 'object' || Array.isArray(guards) || Object.keys(guards).some(key => key !== 'expectedWorkflowId')) fail('INVALID_ASSIGNMENT_GUARD', '現在の通知ルールを確認してください。');
            guarded = require('./service').validateAssignmentGuards({ expectedRevision, ...guards });
        }
        const current = await getRow(actor, kind, id, true);
        return db.withDatabaseTransaction(async query => {
            await entitlements.lockOwner(query, current.user_id);
            await lockMonitorSource(query, current.user_id, kind, id);
            const row = await getRow(actor, kind, id, true, query, true);
            if (Number(row.revision || 1) !== expectedRevision) fail('REVISION_CONFLICT', '監視が更新されています。', 409);
            const assignment = (await query('SELECT workflow_id FROM automation_assignments WHERE target_kind=? AND target_id=? FOR UPDATE', [kind, id]))[0];
            const beforeWorkflowId = assignment?.workflow_id ?? null;
            if (guarded && beforeWorkflowId !== guarded.expectedWorkflowId) fail('REVISION_CONFLICT', '通知ルールが別の操作で変更されています。最新の通知を読み直してください。', 409);
            if (beforeWorkflowId === null) return { detached: true, unchanged: true, revision: Number(row.revision || 1) };
            await query('DELETE FROM automation_assignments WHERE target_kind=? AND target_id=?', [kind, id]);
            const revision = await advanceMonitorRevision(query, kind, id, scopeOf(row), Number(row.revision || 1));
            await cancelPending(query, kind, id);
            await service.audit(query, actor, `${kind}:${id}`, 'monitor.detach', guarded ? { guarded: true, beforeWorkflowId,
                afterWorkflowId: null, beforeRevision: Number(row.revision || 1), afterRevision: revision } : {}, row.guild_id);
            return { detached: true, revision };
        });
    }
    const operate = (actor, work) => service.withOperation(actor, 'monitor', work);
    return { providers, preview: (actor, kind, input) => operate(actor, () => preview(actor, kind, input)), list, getRow,
        save: (actor, kind, input, id) => id && input.enabled === false && Object.keys(input).every(key => ['expectedRevision', 'enabled'].includes(key)) ? save(actor, kind, input, id) : operate(actor, () => save(actor, kind, input, id)), remove, detach,
        setCadence: (actor, kind, id, input) => input.slotCost === 1 ? setCadence(actor, kind, id, input) : operate(actor, () => setCadence(actor, kind, id, input)) };
}
module.exports = { createMonitors, assertMonitorAccess, scopeOf, publicMonitor, lockMonitorSource, advanceMonitorRevision, cancelPending };
