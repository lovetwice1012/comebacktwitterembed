'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATS_FILE = path.join(__dirname, '..', 'data', 'stats_counters.json');
const STATS_PERSIST_DELAY_MS = 5000;

const counters = {
    processed: 0,
    processed_hour: 0,
    processed_day: 0,
};

const counterPeriods = {
    minute: null,
    hour: null,
    day: null,
};

const consoleBuffer = {
    text: '',
};

let statsFile = DEFAULT_STATS_FILE;
let statsPersistTimer = null;

function pad2(value) {
    return String(value).padStart(2, '0');
}

function periodKeys(date = new Date()) {
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hour = pad2(date.getHours());
    const minute = pad2(date.getMinutes());
    return {
        minute: `${year}-${month}-${day}T${hour}:${minute}`,
        hour: `${year}-${month}-${day}T${hour}`,
        day: `${year}-${month}-${day}`,
    };
}

function safeCounter(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function applyCounters(raw) {
    counters.processed = safeCounter(raw?.processed);
    counters.processed_hour = safeCounter(raw?.processed_hour);
    counters.processed_day = safeCounter(raw?.processed_day);
}

function applyPeriods(raw, now = new Date()) {
    const keys = periodKeys(now);
    const savedAt = raw?.updatedAt ? new Date(raw.updatedAt) : null;
    const fallback = Number.isFinite(savedAt?.getTime()) ? periodKeys(savedAt) : keys;
    counterPeriods.minute = raw?.periods?.minute || fallback.minute;
    counterPeriods.hour = raw?.periods?.hour || fallback.hour;
    counterPeriods.day = raw?.periods?.day || fallback.day;
}

function rotateExpiredCounters(now = new Date()) {
    const keys = periodKeys(now);
    if (counterPeriods.minute !== null && counterPeriods.minute !== keys.minute) counters.processed = 0;
    if (counterPeriods.hour !== null && counterPeriods.hour !== keys.hour) counters.processed_hour = 0;
    if (counterPeriods.day !== null && counterPeriods.day !== keys.day) counters.processed_day = 0;
    counterPeriods.minute = keys.minute;
    counterPeriods.hour = keys.hour;
    counterPeriods.day = keys.day;
}

function ensureStatsFileDir(file = statsFile) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
}

function persistCounters(now = new Date(), file = statsFile) {
    try {
        ensureStatsFileDir(file);
        const keys = periodKeys(now);
        counterPeriods.minute = counterPeriods.minute || keys.minute;
        counterPeriods.hour = counterPeriods.hour || keys.hour;
        counterPeriods.day = counterPeriods.day || keys.day;
        fs.writeFileSync(file, JSON.stringify({
            processed: counters.processed,
            processed_hour: counters.processed_hour,
            processed_day: counters.processed_day,
            periods: { ...counterPeriods },
            updatedAt: now.toISOString(),
        }, null, 4));
    } catch (err) {
        console.warn('[state] Failed to persist stats counters:', err?.message || err);
    }
}

function schedulePersistCounters() {
    if (statsPersistTimer !== null) return;
    statsPersistTimer = setTimeout(() => {
        statsPersistTimer = null;
        persistCounters();
    }, STATS_PERSIST_DELAY_MS);
    if (typeof statsPersistTimer.unref === 'function') statsPersistTimer.unref();
}

function loadCounters(now = new Date(), file = statsFile) {
    if (!fs.existsSync(file)) {
        applyCounters({});
        applyPeriods({}, now);
        return;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        applyCounters(raw);
        applyPeriods(raw, now);
        rotateExpiredCounters(now);
    } catch (err) {
        console.warn('[state] Failed to load persisted stats counters:', err?.message || err);
        applyCounters({});
        applyPeriods({}, now);
    }
}

function incrementProcessedCounters(now = new Date()) {
    rotateExpiredCounters(now);
    counters.processed++;
    counters.processed_hour++;
    counters.processed_day++;
    // A synchronous write for every processed message stalls the whole bot.
    // Batch persistence; counters remain accurate in memory and are still
    // written promptly after the stream of messages settles.
    schedulePersistCounters();
}

function resetCountersAfterStatsPost(now = new Date()) {
    rotateExpiredCounters(now);
    counters.processed = 0;
    persistCounters(now);
}

function configureStatsPersistenceForTest(file) {
    statsFile = file;
}

loadCounters();

module.exports = {
    counters,
    consoleBuffer,
    incrementProcessedCounters,
    resetCountersAfterStatsPost,
    loadCounters,
    persistCounters,
    _internal: {
        configureStatsPersistenceForTest,
        periodKeys,
        rotateExpiredCounters,
        schedulePersistCounters,
        STATS_PERSIST_DELAY_MS,
        DEFAULT_STATS_FILE,
    },
};
