'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '../..');
const lifecycleSource = fs.readFileSync(path.join(repo, 'src/lifecycle/dashboardServer.js'), 'utf8');
const launcherSource = fs.readFileSync(path.join(repo, 'dashboard/scripts/start-dashboard.js'), 'utf8');

function lifecycle(config, environment = {}) {
    const calls = [];
    const fixtureProcess = { env: { ...environment }, execPath: process.execPath, platform: process.platform };
    const sandbox = {
        require(name) {
            if (name === 'child_process') return { spawn() { calls.push('spawn'); throw new Error('Unexpected dashboard process ownership'); } };
            if (name === 'fs') return { readFileSync() { return JSON.stringify(config); }, existsSync() { return true; } };
            return require(name);
        },
        __dirname: path.join(repo, 'src/lifecycle'),
        module: { exports: {} }, process: fixtureProcess,
        console: { log() {}, warn() {} },
    };
    vm.runInNewContext(lifecycleSource, sandbox, { filename: 'dashboardServer.js' });
    return { api: sandbox.module.exports, env: fixtureProcess.env, calls };
}

test('external dashboard ownership skips Bot preparation/start/stop and preserves integrated media', async () => {
    const fixture = lifecycle({ dashboard: { publicBaseUrl: 'https://dashboard.example', managedExternally: true },
        mediaDelivery: { publicBaseUrl: 'https://media.example', useLegacyRoutes: false, serverMode: 'integrated' } });
    assert.equal(await fixture.api.prepare(), true);
    assert.equal(fixture.api.start(), null);
    fixture.api.stop();
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.env.DASHBOARD_INTEGRATED_MEDIA_SERVER, 'true');
    assert.equal(fixture.env.MEDIA_DELIVERY_PUBLIC_BASE_URL, 'https://media.example');
    assert.equal(fixture.env.NEXTAUTH_URL, 'https://dashboard.example');
    assert.equal(fixture.env.MEDIA_DELIVERY_USE_LEGACY_ROUTES, 'false');
    assert.equal(fixture.env.MEDIA_DELIVERY_SERVER_MODE, 'integrated');
});

test('explicit external-management environment overrides config and preserves canonical origins', async () => {
    const fixture = lifecycle({ dashboard: { managedExternally: false, publicBaseUrl: 'https://configured.example' } },
        { DASHBOARD_MANAGED_EXTERNALLY: 'true', NEXTAUTH_URL: 'https://canonical.example', MEDIA_DELIVERY_PUBLIC_BASE_URL: 'https://canonical.example' });
    assert.equal(await fixture.api.prepare(), true);
    assert.equal(fixture.api.start(), null);
    assert.equal(fixture.env.NEXTAUTH_URL, 'https://canonical.example');
    assert.equal(fixture.env.DASHBOARD_BASE_URL, 'https://canonical.example');
    assert.equal(fixture.env.MEDIA_DELIVERY_PUBLIC_BASE_URL, 'https://canonical.example');
    assert.deepEqual(fixture.calls, []);
    assert.equal(lifecycle({ dashboard: { managedExternally: true } }, { DASHBOARD_MANAGED_EXTERNALLY: 'false' }).api._internal.isExternallyManaged(), false);
});

function sourceFixture(config = { dashboard: { publicBaseUrl: 'https://fixture.example' } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-independent-dashboard-'));
    const dashboard = path.join(root, 'dashboard');
    fs.mkdirSync(path.join(dashboard, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dashboard, 'node_modules/next/dist/bin'), { recursive: true });
    fs.mkdirSync(path.join(dashboard, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(dashboard, 'scripts/start-dashboard.js'), launcherSource);
    fs.writeFileSync(path.join(dashboard, 'app/changed-after-build.tsx'), 'source newer than selected build');
    fs.writeFileSync(path.join(dashboard, 'node_modules/next/dist/bin/next'), `
const fs = require('node:fs'), path = require('node:path');
const event = { mode: process.argv[2], pid: process.pid, dist: process.env.DASHBOARD_NEXT_DIST_DIR,
    sentinel: process.env.DASHBOARD_TEST_SENTINEL, base: process.env.NEXTAUTH_URL,
    fleetMode: process.env.DASHBOARD_FLEET_LEASE_MODE,
    hostname: process.argv.includes('--hostname') ? process.argv[process.argv.indexOf('--hostname') + 1] : null,
    explicitCredentials: process.env.NEXTAUTH_SECRET === 'explicit-auth' && process.env.DISCORD_CLIENT_SECRET === 'explicit-discord'
        && process.env.DISCORD_BOT_TOKEN === 'explicit-bot' && process.env.DASHBOARD_AUDIT_HASH_SECRET === 'explicit-audit',
    clientId: process.env.DISCORD_CLIENT_ID, timeout: process.env.DISCORD_API_TIMEOUT_MS,
    useBotGuildApi: process.env.DASHBOARD_USE_BOT_GUILD_API, loadSummary: process.env.DASHBOARD_LOAD_GUILD_PROVIDER_SUMMARY,
    delegatedAccess: process.env.DASHBOARD_DELEGATED_ACCESS_ENABLED, prewarm: process.env.DASHBOARD_ADMIN_ANALYTICS_PREWARM,
    legacyRoutes: process.env.MEDIA_DELIVERY_USE_LEGACY_ROUTES, mediaMode: process.env.MEDIA_DELIVERY_SERVER_MODE,
    mediaBase: process.env.MEDIA_DELIVERY_PUBLIC_BASE_URL };
fs.appendFileSync(path.join(process.cwd(), 'launches.jsonl'), JSON.stringify(event) + '\\n');
if (event.mode !== 'start') process.exit(71);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 100);
`);
    return { root, dashboard };
}

function selectBuild(fixture, name, id) {
    const distDir = `.next-builds/${name}`;
    fs.mkdirSync(path.join(fixture.dashboard, distDir), { recursive: true });
    fs.writeFileSync(path.join(fixture.dashboard, distDir, 'BUILD_ID'), id);
    fs.writeFileSync(path.join(fixture.dashboard, '.next-builds/current.json'), JSON.stringify({ version: 1, distDir, buildId: id }));
}

function launches(fixture) {
    const filename = path.join(fixture.dashboard, 'launches.jsonl');
    if (!fs.existsSync(filename)) return [];
    return fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function until(predicate, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Timed out waiting for dashboard fixture');
}

async function stop(processToStop) {
    if (processToStop.exitCode !== null || processToStop.signalCode !== null) return;
    processToStop.kill('SIGTERM');
    await until(() => processToStop.exitCode !== null || processToStop.signalCode !== null);
}

test('serve refuses missing builds without running Next build or Prisma generation', () => {
    const fixture = sourceFixture();
    try {
        const result = spawnSync(process.execPath, [path.join(fixture.dashboard, 'scripts/start-dashboard.js'), 'serve'], { cwd: fixture.dashboard, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /selected production build is unavailable/);
        assert.deepEqual(launches(fixture), []);
        assert.equal(fs.existsSync(path.join(fixture.dashboard, '.next-build')), false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('private environment JSON supplies runtime settings while explicit service flags win', async () => {
    const fixture = sourceFixture();
    selectBuild(fixture, 'old', 'oldBuild');
    const privateFile = path.join(fixture.root, 'environment.json');
    fs.writeFileSync(privateFile, JSON.stringify({ NEXTAUTH_URL: 'https://captured.example',
        DASHBOARD_TEST_SENTINEL: 'private-fixture', DASHBOARD_FLEET_LEASE_MODE: 'strict' }), { mode: 0o600 });
    const wrapper = spawn(process.execPath, [path.join(fixture.dashboard, 'scripts/start-dashboard.js'), 'serve'], {
        cwd: fixture.dashboard, stdio: 'ignore', env: { ...process.env, DASHBOARD_RUNTIME_ENV_FILE: privateFile,
            DASHBOARD_FLEET_LEASE_MODE: 'shared-current', DASHBOARD_HOSTNAME: '127.0.0.1' },
    });
    try {
        if (process.platform !== 'win32' && process.getuid() !== 0) {
            await until(() => wrapper.exitCode !== null);
            assert.notEqual(wrapper.exitCode, 0);
            assert.deepEqual(launches(fixture), []);
        } else {
            await until(() => launches(fixture).length === 1);
            assert.equal(launches(fixture)[0].sentinel, 'private-fixture');
            assert.equal(launches(fixture)[0].base, 'https://captured.example');
            assert.equal(launches(fixture)[0].fleetMode, 'shared-current');
            assert.equal(launches(fixture)[0].hostname, '127.0.0.1');
        }
    } finally {
        await stop(wrapper);
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('invalid private environment JSON fails without exposing its contents', () => {
    const fixture = sourceFixture();
    const privateFile = path.join(fixture.root, 'environment.json');
    const secret = 'PRIVATE_FIXTURE_MUST_NOT_APPEAR';
    fs.writeFileSync(privateFile, '{"NEXTAUTH_SECRET":"' + secret, { mode: 0o600 });
    try {
        const result = spawnSync(process.execPath, [path.join(fixture.dashboard, 'scripts/start-dashboard.js'), 'serve'], {
            cwd: fixture.dashboard, encoding: 'utf8', env: { ...process.env, DASHBOARD_RUNTIME_ENV_FILE: privateFile },
        });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
        assert.deepEqual(launches(fixture), []);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('serve keeps explicit credentials and operational flags when config contains conflicting defaults', async () => {
    const fixture = sourceFixture({ token: 'config-bot', dashboard: {
        publicBaseUrl: 'https://fixture.example', clientId: 'config-client', clientSecret: 'config-discord',
        nextAuthSecret: 'config-auth', auditHashSecret: 'config-audit', discordApiTimeoutMs: 1000,
        useBotGuildApi: true, loadGuildProviderSummary: false, delegatedAccessEnabled: true, adminAnalyticsPrewarm: true,
    }, mediaDelivery: { publicBaseUrl: 'https://config-media.example', useLegacyRoutes: true, serverMode: 'config-mode' } });
    selectBuild(fixture, 'old', 'oldBuild');
    const wrapper = spawn(process.execPath, [path.join(fixture.dashboard, 'scripts/start-dashboard.js'), 'serve'], {
        cwd: fixture.dashboard, stdio: 'ignore', env: { ...process.env,
            NEXTAUTH_SECRET: 'explicit-auth', DISCORD_CLIENT_SECRET: 'explicit-discord', DISCORD_BOT_TOKEN: 'explicit-bot',
            DISCORD_CLIENT_ID: 'explicit-client', DASHBOARD_AUDIT_HASH_SECRET: 'explicit-audit', DISCORD_API_TIMEOUT_MS: '2345',
            DASHBOARD_USE_BOT_GUILD_API: 'false', DASHBOARD_LOAD_GUILD_PROVIDER_SUMMARY: 'true',
            DASHBOARD_DELEGATED_ACCESS_ENABLED: 'false', DASHBOARD_ADMIN_ANALYTICS_PREWARM: 'false',
            MEDIA_DELIVERY_USE_LEGACY_ROUTES: 'false', MEDIA_DELIVERY_SERVER_MODE: 'explicit-mode',
            MEDIA_DELIVERY_PUBLIC_BASE_URL: 'https://explicit-media.example',
        },
    });
    try {
        await until(() => launches(fixture).length === 1);
        const observed = launches(fixture)[0];
        assert.equal(observed.explicitCredentials, true);
        assert.equal(observed.clientId, 'explicit-client');
        assert.equal(observed.timeout, '2345');
        assert.equal(observed.useBotGuildApi, 'false');
        assert.equal(observed.loadSummary, 'true');
        assert.equal(observed.delegatedAccess, 'false');
        assert.equal(observed.prewarm, 'false');
        assert.equal(observed.legacyRoutes, 'false');
        assert.equal(observed.mediaMode, 'explicit-mode');
        assert.equal(observed.mediaBase, 'https://explicit-media.example');
    } finally {
        await stop(wrapper);
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('private snapshot defaults survive config while explicit environment wins and missing values use config', () => {
    const snapshot = JSON.stringify({ NEXTAUTH_SECRET: 'snapshot-auth', DISCORD_CLIENT_SECRET: 'snapshot-discord',
        DASHBOARD_ADMIN_ANALYTICS_PREWARM: 'true', MEDIA_DELIVERY_USE_LEGACY_ROUTES: 'false' });
    let closed = 0;
    const fixtureProcess = { platform: 'linux', env: {
        DASHBOARD_RUNTIME_ENV_FILE: '/fixture/environment.json', NEXTAUTH_SECRET: 'explicit-auth',
        DASHBOARD_ADMIN_ANALYTICS_PREWARM: 'false',
    } };
    const sandbox = { __dirname: path.join(repo, 'dashboard/scripts'), module: { exports: {} }, process: fixtureProcess,
        require(name) {
            if (name === 'fs') return { openSync: () => 7, closeSync: () => { closed++; },
                fstatSync: () => ({ isFile: () => true, size: snapshot.length, uid: 0, mode: 0o100600 }),
                readFileSync: () => snapshot };
            return require(name);
        }, console, setTimeout, clearTimeout, setInterval, clearInterval };
    vm.runInNewContext(launcherSource, sandbox, { filename: 'start-dashboard.js' });
    sandbox.module.exports._internal.loadRuntimeEnvironment();
    const environment = { ...fixtureProcess.env };
    sandbox.module.exports._internal.applyConfigurationDefaults(environment, { token: 'config-bot', dashboard: {
        clientId: 'config-client', clientSecret: 'config-discord', nextAuthSecret: 'config-auth',
        adminAnalyticsPrewarm: true, useBotGuildApi: false, loadGuildProviderSummary: true,
    }, mediaDelivery: { useLegacyRoutes: true, serverMode: 'config-mode' } });
    assert.equal(closed, 1);
    assert.equal(environment.NEXTAUTH_SECRET, 'explicit-auth');
    assert.equal(environment.DISCORD_CLIENT_SECRET, 'snapshot-discord');
    assert.equal(environment.DASHBOARD_ADMIN_ANALYTICS_PREWARM, 'false');
    assert.equal(environment.MEDIA_DELIVERY_USE_LEGACY_ROUTES, 'false');
    assert.equal(environment.DISCORD_BOT_TOKEN, 'config-bot');
    assert.equal(environment.DISCORD_CLIENT_ID, 'config-client');
    assert.equal(environment.DASHBOARD_USE_BOT_GUILD_API, 'false');
    assert.equal(environment.DASHBOARD_LOAD_GUILD_PROVIDER_SUMMARY, 'true');
    assert.equal(environment.MEDIA_DELIVERY_SERVER_MODE, 'config-mode');
});

test('serve ignores newer sources and explicitly switches only its Next child on build activation', async () => {
    const fixture = sourceFixture();
    selectBuild(fixture, 'old', 'oldBuild');
    const newer = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(fixture.dashboard, 'app/changed-after-build.tsx'), newer, newer);
    const wrapper = spawn(process.execPath, [path.join(fixture.dashboard, 'scripts/start-dashboard.js'), 'serve'], { cwd: fixture.dashboard, stdio: 'ignore' });
    try {
        await until(() => launches(fixture).length === 1);
        const first = launches(fixture)[0];
        assert.equal(first.mode, 'start');
        assert.equal(first.dist, '.next-builds/old');
        selectBuild(fixture, 'new', 'newBuild');
        await until(() => launches(fixture).length === 2);
        const second = launches(fixture)[1];
        assert.equal(second.mode, 'start');
        assert.equal(second.dist, '.next-builds/new');
        assert.notEqual(first.pid, second.pid);
        assert.equal(wrapper.exitCode, null);
        assert.equal(fs.existsSync(path.join(fixture.dashboard, '.next-build')), false);
        assert.equal(fs.existsSync(path.join(fixture.dashboard, '.next-builds/old/BUILD_ID')), true);
    } finally {
        await stop(wrapper);
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('unexpected Next failure exits the wrapper so independent service supervision can restart it', async () => {
    const fixture = sourceFixture();
    selectBuild(fixture, 'old', 'oldBuild');
    const wrapper = spawn(process.execPath, [path.join(fixture.dashboard, 'scripts/start-dashboard.js'), 'serve'], { cwd: fixture.dashboard, stdio: 'ignore' });
    try {
        await until(() => launches(fixture).length === 1);
        process.kill(launches(fixture)[0].pid, 'SIGKILL');
        await until(() => wrapper.exitCode !== null || wrapper.signalCode !== null);
        assert.equal(wrapper.exitCode, 1);
    } finally {
        await stop(wrapper);
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('independent unit recovers Next exits and has no dependency coupling to Bot service', () => {
    const unit = fs.readFileSync(path.join(repo, 'deploy/systemd/cbte-dashboard.service'), 'utf8');
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^ExecStart=.*start-dashboard\.js serve$/m);
    assert.doesNotMatch(unit, /^(?:PartOf|BindsTo|Requires)=.*cbte\.service/m);
    assert.doesNotMatch(unit, /^After=.*cbte\.service/m);
});
