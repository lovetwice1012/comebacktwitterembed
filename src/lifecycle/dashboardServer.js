'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 30987;

let child = null;

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'config.json'), 'utf8'));
    } catch {
        return {};
    }
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..');
}

function dashboardDir() {
    return path.join(repoRoot(), 'dashboard');
}

function truthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function isDisabled() {
    const config = readConfig();
    return config.dashboard?.enabled === false
        || truthy(process.env.DASHBOARD_DISABLED)
        || truthy(process.env.DISABLE_DASHBOARD);
}

function npmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmCliPath() {
    const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return fs.existsSync(candidate) ? candidate : null;
}

function launchCommand(script) {
    if (script === 'start' || script === 'dev' || script === 'build') {
        return {
            command: process.execPath,
            args: [path.join(dashboardDir(), 'scripts', 'start-dashboard.js'), script],
            label: `node scripts/start-dashboard.js ${script}`,
        };
    }

    const npmCli = npmCliPath();
    if (npmCli) {
        return {
            command: process.execPath,
            args: [npmCli, 'run', script],
            label: `npm run ${script}`,
        };
    }

    return {
        command: npmCommand(),
        args: ['run', script],
        label: `npm run ${script}`,
    };
}

function dashboardConfig() {
    return readConfig().dashboard || {};
}

function dashboardPort() {
    const configured = Number(process.env.DASHBOARD_PORT || process.env.PORT || dashboardConfig().port);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PORT;
}

function dashboardBaseUrl(port = dashboardPort()) {
    const config = readConfig();
    const dashboard = config.dashboard || {};
    const mediaDelivery = config.mediaDelivery || {};
    return (
        process.env.NEXTAUTH_URL
        || process.env.DASHBOARD_BASE_URL
        || dashboard.publicBaseUrl
        || dashboard.baseUrl
        || mediaDelivery.publicBaseUrl
        || config.publicBaseUrl
        || `http://localhost:${port}`
    ).replace(/\/+$/, '');
}

function hasProductionBuild() {
    const dir = dashboardDir();
    try {
        const current = JSON.parse(fs.readFileSync(path.join(dir, '.next-builds', 'current.json'), 'utf8'));
        if (typeof current.distDir === 'string' && fs.existsSync(path.join(dir, current.distDir, 'BUILD_ID'))) return true;
    } catch {
        // Fall back to the legacy in-place Next.js build below.
    }
    return fs.existsSync(path.join(dir, '.next', 'BUILD_ID'));
}

function scriptName() {
    if (process.env.DASHBOARD_NPM_SCRIPT) return process.env.DASHBOARD_NPM_SCRIPT;
    if (dashboardConfig().npmScript) return dashboardConfig().npmScript;
    if (!hasProductionBuild()) {
        console.warn('[dashboardServer] production build was not found. Dashboard will create one before `next start`.');
    }
    return 'start';
}

function start() {
    if (child) return child;
    if (isDisabled()) {
        console.log('[dashboardServer] disabled by environment.');
        return null;
    }
    if (!fs.existsSync(path.join(dashboardDir(), 'package.json'))) {
        console.warn('[dashboardServer] dashboard/package.json was not found. Dashboard startup skipped.');
        return null;
    }

    const config = readConfig();
    const dashboard = config.dashboard || {};
    const mediaDelivery = config.mediaDelivery || {};
    const port = dashboardPort();
    const baseUrl = dashboardBaseUrl(port);
    /** @type {NodeJS.ProcessEnv} */
    const env = {
        ...process.env,
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: '1',
        NEXTAUTH_URL: baseUrl,
        DASHBOARD_BASE_URL: baseUrl,
        DASHBOARD_INTEGRATED_MEDIA_SERVER: 'true',
        MEDIA_DELIVERY_PUBLIC_BASE_URL: mediaDelivery.publicBaseUrl || dashboard.publicBaseUrl || dashboard.baseUrl || config.publicBaseUrl || baseUrl,
    };
    if (dashboard.clientId || config.clientId) env.DISCORD_CLIENT_ID = dashboard.clientId || config.clientId;
    if (dashboard.clientSecret || config.clientSecret) env.DISCORD_CLIENT_SECRET = dashboard.clientSecret || config.clientSecret;
    if (dashboard.nextAuthSecret || config.nextAuthSecret) env.NEXTAUTH_SECRET = dashboard.nextAuthSecret || config.nextAuthSecret;
    if (dashboard.auditHashSecret) env.DASHBOARD_AUDIT_HASH_SECRET = dashboard.auditHashSecret;
    if (dashboard.discordApiTimeoutMs) env.DISCORD_API_TIMEOUT_MS = String(dashboard.discordApiTimeoutMs);
    if (dashboard.useBotGuildApi !== undefined) env.DASHBOARD_USE_BOT_GUILD_API = dashboard.useBotGuildApi ? 'true' : 'false';
    if (dashboard.loadGuildProviderSummary !== undefined) {
        env.DASHBOARD_LOAD_GUILD_PROVIDER_SUMMARY = dashboard.loadGuildProviderSummary ? 'true' : 'false';
    }
    if (mediaDelivery.useLegacyRoutes !== undefined) {
        env.MEDIA_DELIVERY_USE_LEGACY_ROUTES = mediaDelivery.useLegacyRoutes ? 'true' : 'false';
    }
    if (mediaDelivery.serverMode) env.MEDIA_DELIVERY_SERVER_MODE = mediaDelivery.serverMode;

    // Keep the parent in dashboard-integrated mode too, so ready-time media lifecycle
    // only starts cache cleanup timers and never opens a second listener on 30987.
    process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || baseUrl;
    process.env.DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || baseUrl;
    process.env.DASHBOARD_INTEGRATED_MEDIA_SERVER = 'true';
    process.env.MEDIA_DELIVERY_PUBLIC_BASE_URL = process.env.MEDIA_DELIVERY_PUBLIC_BASE_URL || env.MEDIA_DELIVERY_PUBLIC_BASE_URL;
    if (env.MEDIA_DELIVERY_USE_LEGACY_ROUTES) process.env.MEDIA_DELIVERY_USE_LEGACY_ROUTES = env.MEDIA_DELIVERY_USE_LEGACY_ROUTES;
    if (env.MEDIA_DELIVERY_SERVER_MODE) process.env.MEDIA_DELIVERY_SERVER_MODE = env.MEDIA_DELIVERY_SERVER_MODE;

    const script = scriptName();
    const launch = launchCommand(script);
    child = spawn(launch.command, launch.args, {
        cwd: dashboardDir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    child.stdout.on('data', chunk => {
        String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => console.log(`[dashboard] ${line}`));
    });
    child.stderr.on('data', chunk => {
        String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => console.warn(`[dashboard] ${line}`));
    });
    child.on('error', err => {
        console.warn('[dashboardServer] failed to start:', err?.message || err);
    });
    child.on('exit', (code, signal) => {
        console.warn(`[dashboardServer] exited${signal ? ` by ${signal}` : ''}${code === null ? '' : ` with code ${code}`}.`);
        child = null;
    });

    console.log(`[dashboardServer] starting dashboard on ${baseUrl} with ${launch.label}`);
    return child;
}

function stop(signal = 'SIGTERM') {
    if (!child) return;
    const current = child;
    child = null;
    current.kill(signal);
}

module.exports = {
    DEFAULT_PORT,
    start,
    stop,
    _internal: {
        dashboardBaseUrl,
        dashboardPort,
        hasProductionBuild,
        readConfig,
        scriptName,
    },
};
