'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const telemetry = require('./telemetry');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const registryDir = () => path.resolve(process.env.ADMIN_QUERY_REGISTRY_DIR || path.join(process.env.ADMIN_SUPPORT_DATA_DIR || path.resolve(__dirname, '../..'), 'report-queries'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function filename(queryId) {
    if (!UUID.test(queryId || '')) throw new Error('A registered query UUID is required.');
    return path.join(registryDir(), `${queryId}.json`);
}
async function writeRecord(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
}
async function withLock(file, work, waitMs = 15000) {
    const lockFile = `${file}.lock`;
    const started = Date.now();
    let handle;
    while (!handle) {
        try {
            handle = await fs.open(lockFile, 'wx', 0o600);
            await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
                let alive = true;
                try { process.kill(lock.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
                if (!alive) { await fs.unlink(lockFile).catch(() => {}); continue; }
            } catch {}
            if (Number.isFinite(waitMs) && Date.now() - started >= waitMs) throw Object.assign(new Error('The query ownership lock is busy.'), { code: 'QUERY_LOCK_BUSY' });
            await sleep(25);
        }
    }
    try { return await work(); } finally { await handle.close(); await fs.unlink(lockFile).catch(() => {}); }
}
function statementTimeout(sql) {
    const hinted = Number(String(sql).match(/MAX_EXECUTION_TIME\s*\(\s*(\d+)\s*\)/i)?.[1]);
    const configured = Number(process.env.DASHBOARD_REPORT_QUERY_TIMEOUT_MS);
    return Math.max(1000, Math.min(300000, hinted || configured || 120000));
}
async function runRegisteredQuery({ sql, values = [], connectionId, databaseUser, databaseName, query }) {
    const queryId = crypto.randomUUID();
    const file = filename(queryId);
    const marker = `/*cbte-report-query:${queryId}*/`;
    const timeoutMs = statementTimeout(sql);
    const record = { version: 1, queryId, actionId: telemetry.current()?.operation_id || null,
        ownerPid: process.pid, ownerBootId: telemetry.bootId, connectionId: String(connectionId),
        databaseUser, databaseName, marker, sql, parameterCount: values.length,
        sqlHash: crypto.createHash('sha256').update(sql).digest('hex'),
        startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + timeoutMs).toISOString(), timeoutMs, state: 'running' };
    await writeRecord(file, record);
    telemetry.event('report_query', 'started', { queryId, actionId: record.actionId, connectionId: record.connectionId, sqlHash: record.sqlHash, timeoutMs });
    let status = 'completed';
    let queryError;
    try { return await query(`${marker} ${sql}`, values); }
    catch (error) { status = 'failed'; queryError = { ...telemetry.errorData(error), databaseDetails: error.meta }; throw error; }
    finally {
        // The caller still owns its dedicated transaction/connection here.
        // Cancellation holds this same lock while checking and issuing KILL.
        // Therefore the connection cannot return to the pool between verification
        // and cancellation, even if its SELECT has just finished.
        await withLock(file, async () => {
            const latest = JSON.parse(await fs.readFile(file, 'utf8'));
            await writeRecord(file, { ...latest, state: status, completedAt: new Date().toISOString(), error: queryError });
        }, Infinity);
        telemetry.event('report_query', status, { queryId, error: queryError });
    }
}

function wrapPrismaForReports(prisma) {
    return new Proxy(prisma, {
        get(target, property) {
            if (property === '$queryRawUnsafe') return async (sql, ...values) => {
                if (typeof sql !== 'string') throw new Error('Report SQL must be a string.');
                return target.$transaction(async tx => {
                    const owner = await tx.$queryRawUnsafe('SELECT CONNECTION_ID() AS connection_id, USER() AS database_user, DATABASE() AS database_name');
                    return runRegisteredQuery({ sql, values, connectionId: owner[0].connection_id,
                        databaseUser: String(owner[0].database_user).split('@')[0], databaseName: owner[0].database_name,
                        query: (markedSql, parameters) => tx.$queryRawUnsafe(markedSql, ...parameters) });
                }, { timeout: statementTimeout(sql) + 60000, maxWait: 5000 });
            };
            if (property === '$queryRaw') return async (strings, ...values) => {
                if (!Array.isArray(strings)) throw new Error('Report raw queries require a tagged template or explicit trusted SQL.');
                return wrapPrismaForReports(target).$queryRawUnsafe(strings.join('?'), ...values);
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

async function listQueries(input = {}) {
    const entries = await fs.readdir(registryDir()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const rows = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json') || !UUID.test(entry.slice(0, -5))) continue;
        const record = JSON.parse(await fs.readFile(path.join(registryDir(), entry), 'utf8'));
        if (input.actionId && record.actionId !== input.actionId) continue;
        if (input.includeCompleted !== true && record.state !== 'running' && record.state !== 'cancel_requested') continue;
        rows.push({ ...record, overdue: record.state === 'running' && Date.parse(record.deadlineAt) < Date.now(), elapsedMs: (record.completedAt ? Date.parse(record.completedAt) : Date.now()) - Date.parse(record.startedAt) });
    }
    rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { queries: rows.slice(0, 500), truncated: rows.length > 500, checkedAt: new Date().toISOString() };
}

async function cancelQuery(input, dependencies = {}) {
    const file = filename(input.queryId);
    const dbQuery = dependencies.query || require('../db').queryDatabase;
    const decision = await withLock(file, async () => {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (record.queryId !== input.queryId || !/^\d+$/.test(record.connectionId)) throw new Error('Invalid registered query ownership.');
        if (record.state !== 'running') return { queryId: record.queryId, cancelled: false, reason: 'query_not_running', state: record.state };
        if (input.onlyIfOverdue === true && Date.parse(record.deadlineAt) >= Date.now()) return { queryId: record.queryId, cancelled: false, reason: 'query_not_overdue' };
        const processes = await dbQuery('SHOW FULL PROCESSLIST', [], { timeoutMs: 5000 });
        const match = processes.find(row => String(row.Id ?? row.id) === record.connectionId);
        const valid = match && (match.Command ?? match.command) === 'Query'
            && (match.User ?? match.user) === record.databaseUser
            && (match.db ?? match.DB) === record.databaseName
            && String(match.Info ?? match.info ?? '').startsWith(`${record.marker} `);
        if (!valid) return { queryId: record.queryId, cancelled: false, reason: 'active_statement_does_not_match_registered_owner' };
        await writeRecord(file, { ...record, state: 'cancel_requested', cancelRequestedAt: new Date().toISOString() });
        try {
            // ID came from the matching DB process row, never from a user-given
            // connection ID or arbitrary SQL. Only this report query is stopped.
            await dbQuery(`KILL QUERY ${record.connectionId}`, [], { timeoutMs: 5000 });
            const result = { queryId: record.queryId, actionId: record.actionId, cancelled: null, cancelRequested: true,
                connectionId: record.connectionId, checkedMarker: record.marker, requestedAt: new Date().toISOString() };
            await writeRecord(file, { ...record, state: 'cancel_requested', cancellation: result });
            telemetry.event('report_query', 'cancel_requested', result);
            return result;
        } catch (error) {
            await writeRecord(file, { ...record, cancellationError: telemetry.errorData(error) });
            throw error;
        }
    });
    if (!decision.cancelRequested) return decision;
    for (let attempt = 0; attempt < 20; attempt++) {
        const final = JSON.parse(await fs.readFile(file, 'utf8'));
        if (final.state === 'completed' || final.state === 'failed') {
            const confirmed = final.state === 'failed' && /ER_QUERY_INTERRUPTED|1317|query.*interrupted/i.test(JSON.stringify(final.error));
            return { ...decision, cancelled: confirmed, state: final.state,
                outcome: confirmed ? 'interruption_confirmed' : final.state === 'completed' ? 'completed_before_interruption' : 'query_failed_for_other_reason' };
        }
        await sleep(25);
    }
    return { ...decision, outcome: 'cancellation_requested_confirmation_pending' };
}

module.exports = { wrapPrismaForReports, runRegisteredQuery, listQueries, cancelQuery, registryDir };
