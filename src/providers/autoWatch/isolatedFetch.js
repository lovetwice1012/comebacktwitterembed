'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { monitorError } = require('./_shared');
const MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

function commandFor(platform, timeoutMs) {
    const worker = path.join(__dirname, 'fetchWorker.js');
    if (platform === 'linux') {
        const unit = `cbte-watch-fetch-${crypto.randomUUID()}`;
        return { command: '/usr/bin/systemd-run', args: [
            '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`,
            '-p', `MemoryMax=${MEMORY_BYTES}`, '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=100%',
            '-p', 'TasksMax=32', '-p', `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 5}`,
            '-p', 'NoNewPrivileges=yes', '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=read-only',
            '-p', 'PrivateTmp=yes', '-p', 'RestrictSUIDSGID=yes', '-p', 'LimitCORE=0',
            '-p', 'KillMode=control-group', '-p', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
            ...['127.0.0.0/8', '::1/128', '169.254.0.0/16', 'fe80::/10', '224.0.0.0/4', 'ff00::/8',
                '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'].flatMap(prefix => ['-p', `IPAddressDeny=${prefix}`]),
            '/usr/bin/prlimit', '--as=2147483648', '--', process.execPath, '--max-old-space-size=256', worker,
        ], unit };
    }
    if (platform === 'win32') return { command: process.env.AUTO_WATCH_PYTHON || 'python', args: [
        path.join(__dirname, 'isolation_windows.py'), String(MEMORY_BYTES),
        String(Math.ceil(timeoutMs / 1000) + 5), process.execPath, '--max-old-space-size=256', worker,
    ] };
    throw monitorError('AUTO_WATCH_ISOLATION_UNAVAILABLE', 'This platform needs an OS sandbox for automatic-watch acquisition.', { retryAfterMs: 300000 });
}

async function fetchIsolated(source, config, options = {}) {
    // Handle resolution plus RSS/fallback may use three network requests.
    const timeoutMs = config.timeoutMs * 3 + 10000;
    const spec = commandFor(options.platform || process.platform, timeoutMs);
    const launch = options.spawn || spawn;
    return new Promise((resolve, reject) => {
        const child = launch(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks = [];
        let bytes = 0, settled = false, ready = false, header = '';
        const stop = () => {
            child.kill();
            if (spec.unit) {
                const cleanup = spawn('/usr/bin/systemctl', ['stop', `${spec.unit}.service`], { stdio: 'ignore' });
                cleanup.on('error', () => {}); cleanup.unref();
            }
        };
        const fail = () => {
            if (settled) return;
            settled = true; clearTimeout(timer); stop();
            reject(monitorError('AUTO_WATCH_RESOURCE_BUSY', 'Provider acquisition was interrupted by its resource sandbox; it will be retried.', { retryAfterMs: 300000 }));
        };
        const timer = setTimeout(fail, timeoutMs + 10000);
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.stdout.on('data', chunk => {
            if (!ready) {
                header += chunk.toString('utf8');
                if (header.length > 16 || !'READY\n'.startsWith(header)) return fail();
                if (header !== 'READY\n') return;
                try {
                    if (spec.unit) require('./isolation_linux').limitUnitSwap(spec.unit, MEMORY_BYTES);
                    ready = true;
                    child.stdin.end(JSON.stringify({ source, config }));
                } catch { fail(); }
                return;
            }
            bytes += chunk.length;
            if (bytes > MAX_RESULT_BYTES) return fail();
            chunks.push(chunk);
        });
        // stderr may include paths or remote content. Drain it without exposing
        // it to the dashboard, console forwarding, or durable error records.
        child.stderr.resume();
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) return fail();
            settled = true; clearTimeout(timer);
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (value.error) reject(monitorError(value.error.code, value.error.message, {
                    status: value.error.status, retryAfterMs: value.error.retryAfterMs,
                }));
                else if (value.result && typeof value.result === 'object') resolve(value.result);
                else throw new Error('Invalid worker result');
            } catch { reject(monitorError('AUTO_WATCH_INVALID_RESPONSE', 'The acquisition worker returned an invalid result.')); }
        });
    });
}

module.exports = { fetchIsolated, _internal: { commandFor, MEMORY_BYTES, MAX_RESULT_BYTES } };
