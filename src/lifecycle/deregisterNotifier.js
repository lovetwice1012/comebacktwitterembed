'use strict';

// Polls the deregister_notification table and DMs the affected users.
// Currently disabled (early `return`) — kept for future re-enablement.

const { connection } = require('../db');

function start(client) {
    setInterval(() => {
        return;
        /* eslint-disable no-unreachable */
        connection.query(
            'SELECT * FROM deregister_notification NATURAL LEFT OUTER JOIN deregister_reason WHERE timestamp > ? AND sendedDirectMessage = 0',
            [new Date().getTime() - 86400000],
            (err, results) => {
                if (err) {
                    console.error('Error connecting to database:', err);
                    return;
                }
                results.forEach(result => {
                    client.users.fetch(result.userid).then(async user => {
                        user.send({
                            embeds: [{
                                title: '新着自動展開機能の登録が自動解除されました',
                                description: `あなたが登録した新着自動展開機能の登録(ID:${result.rssId})は、以下の理由により自動解除されました。\n\n理由: ${result.reason}\n\n詳細: \n${result.hint}`,
                                color: 0x1DA1F2,
                            }],
                        }).then(() => {
                            connection.query(
                                'UPDATE deregister_notification as T1 SET sendedDirectMessage = 1 WHERE T1.index = ?',
                                [result.index],
                                (err2) => {
                                    if (err2) console.error('Error connecting to database:', err2);
                                }
                            );
                        }).catch(e => console.error(e));
                    }).catch(e => console.error(e));
                });
            }
        );
    }, 10000);
}

module.exports = { start };
