'use strict';

// Polls deregistration notifications and DMs affected users.
// Currently disabled (early `return`) and kept for future re-enablement.

const { queryDatabase } = require('../db');
const { TABLES } = require('../db_schema');

function start(client) {
    setInterval(() => {
        return;
        /* eslint-disable no-unreachable */
        queryDatabase(
            `SELECT
                n.notification_id,
                n.auto_extract_target_id,
                n.user_id,
                r.reason,
                r.hint
             FROM ${TABLES.deregisterNotifications} n
             INNER JOIN ${TABLES.deregisterReasons} r ON r.reason_id = n.reason_id
             WHERE n.created_at_ms > ? AND n.dm_sent = 0`,
            [new Date().getTime() - 86400000]
        ).then(results => {
            results.forEach(result => {
                client.users.fetch(result.user_id).then(async user => {
                    user.send({
                        embeds: [{
                            title: '自動展開登録が解除されました',
                            description: `あなたが登録した自動展開(ID:${result.auto_extract_target_id})は、以下の理由により解除されました。\n\n理由: ${result.reason}\n\n詳細:\n${result.hint}`,
                            color: 0x1DA1F2,
                        }],
                    }).then(() => {
                        queryDatabase(
                            `UPDATE ${TABLES.deregisterNotifications}
                             SET dm_sent = 1, dm_sent_at_ms = ?
                             WHERE notification_id = ?`,
                            [new Date().getTime(), result.notification_id]
                        ).catch(err => console.error('Error updating deregister notification:', err));
                    }).catch(e => console.error(e));
                }).catch(e => console.error(e));
            });
        }).catch(err => {
            console.error('Error querying deregister notifications:', err);
        });
    }, 10000);
}

module.exports = { start };
