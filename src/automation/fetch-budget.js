'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
function runBoundedFetches(maxRequests, work) {
    const budget = { remaining: maxRequests, exceeded: false };
    return context.run(budget, async () => {
        const result = await work();
        // Some providers catch fetch failures and produce a fallback notice.
        // Don't misrepresent an exhausted automation budget as actual content.
        if (budget.exceeded) throw Object.assign(new Error('Automation expansion request budget reached'), { code: 'AUTOMATION_FETCH_BUDGET' });
        return result;
    });
}
function isGuestExecution() { return !!context.getStore(); }
function applyBudget(options, url) {
    const budget = context.getStore();
    if (!budget) return options;
    if (url) {
        const parsed = new URL(String(url));
        if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => /^(?:client_secret|api_key|apikey|password|authorization)$/i.test(key))) {
            throw Object.assign(new Error('Guest automation must not transmit account credentials'), { code: 'AUTOMATION_GUEST_ONLY' });
        }
    }
    if (budget.remaining-- <= 0) {
        budget.exceeded = true;
        throw Object.assign(new Error('Automation expansion request budget reached'), { code: 'AUTOMATION_FETCH_BUDGET' });
    }
    // The reservation charges two units per call, including one redirect.
    // This context is opt-in and leaves ordinary expansions unchanged.
    const headers = new (require('node-fetch').Headers)(options.headers);
    for (const name of ['authorization', 'cookie', 'x-api-key', 'x-auth-token']) headers.delete(name);
    // A normal provider may have an operator's GITHUB_TOKEN/Twitch token in its
    // configured client. Automatic notifications must not gain private-data
    // access from those credentials when a previously public URL changes.
    return { ...options, headers, follow: 1 };
}
module.exports = { runBoundedFetches, applyBudget, isGuestExecution };
