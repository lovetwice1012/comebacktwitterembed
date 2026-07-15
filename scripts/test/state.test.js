'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    counters,
    incrementProcessedCounters,
    loadCounters,
    resetCountersAfterStatsPost,
    _internal,
} = require('../../src/state');

function makeTempStatsFile() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-state-'));
    return {
        tmpDir,
        statsFile: path.join(tmpDir, 'stats.json'),
    };
}

function cleanupTempStatsFile(tmpDir) {
    _internal.configureStatsPersistenceForTest(_internal.DEFAULT_STATS_FILE);
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

test('state: persists counters and reloads them after process memory is reset', () => {
    const { tmpDir, statsFile } = makeTempStatsFile();
    const now = new Date(2026, 5, 22, 12, 34, 0);

    try {
        _internal.configureStatsPersistenceForTest(statsFile);
        loadCounters(now, statsFile);

        incrementProcessedCounters(now);
        incrementProcessedCounters(now);
        // The hot path batches disk I/O; persist explicitly when checking the
        // restart file contract.
        require('../../src/state').persistCounters(now);

        counters.processed = 0;
        counters.processed_hour = 0;
        counters.processed_day = 0;

        loadCounters(now, statsFile);

        assert.equal(counters.processed, 2);
        assert.equal(counters.processed_hour, 2);
        assert.equal(counters.processed_day, 2);
    } finally {
        cleanupTempStatsFile(tmpDir);
    }
});

test('state: rotates expired minute and hour counters when loading persisted stats', () => {
    const { tmpDir, statsFile } = makeTempStatsFile();
    const savedAt = new Date(2026, 5, 22, 12, 34, 0);
    const now = new Date(2026, 5, 22, 13, 0, 0);

    try {
        fs.writeFileSync(statsFile, JSON.stringify({
            processed: 4,
            processed_hour: 8,
            processed_day: 12,
            periods: _internal.periodKeys(savedAt),
            updatedAt: savedAt.toISOString(),
        }));

        _internal.configureStatsPersistenceForTest(statsFile);
        loadCounters(now, statsFile);

        assert.equal(counters.processed, 0);
        assert.equal(counters.processed_hour, 0);
        assert.equal(counters.processed_day, 12);
    } finally {
        cleanupTempStatsFile(tmpDir);
    }
});

test('state: stats post reset persists the minute counter reset', () => {
    const { tmpDir, statsFile } = makeTempStatsFile();
    const now = new Date(2026, 5, 22, 12, 34, 0);

    try {
        _internal.configureStatsPersistenceForTest(statsFile);
        loadCounters(now, statsFile);
        counters.processed = 5;
        counters.processed_hour = 9;
        counters.processed_day = 13;

        resetCountersAfterStatsPost(now);

        const saved = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        assert.equal(counters.processed, 0);
        assert.equal(counters.processed_hour, 9);
        assert.equal(counters.processed_day, 13);
        assert.equal(saved.processed, 0);
        assert.equal(saved.processed_hour, 9);
        assert.equal(saved.processed_day, 13);
    } finally {
        cleanupTempStatsFile(tmpDir);
    }
});
