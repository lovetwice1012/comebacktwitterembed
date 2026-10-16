'use strict';

function failure(code, row) {
    return Object.assign(new Error('An existing notification destination needs verification or explicit repair.'), { code, targetId: String(row.id), status: code === 'NATIVE_CHANNEL_REPAIR_REQUIRED' ? 409 : 503 });
}

async function legacyChannelRegistration(query, { kind, userId, sourceId, guildId, channelId, endpointId, rule = { mode: '', ruleKey: '' }, verify }) {
    const table = kind === 'auto' ? 'auto_watch_targets' : 'price_watch_targets';
    const rows = await query(`SELECT t.*,w.webhook_url,m.destination_id AS managed_id,
        d.owner_user_id AS managed_owner,d.guild_id AS managed_guild,d.channel_id AS managed_channel,
        d.scope AS managed_scope,d.kind AS managed_kind,d.enabled AS managed_enabled,d.deleted_at_ms AS managed_deleted,d.webhook_endpoint_id AS managed_endpoint,d.revision AS managed_revision
        FROM ${table} t LEFT JOIN webhook_endpoints w ON w.id=t.webhook_endpoint_id
        LEFT JOIN automation_monitors m ON m.target_kind=? AND m.target_id=t.id
        LEFT JOIN automation_destinations d ON d.id=m.destination_id
        WHERE t.user_id=? AND t.source_id=? AND t.guild_id=? AND t.destination_type='webhook' AND t.destination_key LIKE 'webhook:%'
        ${kind === 'price' ? 'AND t.watch_mode=? AND t.rule_key=?' : ''} ORDER BY t.id FOR UPDATE`,
    [kind, userId, sourceId, guildId, ...(kind === 'price' ? [rule.mode, rule.ruleKey] : [])]);
    const matches = []; let uncertain;
    const deadline = Date.now() + 30000;
    for (const row of rows) {
        const managed = row.managed_id && row.managed_owner === userId && row.managed_scope === 'private' && row.managed_kind === 'webhook' && row.managed_guild === guildId && row.managed_channel;
        if (managed) {
            if (row.managed_channel !== channelId) continue;
            if (row.managed_deleted || !row.managed_enabled) { uncertain ||= failure('NATIVE_CHANNEL_REPAIR_REQUIRED', row); continue; }
            matches.push(row); continue;
        }
        if (!row.webhook_url) { uncertain ||= failure('NATIVE_CHANNEL_REPAIR_REQUIRED', row); continue; }
        if (Date.now() >= deadline) { uncertain ||= failure('NATIVE_CHANNEL_VERIFICATION_UNAVAILABLE', row); break; }
        try {
            const old = await verify(row.webhook_url, { timeoutMs: Math.max(1000, Math.min(15000, deadline - Date.now())) });
            if (old.guildId !== guildId || old.channelId !== channelId) continue;
            if (row.managed_id) { uncertain ||= failure('NATIVE_CHANNEL_REPAIR_REQUIRED', row); continue; }
            matches.push(row);
        } catch (error) {
            // A missing endpoint cannot reveal its former channel. A transport
            // or permission failure is not evidence that the endpoint is gone.
            uncertain ||= failure([404, 410].includes(Number(error.status)) ? 'NATIVE_CHANNEL_REPAIR_REQUIRED' : 'NATIVE_CHANNEL_VERIFICATION_UNAVAILABLE', row);
        }
    }
    if (matches.length > 1) throw failure('NATIVE_CHANNEL_REPAIR_REQUIRED', matches[0]);
    if (!matches.length) { if (uncertain) throw uncertain; return null; }
    const row = matches[0];
    if (row.managed_id && String(row.managed_endpoint) !== String(endpointId)) {
        // This dedicated repair preserves the immutable physical recipient:
        // the owner explicitly selected this same verified guild/channel. Never
        // repoint a shared/foreign alias or infer a channel from the origin.
        const updated = await query('UPDATE automation_destinations SET webhook_endpoint_id=?,created_by_bot=1,revision=revision+1,updated_at_ms=? WHERE id=? AND owner_user_id=? AND scope=\'private\' AND guild_id=? AND channel_id=? AND deleted_at_ms IS NULL AND webhook_endpoint_id=? AND revision=?',
            [endpointId, Date.now(), row.managed_id, userId, guildId, channelId, row.managed_endpoint, row.managed_revision]);
        if (Number(updated.affectedRows) !== 1) throw failure('NATIVE_CHANNEL_VERIFICATION_UNAVAILABLE', row);
        await query('INSERT INTO automation_audit (actor_user_id,entity_id,guild_id,action,detail_json,created_at_ms) VALUES (?,?,?,?,?,?)',
            [userId, row.managed_id, guildId, 'destination.channel-repair', JSON.stringify({ targetKind: kind, targetId: String(row.id), previousEndpointId: String(row.managed_endpoint), endpointId: String(endpointId) }), Date.now()]);
    }
    return row;
}

module.exports = { legacyChannelRegistration };
