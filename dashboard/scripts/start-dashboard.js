#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 30987;

function repoRoot() {
    return path.resolve(__dirname, '..', '..');
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'config.json'), 'utf8'));
    } catch {
        return {};
    }
}

function dashboardBaseUrl(config, port) {
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

function npmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function hasProductionBuild(dashboardDir) {
    return fs.existsSync(path.join(dashboardDir, '.next', 'BUILD_ID'));
}

function latestMtimeMs(targetPath) {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let latest = stat.mtimeMs;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
        if (entry.name === '.next' || entry.name === 'node_modules') continue;
        latest = Math.max(latest, latestMtimeMs(path.join(targetPath, entry.name)));
    }
    return latest;
}

function productionBuildIsStale(dashboardDir) {
    const buildIdPath = path.join(dashboardDir, '.next', 'BUILD_ID');
    if (!fs.existsSync(buildIdPath)) return true;
    const buildTime = fs.statSync(buildIdPath).mtimeMs;
    const sourcePaths = [
        'app',
        'components',
        'features',
        'lib',
        'prisma',
        'public',
        'scripts',
        'package.json',
        'next.config.js',
        'next.config.mjs',
        'tailwind.config.ts',
        'tailwind.config.js',
        'tsconfig.json',
    ];
    return sourcePaths.some(sourcePath => latestMtimeMs(path.join(dashboardDir, sourcePath)) > buildTime);
}

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const config = readConfig();
const dashboard = config.dashboard || {};
const mediaDelivery = config.mediaDelivery || {};
const port = Number(process.env.DASHBOARD_PORT || process.env.PORT || dashboard.port || DEFAULT_PORT);
const baseUrl = dashboardBaseUrl(config, port);

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

const dashboardDir = path.resolve(__dirname, '..');
const nextCli = path.join(dashboardDir, 'node_modules', 'next', 'dist', 'bin', 'next');

if (mode === 'start' && (!hasProductionBuild(dashboardDir) || productionBuildIsStale(dashboardDir))) {
    console.warn('[dashboard] production build is missing or stale. Running `npm run build` before start.');
    const build = spawnSync(npmCommand(), ['run', 'build'], {
        cwd: dashboardDir,
        env,
        stdio: 'inherit',
        windowsHide: true,
    });
    if (build.error) {
        console.error(build.error);
        process.exit(1);
    }
    if (build.status !== 0) {
        process.exit(build.status ?? 1);
    }
}

const result = spawnSync(process.execPath, [nextCli, mode, '--port', String(port)], {
    cwd: dashboardDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
});

if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
} else {
    process.exitCode = result.status ?? 1;
}
