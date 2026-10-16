'use strict';
// Test-helper unit tests. The mysql factory is replaced only in this
// isolated Node test process; no socket or database server is used.
const test = require('node:test'), assert = require('node:assert/strict');
const mysql = require('mysql');
const { createTestDatabase } = require('../lib/automation-test-db');
const port = 33621;
const timeout = () => Object.assign(new Error('fixture connect timeout'), { code: 'ETIMEDOUT', syscall: 'connect', address: '127.0.0.1', port });
function transport(failures = []) {
    const trace = [], sql = [], diagnostics = [], connections = [];
    let acquireCount = 0, endCount = 0, poolFactories = 0, failSql = null;
    const pool = {
        getConnection(callback) {
            acquireCount++;
            const error = failures.shift();
            if (error) { trace.push('connect.error'); callback(error.error || error, error.connection); return; }
            const connection = {
                releases: 0,
                release() { this.releases++; },
                query(statement, params, done) {
                    if (typeof params === 'function') { done = params; params = []; }
                    sql.push(statement); trace.push('sql');
                    const error = failSql?.(statement);
                    queueMicrotask(() => done(error || null, error ? undefined : []));
                },
            };
            connections.push(connection); trace.push('connect.ready'); callback(null, connection);
        },
        end(done) { endCount++; done(); },
    };
    async function create(requestedPort = port) {
        const originalPool = mysql.createPool, originalWrite = process.stderr.write;
        mysql.createPool = () => { poolFactories++; return pool; };
        process.stderr.write = function(value, encoding, callback) {
            diagnostics.push(JSON.parse(String(value))); trace.push('diagnostic');
            if (typeof encoding === 'function') encoding(); else callback?.();
            return true;
        };
        try { return await createTestDatabase(requestedPort); }
        finally { mysql.createPool = originalPool; process.stderr.write = originalWrite; }
    }
    return { create, sql, trace, diagnostics, connections, pool,
        counts: () => ({ acquireCount, endCount, poolFactories }), failStatement: work => { failSql = work; } };
}

for (const failures of [1, 2]) test(`pool admission tolerates ${failures} proven loopback TCP timeout(s) before the first SQL`, async () => {
    const fixture = transport(Array.from({ length: failures }, timeout));
    const db = await fixture.create();
    try {
        assert.deepEqual(fixture.trace.slice(0, failures * 2 + 2), [...Array.from({ length: failures }, () => ['connect.error', 'diagnostic']).flat(), 'connect.ready', 'sql']);
        assert.deepEqual(fixture.diagnostics, Array.from({ length: failures }, (_, index) => ({ code: 'AUTOMATION_TEST_DB_CONNECT_RETRY', attempt: index + 2, port })));
        assert.equal(fixture.sql.filter(sql => sql.startsWith('CREATE DATABASE ')).length, 1);
    } finally { await db.close(); }
    assert.equal(fixture.counts().endCount, 1); assert.equal(fixture.connections[0].releases, 1);
});

test('three failed TCP admissions reject the exact final error and close the unopened pool', async () => {
    const errors = [timeout(), timeout(), timeout()], fixture = transport([...errors]);
    await assert.rejects(fixture.create(), error => error === errors[2]);
    assert.equal(fixture.counts().acquireCount, 3); assert.equal(fixture.counts().endCount, 1); assert.equal(fixture.sql.length, 0);
    assert.deepEqual(fixture.diagnostics.map(value => value.attempt), [2, 3]);
});

for (const [name, change] of [
    ['foreign host', { address: '192.0.2.10' }], ['different port', { port: 33622 }], ['production port', { port: 3306 }],
    ['unproven syscall', { syscall: 'read' }], ['socket ping timeout', { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }],
    ['connection refused', { code: 'ECONNREFUSED' }], ['authentication refusal', { code: 'ER_ACCESS_DENIED_ERROR' }],
    ['schema refusal', { code: 'ER_DBACCESS_DENIED_ERROR' }], ['SQL field', { sql: undefined }], ['SQL-state field', { sqlState: undefined }],
]) test(`pool admission never retries ${name}`, async () => {
    const error = Object.assign(timeout(), change), fixture = transport([error]);
    await assert.rejects(fixture.create(), actual => actual === error);
    assert.equal(fixture.counts().acquireCount, 1); assert.equal(fixture.counts().endCount, 1); assert.equal(fixture.sql.length, 0); assert.deepEqual(fixture.diagnostics, []);
});

test('the explicit non-production port guard still runs before pool creation', async () => {
    for (const invalid of [3306, 0, 65536, '33621']) {
        const fixture = transport(); await assert.rejects(fixture.create(invalid), /explicit non-production/);
        assert.equal(fixture.counts().poolFactories, 0); assert.equal(fixture.counts().acquireCount, 0);
    }
});

test('a callback that already supplies a connection is not treated as pre-handshake TCP admission', async () => {
    const error = timeout(), fixture = transport([{ error, connection: { query: () => assert.fail('No SQL may run') } }]);
    await assert.rejects(fixture.create(), actual => actual === error);
    assert.equal(fixture.counts().acquireCount, 1); assert.equal(fixture.counts().endCount, 1);
    assert.equal(fixture.sql.length, 0); assert.deepEqual(fixture.diagnostics, []);
});

for (const phase of ['query', 'work', 'commit']) test(`a connect-shaped error after admission at ${phase} is never replayed`, async () => {
    const fixture = transport(), db = await fixture.create(), error = timeout();
    const before = fixture.counts().acquireCount; let workCalls = 0;
    try {
        fixture.failStatement(statement => phase === 'query' && statement === 'TEST QUERY' || phase === 'commit' && statement === 'COMMIT' ? error : null);
        if (phase === 'query') await assert.rejects(db.queryDatabase('TEST QUERY'), actual => actual === error);
        else await assert.rejects(db.withDatabaseTransaction(async query => {
            workCalls++; await query('TEST WORK'); if (phase === 'work') throw error;
        }), actual => actual === error);
        assert.equal(fixture.counts().acquireCount, before + 1); assert.equal(workCalls, phase === 'query' ? 0 : 1);
        assert.equal(fixture.sql.filter(sql => sql === (phase === 'query' ? 'TEST QUERY' : 'TEST WORK')).length, 1);
        assert.equal(fixture.sql.filter(sql => sql === 'COMMIT').length, phase === 'commit' ? 1 : 0);
        assert.equal(fixture.sql.filter(sql => sql === 'ROLLBACK').length, phase === 'query' ? 0 : 1);
        assert.equal(fixture.connections.at(-1).releases, 1); assert.deepEqual(fixture.diagnostics, []);
    } finally { fixture.failStatement(null); await db.close(); }
    assert.equal(fixture.counts().endCount, 1);
});

test('successful transaction work and its commit run once and release their connection', async () => {
    const fixture = transport(), db = await fixture.create(); let workCalls = 0;
    try {
        assert.equal(await db.withDatabaseTransaction(async query => { workCalls++; await query('TEST SUCCESS'); return 19; }), 19);
        assert.equal(workCalls, 1); assert.equal(fixture.sql.filter(sql => sql === 'START TRANSACTION').length, 1); assert.equal(fixture.sql.filter(sql => sql === 'COMMIT').length, 1);
        assert.equal(fixture.connections.at(-1).releases, 1); assert.deepEqual(fixture.diagnostics, []);
    } finally { await db.close(); }
    assert.equal(fixture.counts().endCount, 1);
});
