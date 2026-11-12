'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createDatabasePool } = require('../databasePool');
const verified = new WeakSet();

// Only this constructor can mark resources as isolated. It creates a new pool
// with a small explicit budget, then binds every offline SQL consumer to it.
// The caller must separately verify server-wide capacity and fleet versions.
function createOfflineResources({ credentials, connectionLimit, gatewayOptions, evaluator, clock = Date.now, rolloutMode, useLegacyUserInterval = false, graphEnabled }) {
    if (!credentials || typeof credentials !== 'object' || !Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 4
        || !gatewayOptions || !evaluator || typeof clock !== 'function' || graphEnabled !== true
        || typeof useLegacyUserInterval !== 'boolean') throw new Error('X_PUSH_OFFLINE_CONFIG_INVALID');
    const mysql = require('mysql'), context = new AsyncLocalStorage();
    const pool = createDatabasePool({ createPool: opts => mysql.createPool(opts), credentials,
        env: { BOT_DB_CONNECTION_LIMIT: String(connectionLimit), BOT_DB_QUEUE_LIMIT: '64' } });
    const db = Object.freeze({
        queryDatabase: (sql, params, options) => context.getStore() ? context.getStore()(sql, params, options) : pool.query(sql, params, options),
        withDatabaseTransaction: work => context.getStore() ? work(context.getStore()) : pool.withTransaction(query => context.run(query, () => work(query))),
    });
    const store = require('./x-push-store').createXPushStore(db, { now: clock });
    const gateway = require('./x-push-gateway').createXPushGateway(db, { ...gatewayOptions, enabled: true, store, now: clock, rolloutMode });
    const graphStore = require('./graph-store').createGraphStore(db);
    const queue = require('./queue').createQueue(db, evaluator, { clock, rolloutMode, useLegacyUserInterval, graph: { enabled: graphEnabled, store: graphStore } });
    const router = require('./x-event-router').createXEventRouter(db, queue, { clock, useLegacyUserInterval });
    const config = Object.freeze({ rolloutMode, useLegacyUserInterval, graphEnabled });
    const resources = Object.freeze({ db, gateway, queue, router, connectionLimit, config, close: () => pool.close() });
    verified.add(resources); return resources;
}
function isOfflineResources(value) { return !!value && verified.has(value); }
module.exports = { createOfflineResources, isOfflineResources };
