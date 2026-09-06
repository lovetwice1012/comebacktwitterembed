'use strict';

// A candidate-scoped quarantine for outgoing work restored from an older backup.
// The restored source rows/files remain unchanged; quarantines are not delivery
// receipts and never claim that a notification was sent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 4 * 1024 * 1024;
let cached;
let initializing;

function failure(message) {
    return Object.assign(new Error(message), { code: 'RECOVERY_BOOTSTRAP_REQUIRED' });
}
function configuration() {
    const id = process.env.CBTE_RECOVERY_BOOTSTRAP_ID;
    const directory = process.env.CBTE_RECOVERY_BOOTSTRAP_DIR;
    if (!id && !directory) return null;
    if (!/^[a-f0-9]{24}$/.test(id || '') || process.env.CBTE_FLEET_NODE !== 'oci'
        || !directory || !path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) {
        throw failure('Recovery bootstrap requires an OCI candidate ID and an absolute private state directory.');
    }
    return { id, directory: path.resolve(directory) };
}
function plain(filename) {
    let current = path.resolve(filename);
    for (;;) {
        const info = fs.lstatSync(current);
        if (info.isSymbolicLink()) throw failure('Recovery bootstrap paths must not contain symbolic links.');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}
function read(filename) {
    plain(filename);
    if (fs.statSync(filename).size > MAX_BYTES) throw failure('Recovery bootstrap evidence exceeds its size limit.');
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function write(filename, value) {
    const bytes = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw failure('Recovery bootstrap evidence exceeds its size limit.');
    plain(path.dirname(filename));
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    try {
        fs.renameSync(temporary, filename);
        if (process.platform !== 'win32') {
            const directory = fs.openSync(path.dirname(filename), 'r');
            try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function save(state) { write(path.join(state.directory, 'bootstrap.json'), state); }
function begin() {
    const config = configuration();
    if (!config) return null;
    if (cached) {
        if (cached.candidateId !== config.id || cached.directory !== config.directory) throw failure('Recovery candidate changed inside a running Bot.');
        return cached;
    }
    fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    plain(config.directory);
    const filename = path.join(config.directory, 'bootstrap.json');
    if (fs.existsSync(filename)) {
        cached = read(filename);
        if (cached.version !== 1 || cached.candidateId !== config.id || cached.directory !== config.directory
            || !Number.isSafeInteger(cached.startedAtMs) || cached.startedAtMs < 1
            || typeof cached.complete !== 'boolean' || !cached.tables || typeof cached.tables !== 'object' || Array.isArray(cached.tables)
            || cached.complete && ['autoextract_targets', 'deregister_pending', 'error_incidents'].some(kind => cached.tables[kind]?.complete !== true)) {
            cached = null;
            throw failure('Recovery bootstrap state does not match this candidate.');
        }
    } else {
        if (fs.readdirSync(config.directory).some(name => !name.endsWith('.tmp'))) throw failure('Unmarked recovery bootstrap state will not be reused.');
        const initial = { version: 1, candidateId: config.id, directory: config.directory, startedAtMs: Date.now(), tables: {}, complete: false,
            feedPolling: 'No autoextract feed poller is present or started by this Bot release. Restored target cursors are preserved for investigation.' };
        save(initial);
        cached = initial;
    }
    fs.mkdirSync(path.join(config.directory, 'quarantine'), { mode: 0o700, recursive: true });
    plain(path.join(config.directory, 'quarantine'));
    return cached;
}
function quarantine(kind, key, record) {
    const state = begin();
    if (!state) return;
    const digest = crypto.createHash('sha256').update(`${kind}:${key}`).digest('hex');
    const filename = path.join(state.directory, 'quarantine', `${digest}.json`);
    if (fs.existsSync(filename)) {
        const existing = read(filename);
        if (existing.candidateId !== state.candidateId || existing.kind !== kind || existing.key !== String(key)) throw failure('Recovery quarantine identity mismatch.');
        return;
    }
    write(filename, { version: 1, candidateId: state.candidateId, kind, key: String(key), quarantinedAt: new Date().toISOString(),
        reason: 'Pre-recovery or undated outgoing work must not be replayed from a backup.', original: record, delivered: false });
}
function notificationAllowed(kind, record, registeredAt) {
    const state = begin();
    if (!state) return true;
    const created = typeof registeredAt === 'number' ? registeredAt : Date.parse(registeredAt);
    if (Number.isFinite(created) && created > state.startedAtMs) return true;
    quarantine(kind, record.id ?? record.notification_id ?? crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex'), record);
    return false;
}
function incidentAllowed(incident) {
    const state = begin();
    return !state || Number.isFinite(incident.detectedAtMs) && incident.detectedAtMs > state.startedAtMs;
}
function currentWindowStart(startMs) {
    const state = begin();
    // Metric buckets are minute aggregates. Exclude the partial restoration
    // minute as well, which can contain counts copied from the old primary.
    return state ? Math.max(startMs, Math.ceil(state.startedAtMs / 60000) * 60000) : startMs;
}
async function initialize(options = {}) {
    const state = begin();
    if (!state || state.complete) return state;
    if (initializing) return initializing;
    initializing = (async () => {
        const query = options.query || require('./db').queryDatabase;
        const tables = options.tables || require('./db_schema').TABLES;
        const subscriptions = options.subscriptions || require('./providers/booth/_notifications');
        const deadline = Date.now() + 60000;
        const sources = [
            ['autoextract_targets', tables.autoExtractTargets, 'id', 'created_at_ms <= ?', [state.startedAtMs]],
            ['deregister_pending', tables.deregisterNotifications, 'notification_id', 'dm_sent = 0 AND created_at_ms <= ?', [state.startedAtMs]],
            ['error_incidents', tables.botErrorAlerts, 'alert_key', 'active = 1', []],
        ];
        for (const [kind, table, key, predicate, params] of sources) {
            let progress = state.tables[kind] || { cursor: key === 'alert_key' ? '' : '0', pages: 0, rows: 0, complete: false };
            while (!progress.complete) {
                if (Date.now() >= deadline || progress.pages >= 500) throw failure('Recovery quarantine scan exceeded its bounded startup budget. Background notifications remain stopped.');
                const rows = await query(`SELECT * FROM ${table} WHERE ${predicate} AND ${key} > ? ORDER BY ${key} LIMIT 200`, [...params, progress.cursor], { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) });
                if (!Array.isArray(rows) || rows.length > 200) throw failure('Recovery quarantine scan returned invalid rows.');
                if (rows.length) {
                    quarantine(kind, `page:${progress.cursor}`, { rows });
                    const cursor = String(rows[rows.length - 1][key]);
                    if (cursor === progress.cursor || cursor === 'undefined') throw failure('Recovery quarantine scan did not advance.');
                    progress = { cursor, pages: progress.pages + 1, rows: progress.rows + rows.length, complete: rows.length < 200 };
                } else progress = { ...progress, complete: true };
                state.tables[kind] = progress;
                save(state);
            }
        }
        if (subscriptions.FILE && fs.existsSync(subscriptions.FILE)) {
            plain(subscriptions.FILE);
            if (fs.statSync(subscriptions.FILE).size > MAX_BYTES) throw failure('Restored Booth subscriptions exceed the bounded bootstrap size.');
        }
        const records = subscriptions.load();
        if (!Array.isArray(records) || records.length > 10000) throw failure('Restored Booth subscriptions exceed the bounded bootstrap count.');
        for (const record of records) {
            if (Date.now() >= deadline) throw failure('Recovery notification quarantine exceeded its startup budget. Background notifications remain stopped.');
            if (!record.notified) notificationAllowed('booth_sale', record, record.registeredAt);
        }
        const completed = { ...state, complete: true, completedAtMs: Date.now() };
        save(completed);
        Object.assign(state, completed);
        return state;
    })();
    try { return await initializing; } finally { initializing = null; }
}

module.exports = { begin, initialize, quarantine, notificationAllowed, incidentAllowed, currentWindowStart };
