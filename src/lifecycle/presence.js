'use strict';

const { ActivityType } = require('discord.js');

function start(client) {
    setInterval(() => {
        client.user.setPresence({
            status: 'online',
            activities: [{
                name: client.guilds.cache.size + 'servers | No special setup is required, just post the tweet link.',
                type: ActivityType.Watching,
            }],
        });
    }, 60000);
}

module.exports = { start };
