'use strict';

// Posts an hourly stats embed to a dedicated stats channel and rotates the
// per-minute / per-hour / per-day counters. The DB INSERT is currently disabled.

const { counters, resetCountersAfterStatsPost } = require('../state');

const STATS_GUILD_ID = '1175729394782851123';
const STATS_CHANNEL_ID = '1189083636574724167';

function start(client) {
    setInterval(async () => {
        const guild = await client.guilds.cache.get(STATS_GUILD_ID);
        const channel = guild && (await guild.channels.cache.get(STATS_CHANNEL_ID));
        if (channel) {
            channel.send({
                embeds: [{
                    title: '🌐サーバー数',
                    description: client.guilds.cache.size + 'servers',
                    color: 0x1DA1F2,
                    fields: [
                        { name: 'ユーザー数', value: client.users.cache.size + 'users' },
                        { name: 'チャンネル数', value: client.channels.cache.size + 'channels' },
                        { name: '一分間に処理したメッセージ数', value: counters.processed + 'messages' },
                        { name: '一時間に処理したメッセージ数', value: counters.processed_hour + 'messages' },
                        { name: '一日に処理したメッセージ数', value: counters.processed_day + 'messages' },
                    ],
                }],
            });
        }

        resetCountersAfterStatsPost();

        // DB persistence is currently disabled; see git history for the original INSERT.
    }, 60000);
}

module.exports = { start };
