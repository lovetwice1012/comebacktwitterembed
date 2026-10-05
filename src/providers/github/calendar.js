'use strict';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateMs(dateText) {
    const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return NaN;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function contributionDayOfWeek(dateText) {
    const ms = dateMs(dateText);
    if (!Number.isFinite(ms)) return 0;
    return new Date(ms).getUTCDay();
}

function calendarWeeks(calendar) {
    const fromMs = dateMs(calendar.fromDate);
    const toMs = dateMs(calendar.toDate);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 53;
    return Math.floor((toMs - fromMs) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function monthMarkers(calendar) {
    const fromMs = dateMs(calendar.fromDate);
    const toMs = dateMs(calendar.toDate);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
    const start = new Date(fromMs);
    const current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    if (current.getTime() < fromMs) current.setUTCMonth(current.getUTCMonth() + 1);

    const out = [];
    while (current.getTime() <= toMs) {
        const week = Math.floor((current.getTime() - fromMs) / (7 * 24 * 60 * 60 * 1000));
        out.push({ label: MONTH_LABELS[current.getUTCMonth()], week: Math.max(0, week) });
        current.setUTCMonth(current.getUTCMonth() + 1);
    }
    return out;
}

function commitActivityToCalendar(activity) {
    if (!Array.isArray(activity) || activity.length === 0) return null;
    const cells = [];
    let maxDayCount = 0;
    for (const week of activity) {
        if (!Number.isFinite(Number(week?.week)) || !Array.isArray(week.days)) continue;
        for (let day = 0; day < Math.min(7, week.days.length); day++) {
            const count = Math.max(0, Number(week.days[day]) || 0);
            maxDayCount = Math.max(maxDayCount, count);
            cells.push({
                date: new Date((Number(week.week) + day * 24 * 60 * 60) * 1000).toISOString().slice(0, 10),
                count,
                level: 0,
            });
        }
    }
    if (cells.length === 0) return null;
    for (const cell of cells) {
        cell.level = cell.count <= 0 || maxDayCount <= 0
            ? 0
            : Math.max(1, Math.min(4, Math.ceil((cell.count / maxDayCount) * 4)));
    }
    return {
        cells,
        fromDate: cells[0].date,
        toDate: cells[cells.length - 1].date,
        total: cells.reduce((sum, cell) => sum + cell.count, 0),
    };
}

function startOfUtcDay(ms) {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcWeek(ms) {
    const dayMs = 24 * 60 * 60 * 1000;
    const start = startOfUtcDay(ms);
    return start - new Date(start).getUTCDay() * dayMs;
}

function recentCommitsToCalendar(commits) {
    if (!Array.isArray(commits) || commits.length === 0) return null;
    const dayMs = 24 * 60 * 60 * 1000;
    const counts = new Map();
    let latestMs = 0;
    for (const item of commits) {
        const rawDate = item?.commit?.committer?.date || item?.commit?.author?.date;
        const ms = Date.parse(rawDate);
        if (!Number.isFinite(ms)) continue;
        const day = startOfUtcDay(ms);
        counts.set(day, (counts.get(day) || 0) + 1);
        latestMs = Math.max(latestMs, day);
    }
    if (!latestMs) return null;

    const startMs = startOfUtcWeek(latestMs - 52 * 7 * dayMs);
    const cells = [];
    let maxDayCount = 0;
    for (let offset = 0; offset < 53 * 7; offset++) {
        const ms = startMs + offset * dayMs;
        const count = counts.get(ms) || 0;
        maxDayCount = Math.max(maxDayCount, count);
        cells.push({
            date: new Date(ms).toISOString().slice(0, 10),
            count,
            level: 0,
        });
    }
    for (const cell of cells) {
        cell.level = cell.count <= 0 || maxDayCount <= 0
            ? 0
            : Math.max(1, Math.min(4, Math.ceil((cell.count / maxDayCount) * 4)));
    }
    return {
        cells,
        fromDate: cells[0].date,
        toDate: cells[cells.length - 1].date,
        total: cells.reduce((sum, cell) => sum + cell.count, 0),
    };
}

module.exports = { dateMs, contributionDayOfWeek, calendarWeeks, monthMarkers, commitActivityToCalendar, startOfUtcWeek, recentCommitsToCalendar };
