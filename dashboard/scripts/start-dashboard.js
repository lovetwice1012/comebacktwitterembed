#!/usr/bin/env node
'use strict';
/* global module */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 30987;
const LEGACY_DIST_DIR = '.next';
const DEV_DIST_DIR = '.next-dev';
const BUILD_WORK_DIR = '.next-build';
const BUILD_ROOT_DIR = '.next-builds';
const CURRENT_BUILD_FILE = 'current.json';
const RESTART_DEBOUNCE_MS = 750;
const RESTART_GRACE_MS = 10000;

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

function loadRuntimeEnvironment() {
    const filename = process.env.DASHBOARD_RUNTIME_ENV_FILE;
    if (!filename) return;
    const descriptor = fs.openSync(filename, 'r');
    let environment;
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > 262144
            || (process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o077) !== 0))) {
            throw new Error('Dashboard runtime environment must be a bounded, root-owned private file.');
        }
        try {
            environment = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
        } catch {
            throw new Error('Dashboard runtime environment is not valid JSON.');
        }
    } finally {
        fs.closeSync(descriptor);
    }
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)
        || Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) {
        throw new Error('Dashboard runtime environment has an invalid shape.');
    }
    // The private snapshot carries credentials without exposing them in argv or
    // systemd show. Explicit service settings can override its operational flags.
    for (const [key, value] of Object.entries(environment)) {
        if (process.env[key] === undefined) process.env[key] = value;
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

function applyConfigurationDefaults(env, config) {
    const dashboard = config.dashboard || {};
    const mediaDelivery = config.mediaDelivery || {};
    const booleanValue = value => value === undefined ? undefined : value ? 'true' : 'false';
    const defaults = {
        DISCORD_BOT_TOKEN: typeof config.token === 'string' && config.token.trim() ? config.token.trim() : undefined,
        DISCORD_CLIENT_ID: dashboard.clientId || config.clientId,
        DISCORD_CLIENT_SECRET: dashboard.clientSecret || config.clientSecret,
        NEXTAUTH_SECRET: dashboard.nextAuthSecret || config.nextAuthSecret,
        DASHBOARD_AUDIT_HASH_SECRET: dashboard.auditHashSecret,
        DISCORD_API_TIMEOUT_MS: dashboard.discordApiTimeoutMs ? String(dashboard.discordApiTimeoutMs) : undefined,
        DASHBOARD_USE_BOT_GUILD_API: booleanValue(dashboard.useBotGuildApi),
        DASHBOARD_LOAD_GUILD_PROVIDER_SUMMARY: booleanValue(dashboard.loadGuildProviderSummary),
        DASHBOARD_DELEGATED_ACCESS_ENABLED: booleanValue(dashboard.delegatedAccessEnabled),
        DASHBOARD_ADMIN_ANALYTICS_PREWARM: booleanValue(dashboard.adminAnalyticsPrewarm),
        MEDIA_DELIVERY_USE_LEGACY_ROUTES: booleanValue(mediaDelivery.useLegacyRoutes),
        MEDIA_DELIVERY_SERVER_MODE: mediaDelivery.serverMode,
    };
    for (const [name, value] of Object.entries(defaults)) {
        if (env[name] === undefined && value !== undefined) env[name] = value;
    }
}

function truthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function currentBuildFile(dashboardDir) {
    return path.join(dashboardDir, BUILD_ROOT_DIR, CURRENT_BUILD_FILE);
}

function buildRoot(dashboardDir) {
    return path.join(dashboardDir, BUILD_ROOT_DIR);
}

function nextCli(dashboardDir) {
    return path.join(dashboardDir, 'node_modules', 'next', 'dist', 'bin', 'next');
}

function prismaCli(dashboardDir) {
    return path.join(dashboardDir, 'node_modules', 'prisma', 'build', 'index.js');
}

function prismaSchemaPath(dashboardDir) {
    return path.join(dashboardDir, 'prisma', 'schema.prisma');
}

function generatedPrismaClientPath(dashboardDir) {
    return path.join(dashboardDir, 'node_modules', '.prisma', 'client', 'index.js');
}

function generatedPrismaSchemaPath(dashboardDir) {
    return path.join(dashboardDir, 'node_modules', '.prisma', 'client', 'schema.prisma');
}

function snapshotFiles(dashboardDir, relativePaths) {
    return relativePaths.map(relativePath => {
        const filePath = path.join(dashboardDir, relativePath);
        return {
            filePath,
            exists: fs.existsSync(filePath),
            content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null,
        };
    });
}

function restoreFiles(snapshots) {
    for (const snapshot of snapshots) {
        if (!snapshot.exists) {
            try {
                fs.rmSync(snapshot.filePath, { force: true });
            } catch {
                // Best-effort cleanup only.
            }
            continue;
        }
        if (!fs.existsSync(snapshot.filePath) || fs.readFileSync(snapshot.filePath, 'utf8') !== snapshot.content) {
            fs.writeFileSync(snapshot.filePath, snapshot.content);
        }
    }
}

function shouldGeneratePrismaClient(dashboardDir) {
    if (truthy(process.env.DASHBOARD_FORCE_PRISMA_GENERATE)) return true;
    return !fs.existsSync(generatedPrismaClientPath(dashboardDir));
}

function warnIfPrismaClientMayBeStale(dashboardDir) {
    if (truthy(process.env.DASHBOARD_FORCE_PRISMA_GENERATE)) return;
    const schema = prismaSchemaPath(dashboardDir);
    const generatedSchema = generatedPrismaSchemaPath(dashboardDir);
    if (fs.existsSync(schema)
        && fs.existsSync(generatedSchema)
        && fs.statSync(schema).mtimeMs > fs.statSync(generatedSchema).mtimeMs + 1000) {
        console.warn('[dashboard] Prisma schema differs from the generated client; skipping `prisma generate` so live dashboard builds remain swappable. Stop the dashboard and set DASHBOARD_FORCE_PRISMA_GENERATE=1 when regenerated Prisma types are required.');
    }
}

function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function distPath(dashboardDir, distDir) {
    return path.resolve(dashboardDir, distDir);
}

function normalizeDistDir(distDir) {
    return String(distDir || '').replace(/[\\/]+/g, '/');
}

function isSafeRelativeDistDir(dashboardDir, distDir) {
    const normalized = normalizeDistDir(distDir);
    return normalized.trim() !== ''
        && !path.isAbsolute(normalized)
        && isPathInside(dashboardDir, distPath(dashboardDir, normalized));
}

function readBuildId(dashboardDir, distDir) {
    if (!isSafeRelativeDistDir(dashboardDir, distDir)) return null;
    const buildIdPath = path.join(distPath(dashboardDir, normalizeDistDir(distDir)), 'BUILD_ID');
    if (!fs.existsSync(buildIdPath)) return null;
    return fs.readFileSync(buildIdPath, 'utf8').trim();
}

function hasProductionBuild(dashboardDir, distDir) {
    return Boolean(readBuildId(dashboardDir, distDir));
}

function readCurrentBuild(dashboardDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(currentBuildFile(dashboardDir), 'utf8'));
        if (!isSafeRelativeDistDir(dashboardDir, parsed.distDir)) return null;
        const distDir = normalizeDistDir(parsed.distDir);
        const buildId = readBuildId(dashboardDir, distDir);
        if (!buildId) return null;
        return {
            distDir,
            buildId,
            builtAt: parsed.builtAt || null,
        };
    } catch {
        return null;
    }
}

function findProductionBuild(dashboardDir) {
    return readCurrentBuild(dashboardDir)
        || (hasProductionBuild(dashboardDir, LEGACY_DIST_DIR)
            ? { distDir: LEGACY_DIST_DIR, buildId: readBuildId(dashboardDir, LEGACY_DIST_DIR), builtAt: null }
            : null);
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

function productionBuildIsStale(dashboardDir, distDir) {
    const buildIdPath = path.join(distPath(dashboardDir, normalizeDistDir(distDir)), 'BUILD_ID');
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
        'package-lock.json',
        'next.config.js',
        'next.config.mjs',
        'next.config.ts',
        'postcss.config.mjs',
        'tailwind.config.ts',
        'tailwind.config.js',
        'tsconfig.json',
    ];
    return sourcePaths.some(sourcePath => latestMtimeMs(path.join(dashboardDir, sourcePath)) > buildTime);
}

function writeCurrentBuild(dashboardDir, build) {
    fs.mkdirSync(buildRoot(dashboardDir), { recursive: true });
    const target = currentBuildFile(dashboardDir);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({
        version: 1,
        distDir: normalizeDistDir(build.distDir),
        buildId: build.buildId,
        builtAt: build.builtAt,
    }, null, 2));
    fs.renameSync(temp, target);
}

function buildDistDirName() {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${BUILD_ROOT_DIR}/${stamp}-${process.pid}-${suffix}`;
}

function removeDirectoryBestEffort(targetPath) {
    try {
        fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (error) {
        console.warn(`[dashboard] could not remove ${targetPath}: ${error?.message || error}`);
    }
}

function pruneOldBuilds(dashboardDir, activeDistDir) {
    const root = buildRoot(dashboardDir);
    if (!fs.existsSync(root)) return;
    const keep = Math.max(1, Number(process.env.DASHBOARD_BUILD_KEEP || 3) || 3);
    const entries = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const fullPath = path.join(root, entry.name);
            const distDir = normalizeDistDir(path.relative(dashboardDir, fullPath));
            return {
                name: entry.name,
                fullPath,
                distDir,
                mtimeMs: fs.statSync(fullPath).mtimeMs,
            };
        })
        .filter(entry => entry.distDir !== activeDistDir)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const entry of entries.slice(Math.max(0, keep - 1))) {
        removeDirectoryBestEffort(entry.fullPath);
    }
}

function runChecked(command, args, options) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        windowsHide: true,
        ...options,
    });
    if (result.error) {
        console.error(result.error);
        return 1;
    }
    return result.status ?? 1;
}

function runProductionBuild(dashboardDir, env) {
    const stagingDistDir = BUILD_WORK_DIR;
    const finalDistDir = buildDistDirName();
    const absoluteStagingDistDir = distPath(dashboardDir, stagingDistDir);
    const absoluteFinalDistDir = distPath(dashboardDir, finalDistDir);
    fs.mkdirSync(buildRoot(dashboardDir), { recursive: true });
    removeDirectoryBestEffort(absoluteStagingDistDir);

    console.warn(`[dashboard] building production dashboard into ${stagingDistDir}.`);
    if (shouldGeneratePrismaClient(dashboardDir)) {
        const prismaStatus = runChecked(process.execPath, [prismaCli(dashboardDir), 'generate'], {
            cwd: dashboardDir,
            env,
        });
        if (prismaStatus !== 0) return prismaStatus;
    } else {
        warnIfPrismaClientMayBeStale(dashboardDir);
        console.log('[dashboard] using existing Prisma Client.');
    }

    const buildEnv = {
        ...env,
        DASHBOARD_NEXT_DIST_DIR: stagingDistDir,
    };
    const managedFileSnapshots = snapshotFiles(dashboardDir, ['next-env.d.ts', 'tsconfig.json']);
    let buildStatus = 1;
    try {
        buildStatus = runChecked(process.execPath, [nextCli(dashboardDir), 'build'], {
            cwd: dashboardDir,
            env: buildEnv,
        });
    } finally {
        restoreFiles(managedFileSnapshots);
    }
    if (buildStatus !== 0) {
        removeDirectoryBestEffort(absoluteStagingDistDir);
        return buildStatus;
    }

    const buildId = readBuildId(dashboardDir, stagingDistDir);
    if (!buildId) {
        console.error(`[dashboard] next build finished, but ${path.join(stagingDistDir, 'BUILD_ID')} was not found.`);
        removeDirectoryBestEffort(absoluteStagingDistDir);
        return 1;
    }

    removeDirectoryBestEffort(absoluteFinalDistDir);
    try {
        fs.renameSync(absoluteStagingDistDir, absoluteFinalDistDir);
    } catch (error) {
        console.error(`[dashboard] could not activate ${finalDistDir}: ${error?.message || error}`);
        removeDirectoryBestEffort(absoluteStagingDistDir);
        return 1;
    }

    const build = {
        distDir: finalDistDir,
        buildId,
        builtAt: new Date().toISOString(),
    };
    writeCurrentBuild(dashboardDir, build);
    pruneOldBuilds(dashboardDir, finalDistDir);
    console.log(`[dashboard] activated production build ${buildId} from ${finalDistDir}.`);
    return 0;
}

function ensureFreshProductionBuild(dashboardDir, env) {
    const build = findProductionBuild(dashboardDir);
    if (build && !productionBuildIsStale(dashboardDir, build.distDir)) {
        return build;
    }

    console.warn('[dashboard] production build is missing or stale. Running `npm run build` before start.');
    const status = runProductionBuild(dashboardDir, env);
    if (status !== 0) process.exit(status);
    const nextBuild = findProductionBuild(dashboardDir);
    if (!nextBuild) {
        console.error('[dashboard] production build could not be activated.');
        process.exit(1);
    }
    return nextBuild;
}

function buildSignature(build) {
    return build ? `${build.distDir}:${build.buildId}` : '';
}

function startManagedProductionServer(dashboardDir, env, port, baseUrl) {
    let child = null;
    let activeSignature = '';
    let restartTimer = null;
    let restartPending = false;
    let stopping = false;
    let forceKillTimer = null;

    function clearForceKillTimer() {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        forceKillTimer = null;
    }

    function launch() {
        const build = findProductionBuild(dashboardDir);
        if (!build) {
            console.error('[dashboard] production build is missing. Run `npm run build` first.');
            process.exit(1);
        }
        activeSignature = buildSignature(build);
        const startEnv = {
            ...env,
            DASHBOARD_NEXT_DIST_DIR: build.distDir,
        };
        console.log(`[dashboard] starting Next.js on ${baseUrl} from ${build.distDir} (${build.buildId}).`);
        const arguments_ = [nextCli(dashboardDir), 'start', '--port', String(port)];
        if (env.DASHBOARD_HOSTNAME) arguments_.push('--hostname', env.DASHBOARD_HOSTNAME);
        child = spawn(process.execPath, arguments_, {
            cwd: dashboardDir,
            env: startEnv,
            stdio: 'inherit',
            windowsHide: true,
        });
        child.on('error', error => {
            console.error(error);
        });
        child.on('exit', (code, signal) => {
            clearForceKillTimer();
            child = null;
            if (stopping) {
                process.exit(code ?? (signal ? 0 : 1));
            }
            if (restartPending) {
                restartPending = false;
                launch();
                return;
            }
            console.warn(`[dashboard] Next.js exited${signal ? ` by ${signal}` : ''}${code === null ? '' : ` with code ${code}`}.`);
            process.exit(code ?? 1);
        });
    }

    function restartForBuild(build) {
        if (restartPending) return;
        restartPending = true;
        console.warn(`[dashboard] detected activated build ${build.buildId}; restarting dashboard server.`);
        if (!child) {
            restartPending = false;
            launch();
            return;
        }
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
            if (child) child.kill('SIGKILL');
        }, RESTART_GRACE_MS);
    }

    function checkForActivatedBuild() {
        const build = readCurrentBuild(dashboardDir);
        if (!build) return;
        if (buildSignature(build) !== activeSignature) {
            restartForBuild(build);
        }
    }

    function scheduleRestartCheck() {
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(checkForActivatedBuild, RESTART_DEBOUNCE_MS);
    }

    fs.mkdirSync(buildRoot(dashboardDir), { recursive: true });
    const watcher = fs.watch(buildRoot(dashboardDir), (eventType, filename) => {
        if (!filename || filename === CURRENT_BUILD_FILE) scheduleRestartCheck();
    });
    const poller = setInterval(checkForActivatedBuild, 5000);
    poller.unref();

    function stop(signal) {
        stopping = true;
        if (restartTimer) clearTimeout(restartTimer);
        clearInterval(poller);
        watcher.close();
        clearForceKillTimer();
        if (child) {
            child.kill(signal);
        } else {
            process.exit(signal === 'SIGINT' ? 130 : 143);
        }
    }

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));

    launch();
}

function main() {
    loadRuntimeEnvironment();
    const modeArg = process.argv[2] || 'dev';
    const mode = ['start', 'serve', 'build', 'prepare'].includes(modeArg) ? modeArg : 'dev';
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
        MEDIA_DELIVERY_PUBLIC_BASE_URL: process.env.MEDIA_DELIVERY_PUBLIC_BASE_URL
            ?? (mediaDelivery.publicBaseUrl || dashboard.publicBaseUrl || dashboard.baseUrl || config.publicBaseUrl || baseUrl),
    };

    applyConfigurationDefaults(env, config);

    const dashboardDir = path.resolve(__dirname, '..');

    delete env.DASHBOARD_NEXT_DIST_DIR;

    if (mode === 'build') {
        process.exit(runProductionBuild(dashboardDir, env));
    }

    if (mode === 'prepare') {
        ensureFreshProductionBuild(dashboardDir, env);
        process.exit(0);
    }

    if (mode === 'start') {
        ensureFreshProductionBuild(dashboardDir, env);
        startManagedProductionServer(dashboardDir, env, port, baseUrl);
        return;
    }

    if (mode === 'serve') {
        // An independent service must never rebuild or prune a working dashboard
        // just because the Bot or its source checkout changed.
        if (!findProductionBuild(dashboardDir)) {
            console.error('[dashboard] selected production build is unavailable; create and verify a build before starting this service.');
            process.exit(1);
        }
        startManagedProductionServer(dashboardDir, env, port, baseUrl);
        return;
    }

    const devEnv = {
        ...env,
        DASHBOARD_NEXT_DIST_DIR: process.env.DASHBOARD_NEXT_DEV_DIST_DIR || DEV_DIST_DIR,
    };
    const result = spawnSync(process.execPath, [nextCli(dashboardDir), 'dev', '--port', String(port)], {
        cwd: dashboardDir,
        env: devEnv,
        stdio: 'inherit',
        windowsHide: true,
    });

    if (result.error) {
        console.error(result.error);
        process.exitCode = 1;
    } else {
        process.exitCode = result.status ?? 1;
    }
}

if (require.main === module) main();

module.exports = {
    _internal: {
        applyConfigurationDefaults,
        findProductionBuild,
        loadRuntimeEnvironment,
        main,
        readCurrentBuild,
        startManagedProductionServer,
    },
};
