//discord.js v14
const { assertSupportedRuntime } = require('./src/runtime');
const { loadDiscordRuntime } = require('./src/discordTransport');

const runtimeName = assertSupportedRuntime();
const discordRuntime = loadDiscordRuntime({ isBun: runtimeName === 'bun' });

const { ActivityType, Client, Events, GatewayIntentBits, Partials, WebhookClient } = discordRuntime.discord;
// 動的 require で TypeScript の静的解決を回避 (config.json は実行時に必須だが、型チェック時には存在を保証しない)
const config = require(/** @type {string} */ ('./config.json'));
const { consoleBuffer } = require('./src/state');
const consoleCapture = require('./src/consoleCapture');
const { initializeSettings } = require('./src/settings');
const { ensureDatabaseSchema } = require('./src/db_schema');
const { currentErrorContext, recordError } = require('./src/errorTracking');
const discordEventMetrics = require('./src/discordEventMetrics');
const dashboardServer = require('./src/lifecycle/dashboardServer');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    shards: 'auto',
    presence: {
        status: 'online',
        activities: [{
            name: 'No special setup is required; just post a supported link.',
            type: ActivityType.Watching,
        }],
    },
    ...(discordRuntime.restOptions ? { rest: discordRuntime.restOptions } : {}),
});
const webhookURL = typeof config.URL === 'string' ? config.URL.trim() : '';
const errorNotificationURL = typeof config.errorNotificationURL === 'string' && config.errorNotificationURL.trim()
    ? config.errorNotificationURL.trim()
    : webhookURL;
const webhookOptions = discordRuntime.restOptions ? { rest: discordRuntime.restOptions } : undefined;
const webhookClient = webhookURL ? new WebhookClient({ url: webhookURL }, webhookOptions) : null;
const errorNotificationWebhookClient = errorNotificationURL
    ? (errorNotificationURL === webhookURL ? webhookClient : new WebhookClient({ url: errorNotificationURL }, webhookOptions))
    : null;

if (!webhookClient) {
    console.warn('config.URL is not set. Console webhook forwarding is disabled.');
}

let consoleCaptureInstalled = false;
function installConsoleCapture() {
    if (!webhookClient || consoleCaptureInstalled) return;
    consoleCaptureInstalled = true;
    // Buffer stdout/stderr for the periodic webhook flush in the ready handler.
    // JSDoc cast: write の戻り値を boolean に矯正して TypeScript の型互換を満たす。
    process.stdout.write = /** @type {any} */ ((write => function (string) {
        consoleCapture.append(consoleBuffer, string);
        return write.apply(process.stdout, arguments);
    })(process.stdout.write));
    process.stderr.write = /** @type {any} */ ((write => function (string) {
        consoleCapture.append(consoleBuffer, string);
        return write.apply(process.stderr, arguments);
    })(process.stderr.write));
}

console.log(
    `[runtime] pid=${process.pid}; ${runtimeName} ${process.versions?.bun || process.versions.node}; `
    + `discord.js=${discordRuntime.discord.version}; `
    + `Gateway=${discordRuntime.gatewayTransport}, REST=${discordRuntime.restTransport}; `
    + `revision=${process.env.APP_REVISION || process.env.GIT_COMMIT || process.env.SOURCE_VERSION || 'unknown'}`
);

process.on('unhandledRejection', error => {
    recordError(error, {
        ...currentErrorContext(),
        errorType: 'unhandled_rejection',
        severity: 'fatal',
        source: 'process.unhandledRejection',
    });
    console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
    recordError(error, {
        ...currentErrorContext(),
        errorType: 'uncaught_exception',
        severity: 'fatal',
        source: 'process.uncaughtException',
    });
    console.error('Uncaught exception:', error);
});

client.on(Events.Error, error => {
    recordError(error, { errorType: 'discord_client_error', severity: 'error', source: 'discord.client' });
    console.error('[discord] Client error:', error);
});
client.on(Events.ShardError, (error, shardId) => {
    recordError(error, {
        errorType: 'discord_shard_error',
        severity: 'error',
        source: 'discord.shardError',
        shardId,
    });
    console.error(`[discord] Shard ${shardId} error:`, error);
});
client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`[discord] Shard ${shardId} disconnected (code ${event?.code ?? 'unknown'}).`);
});
client.on(Events.ShardReconnecting, shardId => {
    console.warn(`[discord] Shard ${shardId} reconnecting.`);
});
client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.log(`[discord] Shard ${shardId} resumed (${replayedEvents} replayed events).`);
});

(async () => {
    await ensureDatabaseSchema();
    await initializeSettings();
    const dashboardPrepared = await dashboardServer.prepare();
    installConsoleCapture();
    if (dashboardPrepared) {
        dashboardServer.start();
    } else {
        console.warn('[dashboardServer] preparation failed; dashboard startup skipped to protect the Bot gateway.');
    }

    discordEventMetrics.register(client);

    require('./src/handlers/ready').register(client, webhookClient, errorNotificationWebhookClient);
    require('./src/handlers/messageCreate').register(client);
    require('./src/handlers/applicationCommands').register(client);
    require('./src/handlers/messageComponents').register(client);
    require('./src/lifecycle/dbBackup').startDailyDbDumps();

    client.rest.on('rateLimited', (data) => {
        console.log('Rate limited: ' + data.timeToReset + 'ms');
        console.log(data);
    });

    await client.login(config.token);
})().catch(error => {
    recordError(error, { errorType: 'startup_failed', severity: 'fatal', source: 'index.startup' });
    console.error('Failed to start application:', error);
    process.exitCode = 1;
});

process.once('SIGINT', () => {
    dashboardServer.stop();
    process.exit(130);
});

process.once('SIGTERM', () => {
    dashboardServer.stop();
    process.exit(143);
});
