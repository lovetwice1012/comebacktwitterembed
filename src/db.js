'use strict';

const { TABLES } = require('./db_schema');
const { createDatabasePool } = require('./databasePool');
const { AsyncLocalStorage } = require('async_hooks');
const transactionContext = new AsyncLocalStorage();

let _config = {};
try {
    const requireFn = require;
    _config = requireFn('../config.json');
} catch {
    _config = {};
}

function getDbCredentials() {
    const dbConfig = _config.db || {};
    const legacyDbConfig = {
        host: 'localhost',
        user: 'comebacktwitterembed',
        password: 'bluebird',
        database: 'ComebackTwitterEmbed',
        charset: 'utf8mb4',
    };
    return {
        host: process.env.DB_HOST || dbConfig.host || legacyDbConfig.host,
        user: process.env.DB_USER || dbConfig.user || legacyDbConfig.user,
        password: process.env.DB_PASSWORD || dbConfig.password || legacyDbConfig.password,
        database: process.env.DB_DATABASE || dbConfig.database || legacyDbConfig.database,
        charset: process.env.DB_CHARSET || dbConfig.charset || legacyDbConfig.charset,
    };
}

let _mysql = null;
let _database = null;

function ensureDatabase() {
    if (_database) return _database;
    const cfg = getDbCredentials();
    if (!cfg.host || !cfg.user || !cfg.database) {
        throw new Error(
            'DB credentials missing. Set DB_HOST/DB_USER/DB_PASSWORD/DB_DATABASE env vars, '
            + 'add a "db" section to config.json, or configure the legacy DB fallback.'
        );
    }
    if (!_mysql) _mysql = require('mysql');
    _database = createDatabasePool({
        createPool: options => _mysql.createPool(options),
        credentials: cfg,
        onError: (error, options) => {
            if (shouldLogDatabaseError(error, options)) console.error('[database]', databaseErrorDiagnostic(error));
        },
    });
    return _database;
}

/** @type {any} */
const connection = new Proxy({}, {
    get(_target, prop) {
        const conn = ensureDatabase().pool;
        const value = conn[prop];
        return typeof value === 'function' ? value.bind(conn) : value;
    },
});

function shouldLogDatabaseError(err, options) {
    if (options?.logErrors === false) return false;
    const suppressedErrorCodes = Array.isArray(options?.suppressErrorCodes)
        ? options.suppressErrorCodes
        : [];
    return !suppressedErrorCodes.includes(err?.code);
}

function databaseErrorDiagnostic(err) {
    // mysql errors can contain the entire rendered SQL statement, including a
    // batch of prior diagnostic payloads. Never feed that batch into console
    // forwarding again. The caller still receives the original error object.
    const text = (value, limit) => value == null ? null : String(value).slice(0, limit);
    return {
        name: text(err?.name, 128),
        code: text(err?.code, 128),
        errno: Number.isFinite(err?.errno) ? err.errno : null,
        sqlState: text(err?.sqlState, 16),
        message: text(err?.sqlMessage || err?.message || err, 4096),
        stack: text(err?.stack, 8192),
    };
}

async function queryDatabase(query, params = [], options = {}) {
    const transactionQuery = transactionContext.getStore();
    if (transactionQuery) return transactionQuery(query, params, options);
    return ensureDatabase().query(query, params, options);
}

async function withDatabaseTransaction(work) {
    const transactionQuery = transactionContext.getStore();
    if (transactionQuery) return work(transactionQuery);
    return ensureDatabase().withTransaction(query => transactionContext.run(query, () => work(query)));
}

async function ensureUserExistsInDatabase(userId) {
    const userExists = await queryDatabase(
        `SELECT EXISTS (SELECT * FROM ${TABLES.users} WHERE user_id = ? LIMIT 1)`,
        [userId]
    );
    if (userExists[0][Object.keys(userExists[0])[0]] === 0) {
        await queryDatabase(
            `INSERT INTO ${TABLES.users} (user_id, registered_at_ms) VALUES (?, ?)`,
            [userId, Date.now()]
        );
    }
}

async function closeDatabaseConnection() {
    if (!_database) return;
    const database = _database;
    _database = null;
    await database.close();
}

module.exports = {
    connection,
    queryDatabase,
    withDatabaseTransaction,
    ensureUserExistsInDatabase,
    getDbCredentials,
    closeDatabaseConnection,
    _internal: { shouldLogDatabaseError, databaseErrorDiagnostic },
};
