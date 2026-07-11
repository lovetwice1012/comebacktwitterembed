'use strict';

const dns = require('node:dns/promises');
const path = require('node:path');
const { assertSupportedRuntime } = require('../src/runtime');

const TIMEOUT_MS = 10000;

function loadInstalledUndici() {
    const packageRoot = path.dirname(require.resolve('undici/package.json'));
    return require(packageRoot);
}

async function checkRest() {
    const { fetch } = loadInstalledUndici();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    try {
        const response = await fetch('https://discord.com/api/v10/gateway', {
            headers: { 'User-Agent': 'comebacktwitterembed-network-smoke' },
            signal: controller.signal,
        });
        const body = await response.text();
        const payload = JSON.parse(body);
        if (!response.ok || typeof payload.url !== 'string') {
            throw new Error('Discord REST gateway probe returned HTTP ' + response.status + '.');
        }
        return { latencyMs: Date.now() - startedAt, status: response.status };
    } finally {
        clearTimeout(timeout);
    }
}

async function checkGateway() {
    const wsModule = require('ws');
    const WebSocketConstructor = wsModule.WebSocket ?? wsModule;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const socket = new WebSocketConstructor('wss://gateway.discord.gg/?v=10&encoding=json');
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(value);
        };
        const timeout = setTimeout(() => {
            socket.terminate?.();
            finish(new Error('Discord Gateway HELLO timed out after ' + TIMEOUT_MS + 'ms.'));
        }, TIMEOUT_MS);

        socket.once('message', data => {
            try {
                const payload = JSON.parse(String(data));
                if (payload.op !== 10) throw new Error('Expected Gateway HELLO opcode 10.');
                const heartbeatIntervalMs = Number(payload.d?.heartbeat_interval);
                socket.close(1000, 'network smoke complete');
                finish(null, {
                    helloLatencyMs: Date.now() - startedAt,
                    heartbeatIntervalMs,
                });
            } catch (error) {
                socket.terminate?.();
                finish(error);
            }
        });
        socket.once('error', error => finish(error));
    });
}

async function main() {
    const runtime = assertSupportedRuntime();
    const [restAddresses, gatewayAddresses, rest, gateway] = await Promise.all([
        dns.lookup('discord.com', { all: true }),
        dns.lookup('gateway.discord.gg', { all: true }),
        checkRest(),
        checkGateway(),
    ]);

    console.log(JSON.stringify({
        runtime,
        version: process.versions.bun || process.versions.node,
        discordAddresses: restAddresses,
        gatewayAddresses,
        rest,
        gateway,
    }));
}

main().catch(error => {
    console.error('[smoke:discord]', error);
    process.exitCode = 1;
});
