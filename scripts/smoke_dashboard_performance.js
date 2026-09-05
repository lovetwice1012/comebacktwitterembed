'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
    const dashboard = path.resolve(__dirname, '../dashboard');
    const distDir = '.next-performance-check';
    assert.ok(fs.existsSync(path.join(dashboard, distDir, 'BUILD_ID')), 'Build the isolated validation output first.');
    const port = 30989;
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd: dashboard, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
            DASHBOARD_NEXT_DIST_DIR: distDir, DASHBOARD_ADMIN_ANALYTICS_PREWARM: '0',
            NEXTAUTH_URL: `http://127.0.0.1:${port}`, NEXTAUTH_SECRET: 'isolated-performance-smoke-only',
            // Prevent accidental access to configured application data.
            DATABASE_URL: 'mysql://smoke:smoke@127.0.0.1:9/smoke?connection_limit=1&connect_timeout=1',
        },
    });
    const stopped = new Promise(resolve => child.once('exit', resolve));
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Validation server startup timed out')), 30000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Validation server exited: ${code}`)); });
            child.stdout.on('data', chunk => {
                if (String(chunk).includes('Ready in')) { clearTimeout(timer); resolve(); }
            });
            child.stderr.on('data', () => {});
        });
        const results = [];
        for (const [route, expected] of [['/', 200], ['/api/admin/overview', 401], ['/api/admin/analytics', 401], ['/api/guilds/switcher', 401]]) {
            const response = await fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
            await response.arrayBuffer();
            assert.equal(response.status, expected, route);
            results.push({ route, status: response.status });
        }
        console.log(JSON.stringify({ localOnly: true, authenticatedAnalytics: 'not tested', results }, null, 2));
    } finally {
        child.kill();
        await stopped;
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
