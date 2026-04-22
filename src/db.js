'use strict';

// MySQL 接続。資格情報は環境変数 (DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE)
// または config.json の "db" セクションから読み取る。env が優先。
// mysql モジュール本体と接続は最初の使用時まで遅延ロードされる。

let _config = {};
try {
    _config = require('../config.json');
} catch {
    // config.json が無くても起動はできる (env のみで動かす想定)
}

function getDbCredentials() {
    const dbConfig = _config.db || {};
    return {
        host: process.env.DB_HOST || dbConfig.host,
        user: process.env.DB_USER || dbConfig.user,
        password: process.env.DB_PASSWORD || dbConfig.password,
        database: process.env.DB_DATABASE || dbConfig.database,
    };
}

let _mysql = null;
let _connection = null;

function ensureConnection() {
    if (_connection) return _connection;
    const cfg = getDbCredentials();
    if (!cfg.host || !cfg.user || !cfg.database) {
        throw new Error(
            'DB credentials missing. Set DB_HOST/DB_USER/DB_PASSWORD/DB_DATABASE env vars '
            + 'or add a "db" section to config.json.'
        );
    }
    if (!_mysql) _mysql = require('mysql');
    _connection = _mysql.createConnection(cfg);
    return _connection;
}

// 既存コードは `connection.query(...)` の形で参照しているため、
// 後方互換のため Proxy で遅延接続を提供する。
const connection = new Proxy({}, {
    get(_target, prop) {
        const conn = ensureConnection();
        const value = conn[prop];
        return typeof value === 'function' ? value.bind(conn) : value;
    },
});

async function queryDatabase(query, params) {
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
    const userExists = await queryDatabase('SELECT EXISTS (SELECT * FROM users WHERE userid = ? LIMIT 1)', [userId]);
    if (userExists[0][Object.keys(userExists[0])[0]] === 0) {
        await queryDatabase('INSERT INTO users (userid, register_date) VALUES (?, ?)', [userId, new Date().getTime()]);
    }
}

module.exports = { connection, queryDatabase, ensureUserExistsInDatabase, getDbCredentials };
