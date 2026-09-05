'use strict';

const { positiveInteger } = require('./databasePool');

function withDeadline(fetchImpl, defaultTimeoutMs = positiveInteger(process.env.BOT_PROVIDER_TIMEOUT_MS, 30000, 300000)) {
    return (url, options = {}) => {
        const timeoutMs = positiveInteger(options.timeout, defaultTimeoutMs, 300000);
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        // The signal remains active while consuming the body and across
        // redirects. Aborting destroys the actual node-fetch request/stream.
        return fetchImpl(url, { ...options, signal });
    };
}

module.exports = { withDeadline };
