'use strict';

const assert = require('assert/strict');
const { assertSupportedRuntime } = require('../src/runtime');
const { loadDiscordRuntime } = require('../src/discordTransport');

async function main() {
    assert.equal(assertSupportedRuntime(), 'bun');

    const nativeWebSocket = globalThis.WebSocket;
    const runtime = loadDiscordRuntime({ isBun: true });
    assert.equal(runtime.gatewayTransport, 'bun-ws-compat');
    assert.equal(runtime.restTransport, 'npm-undici');
    assert.equal(globalThis.WebSocket, nativeWebSocket, 'native Bun WebSocket must be restored after discord.js loads');
    assert.equal(typeof runtime.restOptions.makeRequest, 'function');
    assert.equal(typeof runtime.discord.Client, 'function');

    const webSocketModule = require('ws');
    const WebSocketConstructor = webSocketModule.WebSocket ?? webSocketModule;
    const server = Bun.serve({
        port: 0,
        fetch(request, bunServer) {
            if (bunServer.upgrade(request)) return undefined;
            return Response.json({ transport: 'npm-undici' });
        },
        websocket: {
            message(socket) {
                socket.close(1000, 'smoke complete');
            },
        },
    });

    try {
        const response = await runtime.restOptions.makeRequest(
            'http://127.0.0.1:' + server.port + '/smoke',
            { method: 'GET' }
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { transport: 'npm-undici' });

        const socket = new WebSocketConstructor(`ws://127.0.0.1:${server.port}`);
        assert.doesNotThrow(() => socket.send('ignored-before-open'));
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Bun ws compatibility smoke test timed out.')), 5000);
            socket.once('open', () => socket.send('after-open'));
            socket.once('close', () => {
                clearTimeout(timeout);
                resolve();
            });
            socket.once('error', error => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    } finally {
        server.stop(true);
    }

    console.log(JSON.stringify({
        bun: process.versions.bun,
        discordGateway: runtime.gatewayTransport,
        discordRest: runtime.restTransport,
        preOpenSend: 'ignored-safely',
    }));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
