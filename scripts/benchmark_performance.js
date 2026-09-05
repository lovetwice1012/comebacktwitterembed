'use strict';

// Offline only: no Bot login or database connection. Run with node --expose-gc.
process.env.NODE_ENV = 'test';
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { Client } = require('discord.js');
const { createDiscordCacheOptions } = require('../src/discordCache');
const { AsyncTtlCache } = require('../src/asyncTtlCache');

async function memoryScenario(bounded) {
    const client = new Client({ intents: [], ...(bounded ? createDiscordCacheOptions() : {}) });
    client.user = client.users._add({ id: '1', username: 'bot', discriminator: '0', bot: true });
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let sequence = 100000;
    for (let g = 0; g < 500; g++) {
        const guild = client.guilds._add({ id: String(g + 1000), name: `guild-${g}` });
        guild.members._add({ user: client.user, roles: [] });
        const channel = client.channels._add({ id: String(g + 10000), guild_id: guild.id, name: 'chat', type: 0 });
        for (let m = 0; m < 200; m++) {
            const id = String(sequence++);
            channel.messages._add({
                id, channel_id: channel.id, guild_id: guild.id,
                author: { id, username: `user-${id}`, discriminator: '0' },
                member: { roles: [], joined_at: '2026-01-01T00:00:00Z' },
                type: 0, content: `ordinary chat ${id} ` + 'x'.repeat(150),
                timestamp: '2026-09-05T00:00:00Z',
                attachments: [], embeds: [], mentions: [], mention_roles: [], components: [],
            });
        }
    }
    global.gc();
    const result = {
        addedHeapMiB: Math.round((process.memoryUsage().heapUsed - before) / 1024 / 1024 * 10) / 10,
        messages: client.channels.cache.reduce((sum, channel) => sum + (channel.messages?.cache.size || 0), 0),
        members: client.guilds.cache.reduce((sum, guild) => sum + guild.members.cache.size, 0),
        users: client.users.cache.size,
    };
    await client.destroy();
    return result;
}

function medianRuntime(fn, inputs) {
    for (let i = 0; i < 2000; i++) fn(inputs[i % inputs.length]);
    const samples = [];
    let matches = 0;
    for (let trial = 0; trial < 5; trial++) {
        const start = performance.now();
        for (let i = 0; i < 100000; i++) matches += fn(inputs[i % inputs.length]).length;
        samples.push(performance.now() - start);
    }
    return { medianMs: Math.round(samples.sort((a, b) => a - b)[2] * 10) / 10, matches };
}

async function main() {
    if (!global.gc) throw new Error('Run with node --expose-gc scripts/benchmark_performance.js');
    if (process.argv[2] === '--heap') {
        console.log(JSON.stringify(await memoryScenario(process.argv[3] === 'bounded')));
        return;
    }
    const loader = require('../src/providers/_loader');
    const providers = loader.loadProviders();
    // The regex creation and scan path before this change (main 3639c9d).
    const original = content => {
        let clean = content;
        for (const provider of providers) {
            const flags = provider.urlPattern.flags.includes('g') ? provider.urlPattern.flags : provider.urlPattern.flags + 'g';
            clean = clean.replace(provider.cleanPattern || new RegExp(`<${provider.urlPattern.source}>|\\|\\|${provider.urlPattern.source}\\|\\|`, flags), '');
        }
        return providers.flatMap(provider => clean.match(new RegExp(provider.urlPattern.source, provider.urlPattern.flags)) || []);
    };
    const optimized = content => content.includes('://') ? loader.extractAllUrls(loader.cleanContent(content)) : [];
    const plain = ['こんにちは！', '普通の会話です。'.repeat(20), 'thanks for sharing'];
    const mixed = [...Array(18).fill('普通の会話です。'.repeat(8)), 'https://x.com/u/status/12345', '<https://github.com/a/b> https://example.test/path'];
    const burstCache = new AsyncTtlCache();
    let coldLoads = 0;
    await Promise.all(Array.from({ length: 100 }, () => burstCache.getOrLoad('guild/twitter', async () => { coldLoads++; return {}; })));
    const results = {
        runtime: process.version,
        workload: '100,000 messages per timing trial; median of 5; heap: 500 guilds x 200 distinct senders',
        ordinaryMessages: { before: medianRuntime(original, plain), after: medianRuntime(optimized, plain) },
        mixedMessages: { before: medianRuntime(original, mixed), after: medianRuntime(optimized, mixed) },
        settingsBurst: { concurrentRequests: 100, databaseLoads: coldLoads },
        heap: {},
    };
    for (const mode of ['default', 'bounded']) {
        const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--heap', mode], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout);
        results.heap[mode] = JSON.parse(child.stdout);
    }
    console.log(JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
