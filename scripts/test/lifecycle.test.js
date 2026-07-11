'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Events } = require('discord.js');

function loadWithStateStub(relativeTarget, stateExports) {
    const targetPath = require.resolve(relativeTarget);
    const statePath = require.resolve('../../src/state');
    const originalTarget = require.cache[targetPath];
    const originalState = require.cache[statePath];

    delete require.cache[targetPath];
    require.cache[statePath] = {
        id: statePath,
        filename: statePath,
        loaded: true,
        exports: stateExports,
    };

    const loaded = require(targetPath);
    return {
        loaded,
        restore() {
            delete require.cache[targetPath];
            if (originalTarget) require.cache[targetPath] = originalTarget;
            if (originalState) require.cache[statePath] = originalState;
            else delete require.cache[statePath];
        },
    };
}

function installFakeIntervals() {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const timers = [];

    global.setInterval = (callback, delay) => {
        const timer = {
            callback,
            delay,
            cleared: false,
            unrefCalled: false,
            unref() {
                this.unrefCalled = true;
            },
        };
        timers.push(timer);
        return timer;
    };
    global.clearInterval = timer => {
        timer.cleared = true;
    };

    return {
        timers,
        restore() {
            global.setInterval = originalSetInterval;
            global.clearInterval = originalClearInterval;
        },
    };
}

test('presence: skips disconnected and unchanged presence broadcasts', () => {
    const presence = require('../../src/lifecycle/presence');
    const sent = [];
    let ready = false;
    const cache = { size: 3 };
    const client = {
        guilds: { cache },
        isReady: () => ready,
        readyTimestamp: 100,
        user: { setPresence: payload => sent.push(payload) },
    };

    assert.equal(presence.updatePresence(client), false);
    assert.equal(sent.length, 0);

    ready = true;
    assert.equal(presence.updatePresence(client), true);
    assert.equal(presence.updatePresence(client), false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].activities[0].name, /^3servers /);

    client.readyTimestamp = 200;
    assert.equal(presence.updatePresence(client), true);
    assert.equal(sent.length, 2);

    cache.size = 4;
    assert.equal(presence.updatePresence(client), true);
    assert.equal(sent.length, 3);
    assert.match(sent[2].activities[0].name, /^4servers /);
});

test('ready handler: registers one ClientReady listener', () => {
    const readyHandler = require('../../src/handlers/ready');
    const registrations = [];
    const client = {
        once(event, listener) {
            registrations.push({ event, listener });
        },
        on() {
            throw new Error('ready handler must not register a repeating listener');
        },
    };

    readyHandler.register(client, null, null);

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].event, Events.ClientReady);
    assert.equal(typeof registrations[0].listener, 'function');
});

test('stats poster: awaits and catches Discord sends before resetting counters', async () => {
    const counters = { processed: 2, processed_hour: 3, processed_day: 4 };
    let resets = 0;
    let resolveSend;
    let sentPayload;
    const sendPromise = new Promise(resolve => {
        resolveSend = resolve;
    });
    const channel = {
        send: payload => {
            sentPayload = payload;
            return sendPromise;
        },
    };
    const guild = { channels: { cache: new Map([['1189083636574724167', channel]]) } };
    const client = {
        guilds: { cache: new Map([['1175729394782851123', guild]]) },
        users: { cache: { size: 5 } },
        channels: { cache: { size: 6 } },
    };
    const harness = loadWithStateStub('../../src/lifecycle/statsPoster', {
        counters,
        resetCountersAfterStatsPost: () => {
            resets++;
        },
    });
    const eventMetrics = {
        snapshot: () => ({ lastMinute: 11, lastHour: 22, lastDay: 33, total: 44 }),
    };

    try {
        const pendingTick = harness.loaded.tick(client, eventMetrics);
        await Promise.resolve();
        assert.equal(resets, 0);

        resolveSend();
        await pendingTick;
        assert.equal(resets, 1);
        const eventFields = sentPayload.embeds[0].fields.filter(field => field.name.includes('Gatewayイベント数'));
        assert.equal(eventFields.length, 4);
        assert.deepEqual(eventFields.map(field => field.value), ['11events', '22events', '33events', '44events']);

        const originalWarn = console.warn;
        const warnings = [];
        console.warn = (...args) => warnings.push(args);
        channel.send = async () => {
            throw new Error('send failed');
        };
        try {
            await harness.loaded.tick(client, eventMetrics);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(resets, 2);
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][0]), /statsPoster/);
    } finally {
        harness.restore();
    }
});

test('stats poster: start is idempotent', () => {
    const intervals = installFakeIntervals();
    const harness = loadWithStateStub('../../src/lifecycle/statsPoster', {
        counters: { processed: 0, processed_hour: 0, processed_day: 0 },
        resetCountersAfterStatsPost() {},
    });

    try {
        const client = {};
        const first = harness.loaded.start(client);
        const second = harness.loaded.start(client);

        assert.equal(first, second);
        assert.equal(intervals.timers.length, 1);
        assert.equal(intervals.timers[0].delay, 60000);
        assert.equal(intervals.timers[0].unrefCalled, true);

        harness.loaded.stop();
        assert.equal(intervals.timers[0].cleared, true);
    } finally {
        harness.loaded.stop();
        harness.restore();
        intervals.restore();
    }
});

test('console flush: awaits all webhook sends and handles individual failures', async () => {
    const consoleBuffer = { text: 'a'.repeat(1901) };
    const payloads = [];
    const webhookClient = {
        async sendSlackMessage(payload) {
            payloads.push(payload);
            if (payloads.length === 2) throw new Error('webhook failed');
        },
    };
    const client = {
        user: {
            tag: 'bot#0001',
            displayAvatarURL: () => 'https://example.test/avatar.png',
        },
    };
    const harness = loadWithStateStub('../../src/lifecycle/consoleFlush', { consoleBuffer });
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args);

    try {
        const results = await harness.loaded.flush(client, webhookClient);

        assert.equal(consoleBuffer.text, 'a');
        assert.equal(payloads.length, 2);
        assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][0]), /consoleFlush/);
    } finally {
        console.warn = originalWarn;
        harness.restore();
    }
});

test('console flush: sends a bounded sequential batch and leaves backlog queued', async () => {
    const consoleBuffer = { text: 'x'.repeat(1900 * 5) };
    let inFlight = 0;
    let maxInFlight = 0;
    let sends = 0;
    const webhookClient = {
        async sendSlackMessage() {
            sends++;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight--;
        },
    };
    const client = {
        user: {
            tag: 'bot#0001',
            displayAvatarURL: () => 'https://example.test/avatar.png',
        },
    };
    const harness = loadWithStateStub('../../src/lifecycle/consoleFlush', { consoleBuffer });

    try {
        const results = await harness.loaded.flush(client, webhookClient);
        assert.equal(results.length, harness.loaded._internal.MAX_CHUNKS_PER_FLUSH);
        assert.equal(sends, 3);
        assert.equal(maxInFlight, 1);
        assert.equal(consoleBuffer.text.length, 1900 * 2);
    } finally {
        harness.restore();
    }
});

test('console flush: scheduled ticks do not overlap', async () => {
    const consoleBuffer = { text: 'first' };
    let resolveSend;
    let sends = 0;
    const sendPromise = new Promise(resolve => {
        resolveSend = resolve;
    });
    const webhookClient = {
        sendSlackMessage() {
            sends++;
            return sendPromise;
        },
    };
    const client = {
        user: {
            tag: 'bot#0001',
            displayAvatarURL: () => 'https://example.test/avatar.png',
        },
    };
    const harness = loadWithStateStub('../../src/lifecycle/consoleFlush', { consoleBuffer });

    try {
        const first = harness.loaded._internal.runScheduledFlush(client, webhookClient);
        const second = harness.loaded._internal.runScheduledFlush(client, webhookClient);
        assert.equal(first, second);
        assert.equal(sends, 1);
        resolveSend();
        await first;
    } finally {
        harness.restore();
    }
});

test('console flush: start is idempotent', () => {
    const intervals = installFakeIntervals();
    const harness = loadWithStateStub('../../src/lifecycle/consoleFlush', {
        consoleBuffer: { text: '' },
    });

    try {
        const client = {};
        const webhookClient = {};
        const first = harness.loaded.start(client, webhookClient);
        const second = harness.loaded.start(client, webhookClient);

        assert.equal(first, second);
        assert.equal(intervals.timers.length, 1);
        assert.equal(intervals.timers[0].delay, 10000);
        assert.equal(intervals.timers[0].unrefCalled, true);

        harness.loaded.stop();
        assert.equal(intervals.timers[0].cleared, true);
    } finally {
        harness.loaded.stop();
        harness.restore();
        intervals.restore();
    }
});
