'use strict';
const fs = require('node:fs');
// MySQL 8 administrative accounts can use caching_sha2_password.
const mysql = require('mysql2');

function option(name, fallback = undefined) {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
}

function credentials() {
    const file = option('--defaults-file');
    if (!file) return require('../../src/db').getDbCredentials();
    const config = {};
    let section = '';
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) { section = line.slice(1, -1); continue; }
        if (section !== 'client' || !line || /^[#;]/.test(line)) continue;
        const match = line.match(/^([\w-]+)\s*=\s*(.*)$/);
        if (!match) continue;
        const key = { socket: 'socketPath' }[match[1]] || match[1];
        if (!['host', 'user', 'password', 'port', 'socketPath'].includes(key)) continue;
        config[key] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return config;
}

async function connect(database, timeoutMs = 30000) {
    const connection = mysql.createConnection({
        ...credentials(), database, connectTimeout: 10000,
        supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
    });
    const query = (sql, params = []) => new Promise((resolve, reject) => {
        connection.query({ sql, timeout: timeoutMs + 10000 }, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
    await query('SET SESSION lock_wait_timeout=5, innodb_lock_wait_timeout=10, max_execution_time=?', [timeoutMs]);
    // Avoid multiplying the cold initial count's I/O across InnoDB readers.
    await query('SET SESSION innodb_parallel_read_threads=1');
    return { connection, query, close: () => new Promise(resolve => connection.end(resolve)) };
}

module.exports = { connect, option };
