const { WebhookClient } = require('discord.js');
const { URL, CONSOLE_LOG_INTERVAL } = require('../config/constants');

let text = '';
let webhookClient = null;

/**
 * Initialize console logger to send logs to Discord webhook
 * @param {Client} client - Discord client
 */
function initializeConsoleLogger(client) {
    webhookClient = new WebhookClient({ url: URL });

    // Intercept stdout
    process.stdout.write = (write => function (string, encoding, fd) {
        text += string;
        write.apply(process.stdout, arguments);
    })(process.stdout.write);

    // Intercept stderr
    process.stderr.write = (write => function (string, encoding, fd) {
        text += string;
        write.apply(process.stderr, arguments);
    })(process.stderr.write);

    // Send logs periodically
    setInterval(() => {
        if (text !== '' && webhookClient && client.user) {
            const chunks = text.match(/[\s\S]{1,1900}/g);
            let i = 0;
            for (const chunk of chunks) {
                i++;
                webhookClient.sendSlackMessage({
                    text: `\`\`\`${chunk}\`\`\``,
                    username: `[console]${client.user.tag}(${i}/${chunks.length})`,
                    icon_url: client.user.displayAvatarURL()
                });
            }
            text = '';
        }
    }, CONSOLE_LOG_INTERVAL);
}

module.exports = {
    initializeConsoleLogger
};
