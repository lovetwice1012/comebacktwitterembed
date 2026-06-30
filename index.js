//discord.js v14
const { Client, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');
// 動的 require で TypeScript の静的解決を回避 (config.json は実行時に必須だが、型チェック時には存在を保証しない)
const config = require(/** @type {string} */ ('./config.json'));
const { consoleBuffer } = require('./src/state');
const { initializeSettings } = require('./src/settings');
const { ensureDatabaseSchema } = require('./src/db_schema');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    shards: 'auto',
});
const webhookURL = typeof config.URL === 'string' ? config.URL.trim() : '';
const webhookClient = webhookURL ? new WebhookClient({ url: webhookURL }) : null;

if (!webhookClient) {
    console.warn('config.URL is not set. Console webhook forwarding is disabled.');
}

if (webhookClient) {
    // Buffer stdout/stderr for the periodic webhook flush in the ready handler.
    // JSDoc cast: write の戻り値を boolean に矯正して TypeScript の型互換を満たす。
    process.stdout.write = /** @type {any} */ ((write => function (string) {
        consoleBuffer.text += string;
        return write.apply(process.stdout, arguments);
    })(process.stdout.write));
    process.stderr.write = /** @type {any} */ ((write => function (string) {
        consoleBuffer.text += string;
        return write.apply(process.stderr, arguments);
    })(process.stderr.write));
}

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

(async () => {
    await ensureDatabaseSchema();
    await initializeSettings();

    require('./src/handlers/ready').register(client, webhookClient);
    require('./src/handlers/messageCreate').register(client);
    require('./src/handlers/applicationCommands').register(client);
    require('./src/handlers/messageComponents').register(client);

    client.rest.on('rateLimited', (data) => {
        console.log('Rate limited: ' + data.timeToReset + 'ms');
        console.log(data);
    });

    await client.login(config.token);
})().catch(error => {
    console.error('Failed to start application:', error);
    process.exitCode = 1;
});
