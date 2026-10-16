'use strict';

const { createHash } = require('node:crypto');

function withChannelWebhookOperation(db, guildId, channelId, work) {
    // All registration routes use the same channel lock, including an existing
    // URL adopting another request's newly created purpose webhook. Its remote
    // metadata must be revalidated after this lock, before SQL admission.
    const key = createHash('sha256').update(`native-channel-webhook:${guildId}:${channelId}`).digest('hex');
    return db.withDatabaseTransaction(async query => {
        await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,9007199254740991)', [key]);
        if (!(await query('SELECT counter_key FROM automation_counters WHERE counter_key=? FOR UPDATE', [key])).length) {
            throw Object.assign(new Error('Webhook registration lock is unavailable.'), { code: 'WEBHOOK_DESTINATION_UNAVAILABLE' });
        }
        return work(query);
    });
}

module.exports = { withChannelWebhookOperation };
