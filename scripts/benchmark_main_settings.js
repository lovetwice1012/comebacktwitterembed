'use strict';

// Synthetic, offline benchmark. No MySQL connection, Bot login, or file writes.
// Run: node scripts/benchmark_main_settings.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { TABLES } = require('../src/db_schema');
const { button_disabled_template, button_invisible_template } = require('../src/utils');
const outputVisibility = require('../src/providers/_output_visibility');
const { AsyncTtlCache } = require('../src/asyncTtlCache');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_PATH = path.join(ROOT, 'src/providers/_provider_settings.js');
const BEFORE_REVISION = 'b444f58a3a428ddef37a6e34ad5419705ce950d8';
const TARGET_TABLES = {
    disable: TABLES.guildProviderDisableTargets,
    sensitive_content_allowed_targets: TABLES.guildProviderSensitiveContentAllowedTargets,
    sensitive_content_excluded_targets: TABLES.guildProviderSensitiveContentExcludedTargets,
    pixiv_r18_sensitive_content_allowed_targets: TABLES.guildProviderPixivR18SensitiveContentAllowedTargets,
    pixiv_r18_sensitive_content_excluded_targets: TABLES.guildProviderPixivR18SensitiveContentExcludedTargets,
    pixiv_r18g_sensitive_content_allowed_targets: TABLES.guildProviderPixivR18gSensitiveContentAllowedTargets,
    pixiv_r18g_sensitive_content_excluded_targets: TABLES.guildProviderPixivR18gSensitiveContentExcludedTargets,
    button_disabled: TABLES.guildProviderButtonDisabledTargets,
};

function compileSettings(source, queryDatabase, options = {}) {
    const compiled = { exports: {} };
    const dependencies = {
        '../db_schema': { TABLES, ensureDatabaseSchema: async () => {} },
        '../utils': { button_disabled_template, button_invisible_template },
        './_output_visibility': outputVisibility,
        '../asyncTtlCache': { AsyncTtlCache },
        '../db': { queryDatabase, withDatabaseTransaction: async work => work(queryDatabase) },
        '../adminSupport/telemetry': { current: () => null, event: () => {} },
    };
    const injectedRequire = name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
        return dependencies[name];
    };
    // Compile complete sources independently without replacing require.cache or
    // NODE_ENV. Production SQL, normalization and cache code run unchanged.
    vm.compileFunction(source, ['require', 'module', 'exports', 'process', 'Date'], {
        filename: SETTINGS_PATH,
    })(injectedRequire, compiled, compiled.exports, { env: { NODE_ENV: 'production' } }, options.Date || Date);
    return compiled.exports;
}

function createFixtureDatabase(mode = 'populated') {
    assert.ok(['populated', 'empty'].includes(mode));
    const scopes = new Map();
    const queries = [];
    const invalidations = [];
    const auditRows = [];
    const tableKeys = new Map(Object.entries(TARGET_TABLES).map(([key, table]) => [table, key]));
    function scope(providerId, guildId) {
        const id = JSON.stringify([providerId, guildId]);
        if (!scopes.has(id)) {
            const targets = {};
            for (const key of Object.keys(TARGET_TABLES)) {
                const prefix = `${providerId}/${guildId}/${key}`;
                targets[key] = mode === 'empty' ? [] : [
                    { target_type: 'role', target_id: `${prefix}/role` },
                    { target_type: 'user', target_id: `${prefix}/user` },
                    { target_type: 'channel', target_id: `${prefix}/channel` },
                    { target_type: 'user', target_id: `${prefix}/user` },
                    { target_type: 'unknown', target_id: 'ignored' },
                ];
            }
            scopes.set(id, {
                scalar: mode === 'empty' ? null : {
                    enabled: 1, default_language: 'en', passive_mode: 0, quote_repost_max_depth: '3',
                    quote_repost_depth_by_account: '{" @Alice ":"2","bob":0,"invalid!":1,"negative":-1}',
                    hidden_output_items: '[" media ","media","","title"]',
                },
                targets,
                words: mode === 'empty' ? [] : [{ word: 'alpha' }, { word: 'beta' }],
                visibility: mode === 'empty' ? [] : [
                    { button_key: 'translate', hidden: 1 }, { button_key: 'delete', hidden: 0 },
                    { button_key: 'savetweet', hidden: true },
                ],
            });
        }
        return scopes.get(id);
    }

    function read(sql, params) {
        if (sql.includes('MAX(revision)')) return [{ revision: invalidations.at(-1)?.revision || 0 }];
        if (sql.includes(`FROM ${TABLES.providerSettingsCacheInvalidations}`)) {
            return invalidations.filter(row => row.revision > params[0]);
        }
        const table = /\bFROM\s+(\w+)/i.exec(sql)?.[1];
        if (sql.includes('AS setting_key')) {
            const branches = sql.split(/\s+UNION ALL\s+/i);
            assert.equal(params.length, branches.length * 3);
            return branches.flatMap((branch, index) => {
                assert.match(branch, /SELECT \? AS setting_key, target_type, target_id\s+FROM \w+ WHERE provider_id = \? AND guild_id = \?/i);
                const [key, providerId, guildId] = params.slice(index * 3, index * 3 + 3);
                const branchTable = /\bFROM\s+(\w+)/i.exec(branch)[1];
                assert.equal(tableKeys.get(branchTable), key, 'UNION tag must identify its source table');
                return scope(providerId, guildId).targets[key].map(row => ({ ...row, setting_key: key }));
            });
        }
        assert.equal(params.length, 2, 'Every scoped SELECT must bind provider and guild');
        const fixture = scope(...params);
        if (tableKeys.has(table)) return fixture.targets[tableKeys.get(table)].map(row => ({ ...row }));
        if (table === TABLES.guildProviderBannedWords) return fixture.words.map(row => ({ ...row }));
        if (table === TABLES.guildProviderButtonVisibility) return fixture.visibility.map(row => ({ ...row }));
        if (table === TABLES.guildProviderSettings) {
            if (sql.includes('FOR UPDATE')) return [{ guild_id: params[1] }];
            const scalarKey = /SELECT\s+(\w+)\s+AS value/i.exec(sql)?.[1];
            return fixture.scalar ? [scalarKey ? { value: fixture.scalar[scalarKey] } : { ...fixture.scalar }] : [];
        }
        throw new Error(`Unsupported synthetic SELECT: ${sql}`);
    }

    const database = { queries, invalidations, auditRows, scope, beforeQuery: null };
    database.queryDatabase = async (sql, params = []) => {
        queries.push({ sql, params: [...params] });
        if (database.beforeQuery) await database.beforeQuery(sql, params);
        if (/^\s*SELECT/i.test(sql)) return read(sql, params);
        if (sql.includes(`INSERT INTO ${TABLES.providerSettingsCacheInvalidations}`)) {
            invalidations.push({ revision: invalidations.length + 1, provider_id: params[0], guild_id: params[1] });
        } else if (sql.includes(`INSERT INTO ${TABLES.dashboardAuditLogs}`)) {
            auditRows.push([...params]);
        } else if (sql.includes(`INSERT INTO ${TABLES.guildProviderSettings}`)) {
            assert.match(sql, /\(provider_id, guild_id, enabled\)/);
            const fixture = scope(params[0], params[1]);
            fixture.scalar = { ...fixture.scalar, enabled: params[2] };
        } else {
            const insert = /^INSERT(?: IGNORE)? INTO (\w+)\s*\(/.exec(sql);
            assert.ok(insert && [TABLES.providers, TABLES.guilds, TABLES.guildProviderSettings].includes(insert[1]),
                `Unsupported synthetic write: ${sql}`);
        }
        return { affectedRows: 1 };
    };
    return database;
}

function createSyntheticPool(execute, limit = 4, serviceDelayMs = 1) {
    let active = 0;
    let peakActive = 0;
    let peakPending = 0;
    let queryCount = 0;
    const pending = [];
    function pump() {
        while (active < limit && pending.length) {
            const job = pending.shift();
            active++;
            peakActive = Math.max(peakActive, active);
            setTimeout(async () => {
                try { job.resolve(await execute(job.sql, job.params)); }
                catch (error) { job.reject(error); }
                finally { active--; pump(); }
            }, serviceDelayMs);
        }
    }
    return {
        query(sql, params) {
            queryCount++;
            return new Promise((resolve, reject) => {
                pending.push({ sql, params, resolve, reject });
                pump();
                peakPending = Math.max(peakPending, pending.length);
            });
        },
        snapshot: () => ({ queryCount, active, pending: pending.length, peakActive, peakPending }),
    };
}

async function runTrial(source, mode, workload) {
    const database = createFixtureDatabase(mode);
    const pool = createSyntheticPool(database.queryDatabase, workload.poolSize, workload.serviceDelayMs);
    const settings = compileSettings(source, pool.query);
    const values = new Array(workload.guildLoads);
    const latencies = new Array(workload.guildLoads);
    // Prebuild deterministic fixture rows outside the timed interval.
    const providers = ['twitter', 'pixiv', 'youtube'];
    for (let i = 0; i < values.length; i++) database.scope(providers[i % providers.length], `guild-${i}`);
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: workload.loadConcurrency }, async () => {
        while (next < values.length) {
            const i = next++;
            const start = performance.now();
            values[i] = await settings._internal.loadProviderSettings({ id: providers[i % providers.length], enabledByDefault: true }, `guild-${i}`);
            latencies[i] = performance.now() - start;
        }
    }));
    const elapsedMs = performance.now() - started;
    const stats = pool.snapshot();
    assert.equal(stats.active, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.peakActive, workload.poolSize);
    latencies.sort((a, b) => a - b);
    return { values, sample: { elapsedMs, p95LoadMs: latencies[Math.ceil(latencies.length * 0.95) - 1], ...stats } };
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Math.round(value * 1000) / 1000;
const hash = source => createHash('sha256').update(source).digest('hex');

async function main() {
    const before = execFileSync('git', ['show', `${BEFORE_REVISION}:src/providers/_provider_settings.js`], { cwd: ROOT, encoding: 'utf8' });
    const after = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const workload = { poolSize: 4, serviceDelayMs: 1, guildLoads: 100, loadConcurrency: 32, trials: 5, warmupTrials: 1 };
    const output = {
        benchmark: 'Bot main runtime production loadProviderSettings; SYNTHETIC, NO LIVE DATABASE',
        runtime: process.version, platform: `${process.platform}/${process.arch}`,
        beforeRevision: BEFORE_REVISION, sourceSha256: { before: hash(before), after: hash(after) },
        workload,
        limitations: 'FIFO synthetic pool; fixed 1ms timer service per SQL call including UNION. Excludes MySQL execution plans, network, schema initialization, cache hits/invalidation polling, Discord and provider HTTP. Timers depend on host scheduling; not a production latency claim.',
        cases: {},
    };
    for (const mode of ['populated', 'empty']) {
        const samples = { before: [], after: [] };
        for (let trial = -workload.warmupTrials; trial < workload.trials; trial++) {
            const pair = {};
            for (const variant of trial % 2 === 0 ? ['after', 'before'] : ['before', 'after']) {
                pair[variant] = await runTrial(variant === 'before' ? before : after, mode, workload);
                assert.equal(pair[variant].sample.queryCount, workload.guildLoads * (variant === 'before' ? 11 : 4));
                if (trial >= 0) samples[variant].push(pair[variant].sample);
            }
            assert.deepEqual(pair.after.values, pair.before.values, `${mode}: before/after settings must be identical`);
        }
        const summarize = rows => ({
            medianMs: round(median(rows.map(row => row.elapsedMs))),
            medianP95LoadMs: round(median(rows.map(row => row.p95LoadMs))),
            queriesPerTrial: rows.map(row => row.queryCount),
            samples: rows.map(row => ({ ...row, elapsedMs: round(row.elapsedMs), p95LoadMs: round(row.p95LoadMs) })),
        });
        const beforeMs = median(samples.before.map(row => row.elapsedMs));
        const afterMs = median(samples.after.map(row => row.elapsedMs));
        output.cases[mode] = {
            valuesIdentical: true, comparedLoads: workload.guildLoads * (workload.trials + workload.warmupTrials),
            before: summarize(samples.before), after: summarize(samples.after),
            speedup: round(beforeMs / afterMs), elapsedReductionPercent: round((1 - afterMs / beforeMs) * 100),
        };
    }
    console.log(JSON.stringify(output, null, 2));
}

module.exports = { SETTINGS_PATH, TARGET_TABLES, compileSettings, createFixtureDatabase };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
