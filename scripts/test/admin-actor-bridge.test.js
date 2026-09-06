'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const telemetry = require('../../src/adminSupport/telemetry');
const { actorFromRequest, DEFAULT_OWNER_ID } = require('../../src/adminSupport/actor');

test('both configured administrators are accepted, outsiders are rejected, and target input cannot claim actor identity', () => {
    assert.equal(actorFromRequest({ actorId: '933314562487386122', initiatedVia: 'dashboard', input: { actorId: DEFAULT_OWNER_ID } }).actorId, '933314562487386122');
    assert.equal(actorFromRequest({ actorId: DEFAULT_OWNER_ID }).actorId, DEFAULT_OWNER_ID);
    assert.equal(actorFromRequest({ input: { actorId: '933314562487386122' } }).actorId, DEFAULT_OWNER_ID);
    assert.throws(() => actorFromRequest({ actorId: '111111111111111111' }), { code: 'ADMIN_ACTOR_FORBIDDEN' });
    assert.throws(() => actorFromRequest({ actorId: 933314562487386122 }), { code: 'ADMIN_ACTOR_FORBIDDEN' });
});

test('an explicit allowlist replaces defaults and includes the configured owner', () => {
    const env = { ADMIN_ALLOWED_USER_IDS: '933314562487386122, invalid\n222222222222222222', ADMIN_OWNER_ID: DEFAULT_OWNER_ID };
    assert.equal(actorFromRequest({ actorId: '933314562487386122' }, env).actorId, '933314562487386122');
    assert.equal(actorFromRequest({}, env).actorId, DEFAULT_OWNER_ID);
    assert.equal(actorFromRequest({}, { ADMIN_ALLOWED_USER_IDS: '933314562487386122' }).actorId, DEFAULT_OWNER_ID);
    assert.equal(actorFromRequest({ actorId: '222222222222222222' }, env).actorId, '222222222222222222');
    assert.throws(() => actorFromRequest({ actorId: '933314562487386122' }, { ADMIN_ALLOWED_USER_IDS: DEFAULT_OWNER_ID }), { code: 'ADMIN_ACTOR_FORBIDDEN' });
    assert.throws(() => actorFromRequest({ initiatedVia: 'dashboard\nforged' }, env), { code: 'ADMIN_ORIGIN_INVALID' });
});

async function withReceiptFixture(work) {
    const names = ['worker', 'operations', 'inspect', 'discord'].map(name => require.resolve(`../../src/adminSupport/${name}`));
    const [workerPath, operationsPath, inspectPath, discordPath] = names;
    const dbPath = require.resolve('../../src/db');
    const schemaPath = require.resolve('../../src/db_schema');
    const saved = new Map([...names, dbPath, schemaPath].map(key => [key, require.cache[key]]));
    const receipts = new Map();
    const executions = [];
    const query = async (sql, params) => {
        if (sql.startsWith('INSERT IGNORE')) {
            if (!receipts.has(params[0])) receipts.set(params[0], { action_type: params[1], input_hash: params[2], result_json: null });
            return [];
        }
        if (sql.startsWith('SELECT')) return receipts.has(params[0]) ? [receipts.get(params[0])] : [];
        if (sql.startsWith('UPDATE')) { receipts.get(params[1]).result_json = params[0]; return []; }
        throw new Error(`Unexpected fixture query: ${sql}`);
    };
    const stub = (key, exports) => { require.cache[key] = { id: key, filename: key, loaded: true, exports }; };
    stub(dbPath, { withDatabaseTransaction: async callback => callback(query), queryDatabase: query });
    stub(schemaPath, { TABLES: { adminSupportActionReceipts: 'fixture_receipts' }, ensureDatabaseSchema: async () => {} });
    stub(inspectPath, {});
    stub(discordPath, {});
    stub(operationsPath, { settingAction: async () => {
        const context = telemetry.current();
        const result = { actorId: context.actor_id, initiatedVia: context.initiated_via, actionId: context.operation_id };
        executions.push(result);
        return result;
    } });
    delete require.cache[workerPath];
    try { await work({ execute: require(workerPath).execute, receipts, executions }); }
    finally { for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; } }
}

test('database receipts bind the trusted actor and origin and do not rerun a mutation on another administrator retry', async () => {
    await withReceiptFixture(async ({ execute, receipts, executions }) => {
        const request = { actionId: 'database-actor', type: 'settings.change', actorId: '933314562487386122', initiatedVia: 'dashboard', input: { actorId: DEFAULT_OWNER_ID } };
        const first = await execute(request);
        assert.equal(first.actorId, '933314562487386122');
        assert.equal((await execute(request)).replayedReceipt, true);
        assert.equal(executions.length, 1);
        await assert.rejects(execute({ ...request, actorId: DEFAULT_OWNER_ID }), { code: 'IDEMPOTENCY_CONFLICT' });
        await assert.rejects(execute({ ...request, initiatedVia: 'automation' }), { code: 'IDEMPOTENCY_CONFLICT' });
        assert.equal(executions.length, 1);
        const automatic = await execute({ type: 'settings.change', input: {} });
        assert.equal(automatic.actorId, DEFAULT_OWNER_ID);
        assert.equal(automatic.initiatedVia, 'automation');
        assert.equal(JSON.parse(receipts.get(automatic.actionId).result_json).actionId, automatic.actionId);
    });
});

test('pre-actor database receipts remain readable only by their original owner without executing again', async () => {
    await withReceiptFixture(async ({ execute, receipts, executions }) => {
        const request = { actionId: 'legacy-database-action', type: 'settings.change', input: { enabled: true } };
        const inputHash = crypto.createHash('sha256').update(JSON.stringify({ type: request.type, input: request.input })).digest('hex');
        receipts.set(request.actionId, { action_type: request.type, input_hash: inputHash, result_json: JSON.stringify({ legacyResult: true }) });
        await assert.rejects(execute({ ...request, actorId: '933314562487386122' }), { code: 'IDEMPOTENCY_CONFLICT' });
        assert.deepEqual(await execute(request), { legacyResult: true, replayedReceipt: true });
        assert.equal(executions.length, 0);
    });
});

test('concurrent worker actions keep independent trusted actor contexts without changing process environment', async () => {
    const operationsPath = require.resolve('../../src/adminSupport/operations');
    const workerPath = require.resolve('../../src/adminSupport/worker');
    const originalOperations = require.cache[operationsPath], originalWorker = require.cache[workerPath];
    const owner = process.env.ADMIN_OWNER_ID;
    require.cache[operationsPath] = { id: operationsPath, filename: operationsPath, loaded: true, exports: {
        settingAction: async (_type, input) => {
            const first = telemetry.current().actor_id;
            await new Promise(resolve => setTimeout(resolve, input.delay));
            return { first, last: telemetry.current().actor_id, via: telemetry.current().initiated_via };
        },
    } };
    delete require.cache[workerPath];
    try {
        const { execute } = require(workerPath);
        const values = await Promise.all([
            execute({ type: 'settings.get', actorId: DEFAULT_OWNER_ID, initiatedVia: 'automation', input: { delay: 20, actorId: '933314562487386122' } }),
            execute({ type: 'settings.get', actorId: '933314562487386122', initiatedVia: 'dashboard', input: { delay: 1, actorId: DEFAULT_OWNER_ID } }),
        ]);
        assert.deepEqual(values, [{ first: DEFAULT_OWNER_ID, last: DEFAULT_OWNER_ID, via: 'automation' }, { first: '933314562487386122', last: '933314562487386122', via: 'dashboard' }]);
        await assert.rejects(execute({ type: 'settings.get', actorId: '111111111111111111', input: {} }), { code: 'ADMIN_ACTOR_FORBIDDEN' });
        assert.equal(process.env.ADMIN_OWNER_ID, owner);
        assert.equal(telemetry.current(), undefined);
    } finally {
        if (originalOperations) require.cache[operationsPath] = originalOperations; else delete require.cache[operationsPath];
        if (originalWorker) require.cache[workerPath] = originalWorker; else delete require.cache[workerPath];
    }
});

test('shared production settings audit attributes a change to the trusted administrator rather than target user', async () => {
    const providerPath = require.resolve('../../src/providers/_provider_settings');
    const dbPath = require.resolve('../../src/db');
    const schemaPath = require.resolve('../../src/db_schema');
    const schema = require(schemaPath);
    const saved = new Map([providerPath, dbPath, schemaPath].map(key => [key, require.cache[key]]));
    const originalEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let enabled = false;
    const audits = [];
    const query = async (sql, params = []) => {
        if (sql.includes('SELECT enabled AS value')) return [{ value: enabled ? 1 : 0 }];
        if (sql.startsWith(`INSERT INTO ${schema.TABLES.guildProviderSettings}`)) enabled = Boolean(params[2]);
        if (sql.startsWith(`INSERT INTO ${schema.TABLES.dashboardAuditLogs}`)) audits.push(params);
        return [];
    };
    require.cache[schemaPath] = { id: schemaPath, filename: schemaPath, loaded: true, exports: { ...schema, ensureDatabaseSchema: async () => {} } };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { queryDatabase: query, withDatabaseTransaction: async work => work(query) } };
    delete require.cache[providerPath];
    try {
        const settings = require(providerPath);
        for (const actor of [DEFAULT_OWNER_ID, '933314562487386122']) {
            await telemetry.run({ actor_id: actor, user_id: '111111111111111111', preview: true, operation_id: 'fixture-action' }, () => settings.setSetting({ id: 'twitter', enabledByDefault: true }, 'enabled', '123456789012345678', true));
        }
        assert.deepEqual(audits.map(row => row[3]), [DEFAULT_OWNER_ID, '933314562487386122']);
        assert.ok(audits.every(row => row[7] === 'fixture-action'));
    } finally {
        if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
        for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
    }
});

test('telemetry stores the authenticated actor separately from the investigated user', () => {
    const events = [];
    telemetry.run({ actor_id: '933314562487386122', initiated_via: 'standalone', user_id: '111111111111111111', events, preview: true }, () => telemetry.event('settings', 'saved', { actorId: DEFAULT_OWNER_ID }));
    assert.equal(events[0].actorId, '933314562487386122');
    assert.equal(events[0].userId, '111111111111111111');
    assert.equal(events[0].initiatedVia, 'standalone');
});
