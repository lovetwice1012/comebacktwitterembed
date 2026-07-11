'use strict';

// Posts an hourly stats embed to a dedicated stats channel and rotates the
// per-minute / per-hour / per-day counters. The DB INSERT is currently disabled.

const { counters, resetCountersAfterStatsPost } = require('../state');
const discordEventMetrics = require('../discordEventMetrics');

const STATS_GUILD_ID = '1175729394782851123';
const STATS_CHANNEL_ID = '1189083636574724167';
const POST_INTERVAL_MS = 60000;

let statsTimer = null;

async function tick(client, eventMetrics = discordEventMetrics) {
    try {
        const eventCounts = eventMetrics.snapshot();
        const guild = client.guilds.cache.get(STATS_GUILD_ID);
        const channel = guild && guild.channels.cache.get(STATS_CHANNEL_ID);
        if (channel) {
            await channel.send({
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
                        { name: '起動中の直近1分に受信したDiscord Gatewayイベント数', value: eventCounts.lastMinute + 'events' },
                        { name: '起動中の直近1時間に受信したDiscord Gatewayイベント数', value: eventCounts.lastHour + 'events' },
                        { name: '起動中の直近24時間に受信したDiscord Gatewayイベント数', value: eventCounts.lastDay + 'events' },
                        { name: '起動後に受信したDiscord Gatewayイベント数', value: eventCounts.total + 'events' },
                    ],
                }],
            });
        }
    } catch (err) {
        console.warn('[statsPoster] Failed to post stats:', err?.message || err);
    } finally {
        resetCountersAfterStatsPost();
    }

    // DB persistence is currently disabled; see git history for the original INSERT.
}

function start(client) {
    if (statsTimer !== null) return statsTimer;

    statsTimer = setInterval(() => {
        tick(client).catch(err => console.warn('[statsPoster] Tick failed:', err?.message || err));
    }, POST_INTERVAL_MS);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
    return statsTimer;
}

function stop() {
    if (statsTimer === null) return;
    clearInterval(statsTimer);
    statsTimer = null;
}

module.exports = { start, stop, tick };
