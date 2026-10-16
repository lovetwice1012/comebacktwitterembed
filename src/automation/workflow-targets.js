'use strict';

const { createHash } = require('node:crypto');

// Callers hold the workflow row lock. Attaching a target takes the same lock,
// making the reviewed consumer list and activation one serializable operation.
async function workflowTargets(query, workflow) {
    const targets = [];
    for (const kind of ['auto', 'price']) {
        const table = kind === 'auto' ? 'auto_watch' : 'price_watch';
        const rows = await query(`SELECT t.id,t.user_id,t.guild_id,t.enabled,t.destination_type,
            m.name,m.scope,m.revision,m.destination_id,${kind === 'auto' ? 's.source_url' : 's.product_url'} AS source
            FROM automation_assignments a JOIN ${table}_targets t ON t.id=a.target_id
            JOIN ${table}_sources s ON s.id=t.source_id
            LEFT JOIN automation_monitors m ON m.target_kind=a.target_kind AND m.target_id=a.target_id
            WHERE a.workflow_id=? AND a.target_kind=? ORDER BY t.id`, [workflow.id, kind]);
        for (const row of rows) {
            const scope = row.scope || (row.destination_type === 'dm' || !row.guild_id ? 'private' : 'guild');
            if (scope !== workflow.scope || scope === 'private' && row.user_id !== workflow.owner_user_id
                || scope === 'guild' && row.guild_id !== workflow.guild_id) continue;
            targets.push({ kind, id: String(row.id), name: row.name || row.source, revision: Number(row.revision || 1),
                enabled: !!row.enabled, scope, ownerId: row.user_id, guildId: row.guild_id || null,
                workflowId: workflow.id, destinationId: row.destination_id || null });
        }
    }
    if (workflow.scope === 'private') {
        const rows = await query(`SELECT id,owner_user_id,name,revision,enabled,notification_settings_json
            FROM automation_x_monitors WHERE owner_user_id=? AND state<>'deleted'
            AND CASE WHEN JSON_VALID(notification_settings_json) THEN JSON_UNQUOTE(JSON_EXTRACT(notification_settings_json,'$.workflowId')) ELSE NULL END=? ORDER BY id`, [workflow.owner_user_id, workflow.id]);
        for (const row of rows) {
            const settings = typeof row.notification_settings_json === 'string' ? JSON.parse(row.notification_settings_json) : row.notification_settings_json;
            targets.push({ kind: 'x', id: String(row.id), name: row.name, revision: Number(row.revision),
                enabled: !!row.enabled, scope: 'private', ownerId: row.owner_user_id, guildId: null,
                workflowId: workflow.id, destinationId: settings.destinationId || null });
        }
    }
    return targets.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

function targetsToken(workflow, targets) {
    return createHash('sha256').update(JSON.stringify([workflow.id, Number(workflow.revision), targets])).digest('hex');
}

module.exports = { workflowTargets, targetsToken };
