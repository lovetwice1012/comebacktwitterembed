'use strict';

function positiveInteger(value, fallback, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 && number <= maximum ? number : fallback;
}

function createDatabasePool({ createPool, credentials, env = process.env, onError = (_error, _options) => {} }) {
    const queryTimeout = positiveInteger(env.BOT_DB_QUERY_TIMEOUT_MS, 30000, 300000);
    const pool = createPool({
        ...credentials,
        connectionLimit: positiveInteger(env.BOT_DB_CONNECTION_LIMIT, 8, 64),
        queueLimit: positiveInteger(env.BOT_DB_QUEUE_LIMIT, 512, 10000),
        waitForConnections: true,
        connectTimeout: 10000,
        acquireTimeout: 10000,
    });

    function queryOn(target, sql, params = [], options = {}) {
        return new Promise((resolve, reject) => {
            target.query({ sql, timeout: queryTimeout }, params, (error, results) => {
                if (error) {
                    onError(error, options);
                    reject(error);
                } else resolve(results);
            });
        });
    }

    async function withTransaction(work) {
        const connection = await new Promise((resolve, reject) => {
            pool.getConnection((error, acquired) => error ? reject(error) : resolve(acquired));
        });
        const query = (sql, params = [], options = {}) => queryOn(connection, sql, params, options);
        let reusable = false;
        try {
            await query('START TRANSACTION');
            const result = await work(query);
            await query('COMMIT');
            reusable = true;
            return result;
        } catch (error) {
            try {
                await query('ROLLBACK');
                reusable = true;
            } catch { /* A connection with uncertain transaction state is discarded. */ }
            throw error;
        } finally {
            if (reusable) connection.release();
            else connection.destroy();
        }
    }

    return {
        pool,
        query: (sql, params = [], options = {}) => queryOn(pool, sql, params, options),
        withTransaction,
        close: () => new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve())),
    };
}

module.exports = { createDatabasePool, positiveInteger };
