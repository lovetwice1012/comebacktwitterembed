'use strict';

const { ActivityType } = require('discord.js');

let presenceTimer = null;

function updatePresence(client) {
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: client.guilds.cache.size + 'servers | No special setup is required, just post the tweet link.',
            type: ActivityType.Watching,
        }],
    });
}

function start(client) {
    updatePresence(client);

    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(() => updatePresence(client), 60000);
}

module.exports = { start, updatePresence };
