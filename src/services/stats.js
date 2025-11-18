let processed = 0;
let processed_hour = 0;
let processed_day = 0;

function incrementProcessed() {
    processed++;
    processed_hour++;
    processed_day++;
}

function getStats() {
    return {
        processed,
        processed_hour,
        processed_day
    };
}

function resetHourly() {
    processed_hour = 0;
}

function resetDaily() {
    processed_day = 0;
}

module.exports = {
    incrementProcessed,
    getStats,
    resetHourly,
    resetDaily
};
