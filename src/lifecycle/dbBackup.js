'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { getDbCredentials } = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DUMP_HOUR = 3;
const DEFAULT_DUMP_MINUTE = 0;
const DEFAULT_DUMP_DIR = path.join(__dirname, '..', '..', 'data', 'db_dumps');
const MAX_STDERR_LENGTH = 12000;
const pipelineAsync = promisify(pipeline);

let timer = null;
let dumpInProgress = false;

function envFlag(name) {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase());
}

function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function sanitizeFilePart(value) {
    return String(value || 'database').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function timestampForFile(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join('-') + '_' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('-');
}

function msUntilNextDailyRun(now = new Date()) {
    const hour = Math.min(23, Math.max(0, numberFromEnv('DB_DUMP_HOUR', DEFAULT_DUMP_HOUR)));
    const minute = Math.min(59, Math.max(0, numberFromEnv('DB_DUMP_MINUTE', DEFAULT_DUMP_MINUTE)));
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setTime(next.getTime() + DAY_MS);
    return next.getTime() - now.getTime();
}

function dumpArgs(credentials) {
    const args = [
        '--single-transaction',
        '--quick',
        '--routines',
        '--events',
        '--triggers',
        `--host=${credentials.host}`,
        `--user=${credentials.user}`,
        `--default-character-set=${credentials.charset || 'utf8mb4'}`,
        credentials.database,
    ];
    if (process.env.DB_PORT) args.splice(7, 0, `--port=${process.env.DB_PORT}`);
    return args;
}

async function runDatabaseDump() {
    if (dumpInProgress) return null;
    dumpInProgress = true;

    try {
        const credentials = getDbCredentials();
        const dumpDir = process.env.DB_DUMP_DIR || DEFAULT_DUMP_DIR;
        await fsp.mkdir(dumpDir, { recursive: true });

        const fileName = `${timestampForFile()}_${sanitizeFilePart(credentials.database)}.sql.gz`;
        const outputPath = path.join(dumpDir, fileName);
        const stderrChunks = [];
        const childEnv = { ...process.env };
        if (credentials.password) childEnv.MYSQL_PWD = credentials.password;

        const child = spawn(process.env.MYSQLDUMP_BIN || 'mysqldump', dumpArgs(credentials), {
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stderr.on('data', chunk => {
            if (stderrChunks.join('').length < MAX_STDERR_LENGTH) stderrChunks.push(String(chunk));
        });

        const exitPromise = new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`mysqldump exited with code ${code}: ${stderrChunks.join('').trim()}`));
            });
        });

        await Promise.all([
            /** @type {any} */ (pipelineAsync)(child.stdout, zlib.createGzip({ level: 9 }), fs.createWriteStream(outputPath)),
            exitPromise,
        ]);

        console.log(`[dbBackup] Wrote database dump: ${outputPath}`);
        return outputPath;
    } finally {
        dumpInProgress = false;
    }
}

function scheduleNextDump() {
    const delay = msUntilNextDailyRun();
    timer = setTimeout(async () => {
        timer = null;
        try {
            await runDatabaseDump();
        } catch (err) {
            console.warn('[dbBackup] Failed to write database dump:', err?.message || err);
        } finally {
            scheduleNextDump();
        }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
}

function startDailyDbDumps() {
    if (envFlag('DB_DUMP_DISABLED')) return;
    if (timer) return;

    if (envFlag('DB_DUMP_RUN_ON_START')) {
        runDatabaseDump().catch(err => {
            console.warn('[dbBackup] Failed to write startup database dump:', err?.message || err);
        });
    }
    scheduleNextDump();
}

module.exports = {
    runDatabaseDump,
    startDailyDbDumps,
    _internal: {
        msUntilNextDailyRun,
        timestampForFile,
    },
};
