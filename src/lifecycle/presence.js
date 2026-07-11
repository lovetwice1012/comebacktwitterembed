'use strict';

const { ActivityType } = require('discord.js');

const lastPresenceByClient = new WeakMap();

function updatePresence(client) {
    if (!client || typeof client.isReady !== 'function' || !client.isReady() || !client.user) {
        return false;
    }

    const name = client.guilds.cache.size + 'servers | No special setup is required, just post the tweet link.';
    const previous = lastPresenceByClient.get(client);
    if (previous?.name === name && previous?.readyTimestamp === client.readyTimestamp) return false;

    client.user.setPresence({
        status: 'online',
        activities: [{
            name,
            type: ActivityType.Watching,
        }],
    });
    lastPresenceByClient.set(client, { name, readyTimestamp: client.readyTimestamp });
    return true;
}

function start(client) {
    // Presence is normally supplied in the Client identify options. Keep this
    // helper one-shot so future callers cannot enqueue Gateway sends every
    // minute while a shard is reconnecting.
    return updatePresence(client);
}

module.exports = { start, updatePresence };
