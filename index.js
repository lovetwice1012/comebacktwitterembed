//discord.js v14
const { Client, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');
const config = require('./config.json');
const { consoleBuffer } = require('./src/state');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    shards: 'auto',
});
const webhookClient = new WebhookClient({ url: config.URL });

// Buffer stdout/stderr for the periodic webhook flush in the ready handler.
process.stdout.write = (write => function (string) {
    consoleBuffer.text += string;
    write.apply(process.stdout, arguments);
})(process.stdout.write);
process.stderr.write = (write => function (string) {
    consoleBuffer.text += string;
    write.apply(process.stderr, arguments);
})(process.stderr.write);

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

require('./src/handlers/ready').register(client, webhookClient);
require('./src/handlers/messageCreate').register(client);
require('./src/handlers/applicationCommands').register(client);
require('./src/handlers/messageComponents').register(client);

client.login(config.token);
