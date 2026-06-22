'use strict';

// Periodically flushes the captured stdout/stderr buffer to the configured
// webhook in 1900-char chunks (Discord message size limit safety).

const { consoleBuffer } = require('../state');

function start(client, webhookClient) {
    if (!webhookClient) return;

    setInterval(() => {
        if (consoleBuffer.text === '') return;
        const chunks = consoleBuffer.text.match(/[\s\S]{1,1900}/g) || [];
        chunks.forEach((chunk, idx) => {
            webhookClient.sendSlackMessage({
                text: '```' + chunk + '```',
                username: `[console]${client.user.tag}(${idx + 1}/${chunks.length})`,
                icon_url: client.user.displayAvatarURL(),
            });
        });
        consoleBuffer.text = '';
    }, 10000);
}

module.exports = { start };
