'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { fetchIsolated, _internal } = require('../../src/providers/autoWatch/isolatedFetch');
const { requestText, requestJson } = require('../../src/providers/autoWatch/_shared');
const { enforceCgroup, limitUnitSwap } = require('../../src/providers/autoWatch/isolation_linux');
const { isPublicAddress } = require('../../src/providers/autoWatch/publicDns');

const source = { provider_id: 'youtube', source_key: 'channel:UC-KCywVYbtCJlsmdcsvwU8g', state_json: '{}' };
const context = fetch => ({ fetch, config: { timeoutMs: 20000 } });
const response = (status, location) => ({ status, ok: status === 200,
    headers: { get: key => key === 'location' ? location : null }, text: async () => 'provider data' });

test('acquisition sandbox has independent OS memory, CPU, lifetime and process limits', () => {
    const spec = _internal.commandFor('linux', 70000);
    assert.equal(spec.command, '/usr/bin/systemd-run');
    for (const property of ['MemoryMax=536870912', 'MemorySwapMax=0', 'CPUQuota=100%', 'TasksMax=32',
        'RuntimeMaxSec=75', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'KillMode=control-group']) assert(spec.args.includes(property));
    assert(spec.args.includes('IPAddressDeny=127.0.0.0/8'));
    assert(spec.args.includes('IPAddressDeny=169.254.0.0/16'));
    const windows = _internal.commandFor('win32', 70000);
    assert(windows.args[0].endsWith('isolation_windows.py'));
    assert.equal(windows.args[1], String(_internal.MEMORY_BYTES));
    assert.throws(() => _internal.commandFor('unsupported', 70000), { code: 'AUTO_WATCH_ISOLATION_UNAVAILABLE' });
});

function fakeSpawn(output, code = 0) {
    return () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => {};
        child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
            queueMicrotask(() => { child.stdout.end(output); child.emit('close', code); }); done();
        } });
        queueMicrotask(() => child.stdout.write('READY\n'));
        return child;
    };
}

test('only a successful isolated observation is returned to the Bot', async () => {
    const result = { items: [], state: { channelId: 'verified' } };
    assert.deepEqual(await fetchIsolated(source, { timeoutMs: 20000 }, {
        platform: 'win32', spawn: fakeSpawn(JSON.stringify({ result })),
    }), result);
    await assert.rejects(fetchIsolated(source, { timeoutMs: 20000 }, {
        platform: 'win32', spawn: fakeSpawn('', 137),
    }), error => error.code === 'AUTO_WATCH_RESOURCE_BUSY' && error.retryAfterMs === 300000);
    await assert.rejects(fetchIsolated(source, { timeoutMs: 20000 }, {
        platform: 'win32', spawn: fakeSpawn(JSON.stringify({ error: { code: 'AUTO_WATCH_RATE_LIMITED', status: 429, retryAfterMs: 120000 } })),
    }), error => error.code === 'AUTO_WATCH_RATE_LIMITED' && error.status === 429 && error.retryAfterMs === 120000);
});

test('legacy Linux cgroups constrain total RAM plus swap before fetching', () => {
    const files = new Map([
        ['/proc/self/cgroup', '6:memory:/system.slice/cbte-watch-fetch-abc.service\n0::/system.slice/cbte-watch-fetch-abc.service'],
        ['/proc/self/limits', 'Max address space         2147483648           2147483648           bytes'],
        ['/sys/fs/cgroup/memory/system.slice/cbte-watch-fetch-abc.service/memory.limit_in_bytes', '536870912'],
        ['/sys/fs/cgroup/memory/system.slice/cbte-watch-fetch-abc.service/memory.memsw.limit_in_bytes', '9223372036854771712'],
    ]);
    const io = { existsSync: name => files.has(name), readFileSync: name => files.get(name), writeFileSync: (name, value) => files.set(name, value) };
    assert.throws(() => enforceCgroup(_internal.MEMORY_BYTES, io), /swap protection/);
    limitUnitSwap('cbte-watch-fetch-abc', _internal.MEMORY_BYTES, io);
    assert.deepEqual(enforceCgroup(_internal.MEMORY_BYTES, io), { ramBytes: _internal.MEMORY_BYTES, totalBytes: _internal.MEMORY_BYTES, swapBytes: null });
    assert.equal([...files.values()].at(-1), '536870912');
    files.set('/proc/self/cgroup', '6:memory:/system.slice/cbte.service');
    assert.throws(() => enforceCgroup(_internal.MEMORY_BYTES, io), /dedicated cgroup/);
});

test('provider redirects stay within HTTPS provider hosts; unsafe targets are rejected before fetching', async () => {
    for (const location of ['http://www.youtube.com/feed', 'https://127.0.0.1/secret', 'https://169.254.169.254/',
        'https://www.youtube.com.attacker.test/', 'https://api.github.com/users/other', 'https://user:pass@www.youtube.com/', 'https://www.youtube.com:444/']) {
        let calls = 0;
        await assert.rejects(requestText(context(async () => { calls++; return response(302, location); }), 'https://www.youtube.com/feed'),
            { code: 'AUTO_WATCH_INVALID_REDIRECT' });
        assert.equal(calls, 1);
    }
    const urls = [];
    assert.equal((await requestText(context(async (url, options) => {
        urls.push(url); assert.equal(options.redirect, 'manual');
        return urls.length === 1 ? response(302, '/public-feed') : response(200);
    }), 'https://www.youtube.com/feed')).body, 'provider data');
    assert.deepEqual(urls, ['https://www.youtube.com/feed', 'https://www.youtube.com/public-feed']);
});

test('rate limits and upstream error pages never need to buffer their bodies', async () => {
    for (const status of [429, 404, 503]) {
        const errorResponse = response(status);
        errorResponse.text = async () => { throw new Error('Error page was buffered'); };
        await assert.rejects(requestText(context(async () => errorResponse), 'https://www.youtube.com/feed'),
            error => error.status === status);
    }
});

test('streamed JSON rate-limit errors preserve body-based quota classification and retry hints', async () => {
    for (const status of [403, 429]) {
        const upstream = response(status);
        upstream.text = async () => JSON.stringify({ message: 'API rate limit exceeded', retry_after: 120000 });
        await assert.rejects(requestJson(context(async () => upstream), 'https://api.github.com/users/example'),
            error => error.code === 'AUTO_WATCH_RATE_LIMITED' && error.retryAfterMs === 120000);
    }
});

test('DNS socket destinations reject private, metadata, mapped IPv4 and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
        '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1']) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '142.250.196.110', '2607:f8b0:4007:80d::200e', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
});

test('source leases cover the largest supported isolated acquisition deadline', () => {
    const { sourceLeaseMs } = require('../../src/providers/autoWatch/store')._internal;
    assert.equal(sourceLeaseMs({ timeoutMs: 20000 }), 130000);
    assert(sourceLeaseMs({ timeoutMs: 120000 }) > 120000 * 5 + 20000);
});

test('the production-default tick isolates acquisition and passes its HTTP deadline to source claims', async () => {
    const { readFileSync } = require('node:fs');
    const { dirname } = require('node:path');
    const { createRequire } = require('node:module');
    const { compileFunction } = require('node:vm');
    const filename = require.resolve('../../src/providers/autoWatch/runner');
    const localRequire = createRequire(filename);
    const index = localRequire('./index');
    const now = 1000000, claims = [], reservations = [], acquisitions = [], completions = [];
    const config = index.monitorConfig({ timeoutMs: 120000 });
    const dueSource = { ...source, id: 'production-source', cursor_json: null, initialized_at_ms: 0 };
    const policy = { globalSpacingMs: 5000 };
    const storeDefault = {
        activeSourceCounts: async () => new Map([['youtube', 1]]),
        claimDueSources: async (...args) => {
            claims.push(args);
            return claims.length === 1 ? [dueSource] : [];
        },
        claimDueDeliveries: async () => [],
        computedPollInterval: (_source, count, configured) => {
            assert.equal(count, 1);
            assert.deepEqual(configured, config);
            return 300000;
        },
        policyFor: (providerId, configured) => {
            assert.equal(providerId, 'youtube');
            assert.deepEqual(configured, config);
            return policy;
        },
        reserveProviderRequest: async (...args) => { reservations.push(args); return { allowed: true }; },
        recordProviderRateLimit: async () => {},
        completeSource: async (...args) => { completions.push(args); },
        failSource: async () => assert.fail('Production acquisition unexpectedly failed'),
    };
    const module = { exports: {} };
    const injectedRequire = name => {
        if (name === './store') return storeDefault;
        if (name === './index') return { ...index, fetchSource: async (...args) => {
            acquisitions.push(args);
            return { items: [], state: {} };
        } };
        return localRequire(name);
    };
    compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'], { filename })(
        module.exports, injectedRequire, module, filename, dirname(filename));

    // Keep the same default store/fetch selection as the resident scheduler.
    const result = await module.exports.tick({ now, config, sourceLimit: 2, deliveryLimit: 1 });
    assert.equal(result.sources[0].status, 'seeded');
    assert.deepEqual(claims, [[now, 1, config], [now, 1, config]]);
    assert.deepEqual(reservations, [['youtube', policy, now]]);
    assert.equal(acquisitions.length, 1);
    assert.equal(acquisitions[0][1].isolate, true);
    assert.equal(typeof acquisitions[0][1].fetch, 'function');
    assert.deepEqual(acquisitions[0][1].config, config);
    assert.equal(completions.length, 1);
    assert.equal(completions[0][1].initializedAtMs, now);
});
