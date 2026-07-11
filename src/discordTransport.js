'use strict';

const path = require('node:path');

function loadInstalledUndici() {
    // Bun special-cases a bare require('undici') and returns its built-in
    // compatibility layer. Resolving package.json first gives Discord REST
    // the pinned npm implementation instead.
    const packageRoot = path.dirname(require.resolve('undici/package.json'));
    return require(packageRoot);
}

/**
 * Loads discord.js with Bun-specific transport compatibility applied only while
 * @discordjs/ws selects its WebSocket constructor. The native Bun global is
 * restored immediately so unrelated application traffic keeps Bun's fast path.
 *
 * @param {object} [options]
 * @param {boolean} [options.isBun]
 * @param {Record<string, any>} [options.target]
 * @param {() => any} [options.loadWebSocket]
 * @param {() => any} [options.loadDiscord]
 * @param {() => {fetch: Function}} [options.loadUndici]
 */
function loadDiscordRuntime(options = {}) {
    const isBun = options.isBun ?? Boolean(process.versions?.bun);
    const target = options.target ?? globalThis;
    const loadWebSocket = options.loadWebSocket ?? (() => require('ws'));
    const loadDiscord = options.loadDiscord ?? (() => require('discord.js'));
    const loadUndici = options.loadUndici ?? loadInstalledUndici;

    if (!isBun) {
        return {
            discord: loadDiscord(),
            gatewayTransport: 'default',
            restOptions: undefined,
            restTransport: 'default',
        };
    }

    const webSocketModule = loadWebSocket();
    const WebSocketConstructor = webSocketModule?.WebSocket ?? webSocketModule;
    if (typeof WebSocketConstructor !== 'function') {
        throw new TypeError('The ws compatibility module did not export a WebSocket constructor.');
    }

    const originalDescriptor = Object.getOwnPropertyDescriptor(target, 'WebSocket');
    let discord;
    try {
        Object.defineProperty(target, 'WebSocket', {
            configurable: true,
            writable: true,
            value: WebSocketConstructor,
        });
        discord = loadDiscord();
    } finally {
        if (originalDescriptor) Object.defineProperty(target, 'WebSocket', originalDescriptor);
        else delete target.WebSocket;
    }

    const { fetch } = loadUndici();
    if (typeof fetch !== 'function') {
        throw new TypeError('The installed undici package did not export fetch.');
    }

    return {
        discord,
        gatewayTransport: 'bun-ws-compat',
        restOptions: {
            async makeRequest(url, init) {
                const response = await fetch(url, init);
                return {
                    body: response.body,
                    arrayBuffer: () => response.arrayBuffer(),
                    json: () => response.json(),
                    text: () => response.text(),
                    get bodyUsed() {
                        return response.bodyUsed;
                    },
                    headers: response.headers,
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                };
            },
        },
        restTransport: 'npm-undici',
    };
}

module.exports = { loadDiscordRuntime };
