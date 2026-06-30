'use strict';

const { TABLES } = require('./db_schema');

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
    };
    return {
        host: process.env.DB_HOST || dbConfig.host || legacyDbConfig.host,
        user: process.env.DB_USER || dbConfig.user || legacyDbConfig.user,
        password: process.env.DB_PASSWORD || dbConfig.password || legacyDbConfig.password,
        database: process.env.DB_DATABASE || dbConfig.database || legacyDbConfig.database,
    };
}

let _mysql = null;
let _connection = null;

function ensureConnection() {
    if (_connection) return _connection;
    const cfg = getDbCredentials();
    if (!cfg.host || !cfg.user || !cfg.database) {
        throw new Error(
            'DB credentials missing. Set DB_HOST/DB_USER/DB_PASSWORD/DB_DATABASE env vars, '
            + 'add a "db" section to config.json, or configure the legacy DB fallback.'
        );
    }
    if (!_mysql) _mysql = require('mysql');
    _connection = _mysql.createConnection(cfg);
    return _connection;
}

/** @type {any} */
const connection = new Proxy({}, {
    get(_target, prop) {
        const conn = ensureConnection();
        const value = conn[prop];
        return typeof value === 'function' ? value.bind(conn) : value;
    },
});

async function queryDatabase(query, params = []) {
    return new Promise((resolve, reject) => {
        ensureConnection().query(query, params, (err, results) => {
            if (err) {
                console.error(err);
                reject(err);
                return;
            }
            resolve(results);
        });
    });
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
    if (!_connection) return;
    const conn = _connection;
    _connection = null;
    await new Promise((resolve, reject) => {
        conn.end((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

module.exports = { connection, queryDatabase, ensureUserExistsInDatabase, getDbCredentials, closeDatabaseConnection };
