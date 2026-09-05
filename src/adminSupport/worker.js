'use strict';

const crypto = require('crypto');
const telemetry = require('./telemetry');
const { inspect } = require('./inspect');
const discord = require('./discord');
const operations = require('./operations');

const ACTIONS = [
    'capabilities', 'url.inspect', 'url.reparse', 'url.compare', 'url.test_send',
    'message.resolve', 'message.send', 'message.delete', 'text.translate',
    'settings.catalog', 'settings.get', 'settings.change', 'settings.reset', 'settings.copy',
    'autoextract.list', 'autoextract.add', 'autoextract.delete', 'autoextract.update', 'autoextract.quota',
    'saved.list', 'saved.read', 'saved.delete', 'saved.save', 'saved.quota',
    'access.list', 'access.set', 'access.delete', 'diagnostics.db', 'diagnostics.queries', 'diagnostics.query.cancel',
    'reports.build', 'provider.sources', 'provider.switch',
];
async function executeAction(request) {
    const { type, input = {} } = request;
    const actionId = request.actionId || crypto.randomUUID();
    if (!ACTIONS.includes(type)) throw Object.assign(new Error(`Unsupported support action: ${type}`), { code: 'UNSUPPORTED_ACTION' });
    if (type === 'capabilities') return { actions: ACTIONS, providers: operations.catalog(),
        runtime: { node: process.version, build: process.env.BOT_BUILD_REVISION || 'unknown', gatewayRequired: false },
        unsupportedMeasurements: ['message views', 'read receipts', 'link clicks', 'download completion at user device'] };
    if (type === 'url.inspect') return inspect(input, actionId);
    if (type === 'url.reparse') {
        if (!Array.isArray(input.httpAttempts)) throw new Error('Replay requires saved httpAttempts; network access will not be used.');
        return inspect(input, actionId, { replay: true });
    }
    if (type === 'url.compare') {
        if (!Array.isArray(input.httpAttempts)) throw new Error('Comparison requires saved httpAttempts.');
        const baseline = await inspect({ ...input, settings: input.baselineSettings || input.settings }, `${actionId}:baseline`, { replay: true });
        const candidate = await inspect({ ...input, settings: { ...(input.baselineSettings || input.settings || {}), ...(input.candidateSettings || {}) } }, `${actionId}:candidate`, { replay: true });
        return { baseline, candidate, changed: JSON.stringify(baseline.steps) !== JSON.stringify(candidate.steps) || baseline.outcome !== candidate.outcome };
    }
    if (type === 'message.resolve') return discord.resolve(input);
    if (type === 'provider.sources') return require('./providerSources').sources();
    if (type === 'provider.switch') return require('./providerSources').switchSource(input);
    if (type === 'diagnostics.queries') return require('./reportQueries').listQueries(input);
    if (type === 'diagnostics.query.cancel') return require('./reportQueries').cancelQuery(input);
    if (type === 'reports.build') return require(/** @type {string} */ ('../../dashboard/lib/admin-report-worker.cjs')).buildReport(input);
    if (type === 'text.translate') return { text: await require('../components/translate').translateText(input.text, input.target || 'ja'), target: input.target || 'ja' };
    if (type === 'message.send' || type === 'url.test_send') {
        let steps = input.steps || input.planned_outputs || input.payloads;
        let preview;
        if (input.mode === 'url' || type === 'url.test_send' && !steps) {
            preview = await inspect(input, `${actionId}:preview`);
            steps = preview.steps;
            if (!steps.length) return { outcome: 'not_sent', preview, reason: preview.reason || preview.outcome };
        }
        if (!steps) steps = [{ ...(input.payload || input), files: input.payload?.files || input.files || input.attachments }];
        return { ...await discord.send(input, actionId, steps), preview };
    }
    if (type === 'message.delete') {
        const destination = await discord.resolve(input);
        const messageId = discord.id(input.messageId, 'messageId');
        const [message, me] = await Promise.all([discord.rest(`/channels/${input.channelId}/messages/${messageId}`), discord.rest('/users/@me')]);
        if (message.data.author.id !== me.data.id) throw new Error('This operation deletes only messages created by this Bot.');
        await discord.rest(`/channels/${input.channelId}/messages/${messageId}`, { method: 'DELETE' });
        return { deleted: true, messageId, destination };
    }
    if (type.startsWith('settings.')) return operations.settingAction(type, input);
    if (type.startsWith('autoextract.')) return operations.autoextractAction(type, input);
    if (type.startsWith('saved.')) return operations.savedAction(type, input);
    if (type.startsWith('access.')) return operations.accessAction(type, input);
    if (type === 'diagnostics.db') {
        const query = require('../db').queryDatabase;
        const started = performance.now();
        const results = {};
        for (const [name, sql] of [
            ['connection', 'SELECT NOW(3) AS server_time, VERSION() AS version, CONNECTION_ID() AS connection_id'],
            ['processes', 'SHOW FULL PROCESSLIST'], ['status', "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_running','Threads_connected','Slow_queries','Aborted_connects','Innodb_row_lock_current_waits','Innodb_buffer_pool_wait_free','Uptime')"],
            ['innodb', 'SHOW ENGINE INNODB STATUS'],
        ]) {
            try { results[name] = { status: 'ok', rows: await query(sql) }; }
            catch (error) { results[name] = { status: 'failed', error: telemetry.errorData(error) }; }
        }
        return { results, durationMs: performance.now() - started, checkedAt: new Date().toISOString() };
    }
}

async function execute(request) {
    const requestWithId = { ...request, actionId: request.actionId || crypto.randomUUID() };
    const type = request.type || '';
    const input = request.input || {};
    const mutation = ['settings.change', 'settings.reset', 'settings.copy', 'autoextract.add', 'autoextract.delete', 'autoextract.update', 'access.set', 'access.delete'].includes(type)
        || type === 'autoextract.quota' && input.additionalSlots !== undefined
        || type === 'saved.quota' && input.quotaBytes !== undefined;
    if (!mutation) return executeAction(requestWithId);
    const { ensureDatabaseSchema, TABLES } = require('../db_schema');
    const db = require('../db');
    await ensureDatabaseSchema();
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ type, input })).digest('hex');
    return db.withDatabaseTransaction(async query => {
        await query(`INSERT IGNORE INTO ${TABLES.adminSupportActionReceipts} (action_id,action_type,input_hash) VALUES (?,?,?)`, [requestWithId.actionId,type,inputHash]);
        const rows = await query(`SELECT * FROM ${TABLES.adminSupportActionReceipts} WHERE action_id=? FOR UPDATE`, [requestWithId.actionId]);
        if (rows[0].input_hash !== inputHash || rows[0].action_type !== type) throw Object.assign(new Error('The action ID is already associated with different input.'), { code: 'IDEMPOTENCY_CONFLICT' });
        if (rows[0].result_json) return { ...JSON.parse(rows[0].result_json), replayedReceipt: true };
        const result = await executeAction(requestWithId);
        await query(`UPDATE ${TABLES.adminSupportActionReceipts} SET result_json=? WHERE action_id=?`, [JSON.stringify(result),requestWithId.actionId]);
        return result;
    });
}

async function main() {
    // Third-party provider logs cannot corrupt the single JSON response protocol.
    for (const name of ['log', 'info', 'warn', 'debug']) console[name] = (...args) => console.error(...args);
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 40 * 1024 * 1024) throw new Error('Worker input exceeds 40 MiB.');
    }
    const request = JSON.parse(input);
    const events = [];
    const deadline = setTimeout(() => {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: 'WORKER_DEADLINE', message: 'Support operation exceeded its deadline. External operation outcome may be unknown.' }, events }), () => process.exit(124));
    }, Math.min(request.type === 'reports.build' ? 900000 : 240000, Math.max(1000, Number(process.env.ADMIN_WORKER_DEADLINE_MS) || 110000)));
    try {
        const data = await telemetry.run({ operation_id: request.actionId, trace_id: request.actionId, trigger_type: 'admin_operation',
            preview: true, events, httpAttempts: [], guild_id: request.input?.guildId, channel_id: request.input?.channelId,
            user_id: request.input?.userId }, () => execute(request));
        const nested = data?.events || [];
        const uniqueEvents = [...new Map([...events, ...nested].map(event => [event.event_id, event])).values()];
        await new Promise(resolve => process.stdout.write(JSON.stringify({ ok: true, data, events: uniqueEvents }) + '\n', resolve));
    } catch (error) {
        await new Promise(resolve => process.stdout.write(JSON.stringify({ ok: false, error: telemetry.errorData(error), events }) + '\n', resolve));
        process.exitCode = 1;
    } finally {
        clearTimeout(deadline);
        await require('../db').closeDatabaseConnection().catch(() => {});
        // Provider caches/auxiliary timers must not retain a completed action.
        process.exit(process.exitCode || 0);
    }
}
if (require.main === module) main().catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: telemetry.errorData(error) }) + '\n');
    process.exitCode = 1;
});
module.exports = { execute, ACTIONS };
