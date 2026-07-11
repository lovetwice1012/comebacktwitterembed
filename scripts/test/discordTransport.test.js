'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadDiscordRuntime } = require('../../src/discordTransport');

test('Node loads discord.js without transport overrides', () => {
    const nativeWebSocket = function NativeWebSocket() {};
    const target = { WebSocket: nativeWebSocket };
    const discord = { Client: function Client() {} };
    let webSocketLoads = 0;
    let undiciLoads = 0;

    const runtime = loadDiscordRuntime({
        isBun: false,
        target,
        loadDiscord: () => discord,
        loadWebSocket: () => {
            webSocketLoads++;
        },
        loadUndici: () => {
            undiciLoads++;
        },
    });

    assert.equal(runtime.discord, discord);
    assert.equal(runtime.gatewayTransport, 'default');
    assert.equal(runtime.restTransport, 'default');
    assert.equal(runtime.restOptions, undefined);
    assert.equal(target.WebSocket, nativeWebSocket);
    assert.equal(webSocketLoads, 0);
    assert.equal(undiciLoads, 0);
});

test('Bun captures its ws adapter for Discord and restores the native global', async () => {
    const nativeWebSocket = function NativeWebSocket() {};
    const compatWebSocket = function BunWsCompat() {};
    const target = { WebSocket: nativeWebSocket };
    const discord = { Client: function Client() {} };
    const calls = [];

    const runtime = loadDiscordRuntime({
        isBun: true,
        target,
        loadWebSocket: () => ({ WebSocket: compatWebSocket }),
        loadDiscord: () => {
            assert.equal(target.WebSocket, compatWebSocket);
            return discord;
        },
        loadUndici: () => ({
            fetch: async (url, init) => {
                calls.push({ url, init });
                return {
                    body: 'body',
                    bodyUsed: false,
                    headers: { test: 'header' },
                    status: 204,
                    statusText: 'No Content',
                    ok: true,
                    arrayBuffer: async () => new ArrayBuffer(0),
                    json: async () => ({ ok: true }),
                    text: async () => '',
                };
            },
        }),
    });

    assert.equal(runtime.discord, discord);
    assert.equal(runtime.gatewayTransport, 'bun-ws-compat');
    assert.equal(runtime.restTransport, 'npm-undici');
    assert.equal(target.WebSocket, nativeWebSocket);

    const response = await runtime.restOptions.makeRequest('https://example.test', { method: 'GET' });
    assert.equal(response.status, 204);
    assert.equal(response.statusText, 'No Content');
    assert.equal(response.ok, true);
    assert.equal(response.body, 'body');
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(calls, [{ url: 'https://example.test', init: { method: 'GET' } }]);
});

test('Bun restores the native global if discord.js fails to load', () => {
    const nativeWebSocket = function NativeWebSocket() {};
    const target = { WebSocket: nativeWebSocket };

    assert.throws(
        () => loadDiscordRuntime({
            isBun: true,
            target,
            loadWebSocket: () => ({ WebSocket: function BunWsCompat() {} }),
            loadDiscord: () => {
                throw new Error('discord load failed');
            },
        }),
        /discord load failed/
    );
    assert.equal(target.WebSocket, nativeWebSocket);
});
