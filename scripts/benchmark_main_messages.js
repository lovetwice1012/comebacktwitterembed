'use strict';

// Offline synthetic benchmark: production message handlers and telemetry, with
// Discord, providers and persistence stubbed. Never starts a Bot or opens a DB.
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_AGENT_TOKEN;
delete process.env.ADMIN_TELEMETRY_ENABLED;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { WorkQueue } = require('../src/workQueue');
const telemetry = require('../src/adminSupport/telemetry');

const ROOT = path.resolve(__dirname, '..');
const FILE = 'src/handlers/messageCreate.js';
const BASELINE = process.argv[2] || 'b444f58a3a428ddef37a6e34ad5419705ce950d8';
const TRIALS = 5;
const MESSAGES = 100000;
const EXCLUDED_MESSAGES = 32;
const MEMBER_DELAY_MS = 2;

function loadHandler(source, settings) {
    const counts = { contexts: 0, memberFetches: 0, extracts: 0 };
    const errors = [];
    const provider = { id: 'twitter', extract: async () => { counts.extracts++; return null; } };
    const mocks = {
        '../adminSupport/telemetry': { ...telemetry, contextFromMessage: message => {
            counts.contexts++;
            return telemetry.contextFromMessage(message);
        } },
        '../providers/_loader': { extractAllUrls: () => [{ provider, url: 'https://x.com/u/status/1' }] },
        '../providers/_provider_settings': { getProviderSettings: async () => settings },
        '../providers/_dispatcher': { runSendSteps: () => assert.fail('unexpected dispatch') },
        '../workQueue': { messageWorkQueue: new WorkQueue() },
        '../expansionTraceStore': { beginExpansionTrace: async () => {}, updateExpansionTrace: async () => {} },
        '../errorTracking': { recordMetric() {}, recordError: error => errors.push(error) },
        '../adminSupport/inspect': { hash: value => createHash('sha256').update(JSON.stringify(value)).digest('hex') },
    };
    const filename = path.join(ROOT, FILE);
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const realRequire = mod.require.bind(mod);
    mod.require = id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id);
    mod._compile(source, filename);
    const listeners = [];
    mod.exports.register({ user: { id: 'bot' }, on: (_event, listener) => listeners.push(listener) });
    const message = (id, content, bot = false) => ({
        id, content, guild: { id: 'guild', members: { fetch: async () => {
            counts.memberFetches++;
            await delay(MEMBER_DELAY_MS);
            return { roles: { cache: new Map() } };
        } } }, channel: { id: 'channel' }, author: { id: 'user', bot }, member: null,
    });
    return { handler: listeners[1], counts, errors, message };
}

function summarize(samples) {
    return { medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)], samplesMs: samples };
}

function ordinaryMessages(source) {
    const { handler, counts, errors, message } = loadHandler(source, {});
    const inputs = ['こんにちは！', '普通の会話です。'.repeat(20), 'thanks for sharing']
        .map((content, index) => message(String(index), content));
    for (let i = 0; i < 2000; i++) handler(inputs[i % inputs.length]);
    counts.contexts = 0;
    const samples = [];
    for (let trial = 0; trial < TRIALS; trial++) {
        const start = performance.now();
        for (let i = 0; i < MESSAGES; i++) {
            if (handler(inputs[i % inputs.length]) !== undefined) throw new Error('ordinary chat became async');
        }
        samples.push(performance.now() - start);
    }
    assert.deepEqual(errors, []);
    assert.equal(counts.extracts, 0);
    return { ...summarize(samples), contextsPerTrial: counts.contexts / TRIALS };
}

async function excludedMessages(source, settings, bot) {
    const samples = [], fetches = [];
    for (let trial = 0; trial < TRIALS; trial++) {
        const { handler, counts, errors, message } = loadHandler(source, settings);
        const inputs = Array.from({ length: EXCLUDED_MESSAGES }, (_, i) => message(String(i), 'https://x.com/u/status/1', bot));
        const start = performance.now();
        for (const input of inputs) await handler(input);
        samples.push(performance.now() - start);
        fetches.push(counts.memberFetches);
        assert.equal(counts.extracts, 0);
        assert.deepEqual(errors, []);
    }
    return { ...summarize(samples), memberFetchesPerTrial: fetches };
}

async function main() {
    const sources = {
        before: execFileSync('git', ['show', `${BASELINE}:${FILE}`], { cwd: ROOT, encoding: 'utf8' }),
        after: fs.readFileSync(path.join(ROOT, FILE), 'utf8'),
    };
    const results = {
        kind: 'offline synthetic; real handler/telemetry; stubbed DB/provider/Discord',
        runtime: process.version, baselineRevision: BASELINE, measuredAt: new Date().toISOString(),
        workload: { trials: TRIALS, ordinaryMessagesPerTrial: MESSAGES, warmup: 2000,
            excludedMessagesPerTrial: EXCLUDED_MESSAGES, simulatedMemberFetchMs: MEMBER_DELAY_MS },
        sourceSha256: {}, ordinaryMessages: {}, excludedMessages: {},
    };
    for (const [version, source] of Object.entries(sources)) {
        results.sourceSha256[version] = createHash('sha256').update(source).digest('hex');
        results.ordinaryMessages[version] = ordinaryMessages(source);
        results.excludedMessages[version] = {};
        for (const [scenario, settings, bot] of [
            ['providerDisabled', { enabled: false }, false],
            ['userDisabled', { enabled: true, disable: { user: ['user'] } }, false],
            ['channelDisabled', { enabled: true, disable: { channel: ['channel'] } }, false],
            ['botDisabled', { enabled: true, extract_bot_message: false }, true],
        ]) results.excludedMessages[version][scenario] = await excludedMessages(source, settings, bot);
    }
    assert.equal(results.ordinaryMessages.after.contextsPerTrial, 0);
    for (const result of Object.values(results.excludedMessages.after)) {
        assert.ok(result.memberFetchesPerTrial.every(count => count === 0));
    }
    console.log(JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
