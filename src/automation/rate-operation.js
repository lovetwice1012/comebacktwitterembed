'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createRateLimiter } = require('./rate-limits');
const operations = new AsyncLocalStorage();
const limiters = new WeakMap();

// Shared across Discord preflight, native stores and the management service.
// Only the server caller can inject a limiter; client input never selects one.
async function withRateOperation(db, actor, group, work, options = {}) {
    const context = operations.getStore();
    if (context?.db === db && context.userId === actor?.userId && context.groups.has(group)) return work();
    let limiter = options.rateLimiter || limiters.get(db);
    if (!limiter) { limiter = createRateLimiter(db); limiters.set(db, limiter); }
    await limiter.consumeOperation(actor, group);
    const groups = new Set(context?.db === db && context.userId === actor?.userId ? context.groups : []);
    groups.add(group);
    return operations.run({ db, userId: actor.userId, groups }, work);
}

module.exports = { withRateOperation };
