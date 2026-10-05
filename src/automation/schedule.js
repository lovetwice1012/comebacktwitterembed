'use strict';

const { DateTime } = require('luxon');
const MINUTE = 60000;
const DAY = 86400000;
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

function dayStart(date) {
    // A repeated midnight starts at its first occurrence regardless of which
    // offset calendar arithmetic inherited from the original evaluation date.
    return date.startOf('day').getPossibleOffsets().reduce((first, time) => time.toMillis() < first.toMillis() ? time : first);
}
function offsetSegments(date) {
    // Cover this local day and the next one for overnight intervals. On each
    // constant-offset segment, local-clock membership is a simple translation.
    // Locate IANA transitions with six-hour probes, then bisect to the exact
    // instant; do not assume that a transition changes the offset by one hour.
    const end = dayStart(date.plus({ days: 2 })).toMillis(), segments = [];
    let cursor = date.toMillis(), start = cursor, offset = date.zone.offset(cursor);
    while (cursor < end) {
        const next = Math.min(cursor + 6 * 60 * MINUTE, end);
        const probe = Math.min(next, end - 1);
        if (date.zone.offset(probe) === offset) { cursor = next; continue; }
        let low = cursor, high = probe;
        while (high - low > 1) {
            const mid = low + Math.floor((high - low) / 2);
            if (date.zone.offset(mid) === offset) low = mid;
            else high = mid;
        }
        segments.push({ start, end: high, offset });
        start = cursor = high; offset = date.zone.offset(high);
    }
    segments.push({ start, end, offset });
    return segments;
}
function intervals(date, window, segments) {
    const a = minutes(window.start), b = minutes(window.end);
    // UTC here is only a coordinate for the calendar fields, not the zone in
    // which the rule runs. Intersect its preimage with each real offset segment.
    // Gaps contribute no instants; folds may produce two disjoint intervals.
    const localDay = DateTime.utc(date.year, date.month, date.day).toMillis();
    const localStart = localDay + a * MINUTE, localEnd = localDay + (b <= a ? b + 1440 : b) * MINUTE;
    const ranges = [];
    for (const segment of segments) {
        const start = Math.max(segment.start, localStart - segment.offset * MINUTE);
        const end = Math.min(segment.end, localEnd - segment.offset * MINUTE);
        if (start < end) ranges.push([start, end]);
    }
    return ranges;
}
function merge(intervals) {
    const result = [];
    for (const range of intervals.filter(Boolean).sort((a, b) => a[0] - b[0])) {
        const last = result.at(-1);
        if (last && last[1] >= range[0]) last[1] = Math.max(last[1], range[1]);
        else result.push([...range]);
    }
    return result;
}
function nextWindow(earliestMs, config, absoluteDeadlineMs = Infinity) {
    const origin = DateTime.fromMillis(earliestMs, { zone: config.zone });
    const deadline = Math.min(absoluteDeadlineMs, earliestMs + config.maxWaitDays * DAY);
    const allowed = [], blocked = [];
    const excluded = new Set(config.datesExcluded);
    for (let day = -1; day <= config.maxWaitDays + 1; day++) {
        const date = dayStart(origin.startOf('day').plus({ days: day }));
        const segments = offsetSegments(date);
        if (config.days.includes(date.weekday)) for (const w of config.windows) allowed.push(...intervals(date, w, segments));
        for (const w of config.quiet) blocked.push(...intervals(date, w, segments));
        if (excluded.has(date.toISODate())) blocked.push([date.toMillis(), dayStart(date.plus({ days: 1 })).toMillis()]);
    }
    const exclusions = merge(blocked);
    for (const [start, end] of merge(allowed)) {
        let candidate = Math.max(start, earliestMs);
        if (candidate >= end || candidate > deadline) continue;
        for (const [a, b] of exclusions) {
            if (b <= candidate) continue;
            if (a > candidate) break;
            candidate = b;
        }
        if (candidate < end && candidate <= deadline) return candidate;
    }
    return null;
}

// All temporal constraints are intersected, rather than applying one quiet
// window and then allowing a later scheduling node to undo that restriction.
function scheduleDelivery(earliestMs, schedules, deadlineMs = Infinity) {
    let at = earliestMs;
    const horizon = Math.min(deadlineMs, earliestMs + Math.min(366, ...schedules.map(c => c.maxWaitDays)) * DAY);
    for (let i = 0; i < 1024; i++) {
        const previous = at;
        for (const schedule of schedules) {
            const next = nextWindow(at, schedule, horizon);
            if (next === null) return null;
            at = next;
        }
        if (at === previous) return at <= horizon ? at : null;
        if (at > horizon) return null;
    }
    return null;
}
module.exports = { MINUTE, DAY, nextWindow, scheduleDelivery };
