'use strict';

const fs = require('fs');
const path = require('path');
const {
    DAY,
    HOUR,
    MINUTE,
    integer,
    monitorConfig,
    parseState,
    sourceError,
} = require('./_shared');

function discover() {
    const found = {};
    for (const entry of fs.readdirSync(path.resolve(__dirname, '..'), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'autoWatch' || entry.name.startsWith('_')) continue;
        const filename = path.join(__dirname, '..', entry.name, 'autoWatch.js');
        if (!fs.existsSync(filename)) continue;
        const adapter = require(filename);
        if (!adapter || typeof adapter !== 'object' || adapter.id !== entry.name || typeof adapter.normalizeSource !== 'function' || typeof adapter.fetch !== 'function') {
            throw new Error(`Invalid auto-watch adapter: ${filename}`);
        }
        found[adapter.id] = Object.freeze(adapter);
    }
    return Object.freeze(found);
}

const PROVIDERS = discover();

function provider(providerId) {
    const adapter = PROVIDERS[String(providerId || '').toLowerCase()];
    if (!adapter) throw sourceError(`Unsupported automatic-watch provider: ${providerId}.`);
    return adapter;
}

function configuredBudget(providerId, adapter) {
    const key = String(providerId).toUpperCase();
    return {
        dailyRequestBudget: integer(process.env[`AUTO_WATCH_${key}_DAILY_BUDGET`], adapter.dailyRequestBudget, 1),
        hourlyRequestBudget: integer(process.env[`AUTO_WATCH_${key}_HOURLY_BUDGET`], adapter.hourlyRequestBudget, 1),
        minuteRequestBudget: integer(process.env[`AUTO_WATCH_${key}_MINUTE_BUDGET`], adapter.minuteRequestBudget, 1),
    };
}

function effectivePollIntervalMs(providerId, activeSourceCount, requestedPollMs) {
    const adapter = provider(providerId);
    const budget = configuredBudget(adapter.id, adapter);
    const count = Math.max(1, integer(activeSourceCount, 1));
    const requested = integer(requestedPollMs, adapter.defaultPollMs, adapter.minPollMs);
    const cost = Math.max(1, Number(adapter.requestCost || 1));
    const minuteFloor = budget.minuteRequestBudget ? Math.ceil((count * cost * MINUTE) / budget.minuteRequestBudget) : 0;
    const hourlyFloor = budget.hourlyRequestBudget ? Math.ceil((count * cost * HOUR) / budget.hourlyRequestBudget) : 0;
    const dailyFloor = budget.dailyRequestBudget ? Math.ceil((count * cost * DAY) / budget.dailyRequestBudget) : 0;
    return Math.max(adapter.minPollMs, requested, minuteFloor, hourlyFloor, dailyFloor);
}

function ratePolicy(providerId) {
    const adapter = provider(providerId);
    const budget = configuredBudget(adapter.id, adapter);
    const requestCost = Math.max(1, Number(adapter.requestCost || 1));
    const floors = [
        Number(adapter.globalSpacingMs || 0),
        budget.minuteRequestBudget ? Math.ceil((requestCost * MINUTE) / budget.minuteRequestBudget) : 0,
        budget.hourlyRequestBudget ? Math.ceil((requestCost * HOUR) / budget.hourlyRequestBudget) : 0,
        budget.dailyRequestBudget ? Math.ceil((requestCost * DAY) / budget.dailyRequestBudget) : 0,
    ];
    return {
        providerId: adapter.id,
        requestCost,
        dailyRequestBudget: budget.dailyRequestBudget || null,
        hourlyRequestBudget: budget.hourlyRequestBudget || null,
        minuteRequestBudget: budget.minuteRequestBudget || null,
        globalSpacingMs: Math.max(...floors),
    };
}

function normalizeSource(providerId, input) {
    return provider(providerId).normalizeSource(input);
}

async function fetchSource(source, options = {}) {
    const adapter = provider(source.provider_id);
    const context = {
        config: monitorConfig(options.config),
        fetch: options.fetch,
    };
    return adapter.fetch({ ...source, state: parseState(source.state_json ?? source.state) }, context);
}

function initialCursor(providerId, items) {
    const adapter = provider(providerId);
    const value = typeof adapter.initialCursor === 'function' ? adapter.initialCursor(items) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isHistoricalAtBaseline(providerId, cursor, item) {
    const adapter = provider(providerId);
    return typeof adapter.isHistoricalAtBaseline === 'function'
        && adapter.isHistoricalAtBaseline(cursor || {}, item) === true;
}

module.exports = {
    PROVIDERS,
    effectivePollIntervalMs,
    fetchSource,
    initialCursor,
    isHistoricalAtBaseline,
    monitorConfig,
    normalizeSource,
    provider,
    ratePolicy,
    _internal: { configuredBudget, discover },
};
