'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextWindow, scheduleDelivery, DAY, MINUTE } = require('../../src/automation/schedule');
const at = value => Date.parse(value);
function hours(changes = {}) {
    return { zone: 'America/New_York', days: [1, 2, 3, 4, 5, 6, 7], windows: [{ start: '00:00', end: '24:00' }], quiet: [], datesExcluded: [], maxWaitDays: 14, ...changes };
}
function expectNext(config, input, expected, deadline) {
    assert.equal(nextWindow(at(input), config, deadline === undefined ? Infinity : at(deadline)), expected === null ? null : at(expected), input);
}

test('spring gap quiet 02:30-04:00 still blocks actual 03:00-04:00 including the reported 03:30', () => {
    const config = hours({ quiet: [{ start: '02:30', end: '04:00' }] });
    for (const [input, expected] of [
        ['2026-03-08T01:59:59.999-05:00', '2026-03-08T01:59:59.999-05:00'],
        ['2026-03-08T03:00:00-04:00', '2026-03-08T04:00:00-04:00'],
        ['2026-03-08T03:30:00-04:00', '2026-03-08T04:00:00-04:00'],
        ['2026-03-08T03:59:59.999-04:00', '2026-03-08T04:00:00-04:00'],
        ['2026-03-08T04:00:00-04:00', '2026-03-08T04:00:00-04:00'],
    ]) expectNext(config, input, expected);
});

test('spring gap at a quiet interval end blocks until the clock jumps past it', () => {
    const config = hours({ quiet: [{ start: '01:30', end: '02:30' }] });
    expectNext(config, '2026-03-08T01:45:00-05:00', '2026-03-08T03:00:00-04:00');
    expectNext(config, '2026-03-08T03:00:00-04:00', '2026-03-08T03:00:00-04:00');
});

test('partly missing allowed intervals retain their real portion instead of dropping the day', () => {
    const startGap = hours({ windows: [{ start: '02:30', end: '04:00' }] });
    expectNext(startGap, '2026-03-08T01:45:00-05:00', '2026-03-08T03:00:00-04:00');
    expectNext(startGap, '2026-03-08T03:30:00-04:00', '2026-03-08T03:30:00-04:00');
    const endGap = hours({ windows: [{ start: '01:30', end: '02:30' }] });
    expectNext(endGap, '2026-03-08T01:45:00-05:00', '2026-03-08T01:45:00-05:00');
    expectNext(endGap, '2026-03-08T03:00:00-04:00', '2026-03-09T01:30:00-04:00');
});

test('a wholly nonexistent appointment is still skipped and a wholly nonexistent quiet interval blocks nothing', () => {
    const window = { start: '02:30', end: '02:31' };
    expectNext(hours({ windows: [window] }), '2026-03-08T01:00:00-05:00', '2026-03-09T02:30:00-04:00');
    expectNext(hours({ windows: [window] }), '2026-03-08T01:00:00-05:00', null, '2026-03-08T23:59:59-04:00');
    expectNext(hours({ quiet: [window] }), '2026-03-08T03:00:00-04:00', '2026-03-08T03:00:00-04:00');
});

test('fall repeated allowed hour has two precise half-open intervals with no artificial bridge', () => {
    const config = hours({ windows: [{ start: '01:30', end: '01:45' }] });
    for (const [input, expected] of [
        ['2026-11-01T01:00:00-04:00', '2026-11-01T01:30:00-04:00'],
        ['2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-04:00'],
        ['2026-11-01T01:44:59.999-04:00', '2026-11-01T01:44:59.999-04:00'],
        ['2026-11-01T01:45:00-04:00', '2026-11-01T01:30:00-05:00'],
        ['2026-11-01T01:15:00-05:00', '2026-11-01T01:30:00-05:00'],
        ['2026-11-01T01:30:00-05:00', '2026-11-01T01:30:00-05:00'],
        ['2026-11-01T01:45:00-05:00', '2026-11-02T01:30:00-05:00'],
    ]) expectNext(config, input, expected);
});

test('fall repeated quiet interval blocks both occurrences without blocking the intervening local times', () => {
    const config = hours({ quiet: [{ start: '01:30', end: '01:45' }] });
    for (const offset of ['-04:00', '-05:00']) {
        expectNext(config, `2026-11-01T01:35:00${offset}`, `2026-11-01T01:45:00${offset}`);
        expectNext(config, `2026-11-01T01:45:00${offset}`, `2026-11-01T01:45:00${offset}`);
    }
    expectNext(config, '2026-11-01T01:55:00-04:00', '2026-11-01T01:55:00-04:00');
    expectNext(config, '2026-11-01T01:10:00-05:00', '2026-11-01T01:10:00-05:00');
});

test('fall intervals spanning the entire repeated hour remain continuous', () => {
    const window = { start: '01:00', end: '02:00' };
    expectNext(hours({ windows: [window] }), '2026-11-01T01:30:00-05:00', '2026-11-01T01:30:00-05:00');
    expectNext(hours({ quiet: [window] }), '2026-11-01T01:30:00-04:00', '2026-11-01T02:00:00-05:00');
    expectNext(hours({ quiet: [window] }), '2026-11-01T01:30:00-05:00', '2026-11-01T02:00:00-05:00');
});

test('overnight quiet intervals retain their tail across both DST transitions', () => {
    const config = hours({ quiet: [{ start: '22:00', end: '04:00' }] });
    expectNext(config, '2026-03-07T23:30:00-05:00', '2026-03-08T04:00:00-04:00');
    expectNext(config, '2026-03-08T03:30:00-04:00', '2026-03-08T04:00:00-04:00');
    expectNext(config, '2026-10-31T23:30:00-04:00', '2026-11-01T04:00:00-05:00');
    expectNext(config, '2026-11-01T01:30:00-05:00', '2026-11-01T04:00:00-05:00');
    expectNext(hours({ quiet: [{ start: '22:00', end: '02:30' }] }), '2026-03-08T01:45:00-05:00', '2026-03-08T03:00:00-04:00');
});

test('overnight allowed intervals belong to the start weekday while quiet hours apply every day', () => {
    const config = hours({ days: [6], windows: [{ start: '22:00', end: '04:00' }] });
    expectNext(config, '2026-03-08T03:30:00-04:00', '2026-03-08T03:30:00-04:00');
    expectNext(config, '2026-03-08T04:00:00-04:00', '2026-03-14T22:00:00-04:00');
    expectNext({ ...config, quiet: [{ start: '02:30', end: '04:00' }] }, '2026-03-08T03:30:00-04:00', '2026-03-14T22:00:00-04:00');
    const fall = { ...config, windows: [{ start: '22:00', end: '01:45' }] };
    expectNext(fall, '2026-11-01T01:50:00-04:00', '2026-11-01T01:00:00-05:00');
});

test('excluded dates cover the actual 23-hour or 25-hour local calendar day', () => {
    expectNext(hours({ datesExcluded: ['2026-03-08'] }), '2026-03-08T03:30:00-04:00', '2026-03-09T00:00:00-04:00');
    expectNext(hours({ datesExcluded: ['2026-11-01'] }), '2026-11-01T01:15:00-05:00', '2026-11-02T00:00:00-05:00');
    const overnight = hours({ days: [6], windows: [{ start: '22:00', end: '04:00' }], datesExcluded: ['2026-03-07'] });
    expectNext(overnight, '2026-03-07T23:00:00-05:00', '2026-03-08T00:00:00-05:00');
    expectNext({ ...overnight, datesExcluded: ['2026-03-08'] }, '2026-03-08T03:30:00-04:00', '2026-03-14T22:00:00-04:00');
});

test('selected weekdays and excluded dates are evaluated in the configured zone', () => {
    const config = hours({ days: [7], windows: [{ start: '02:30', end: '04:00' }], datesExcluded: ['2026-03-08'] });
    expectNext(config, '2026-03-08T01:00:00-05:00', '2026-03-15T02:30:00-04:00');
    const tokyo = hours({ zone: 'Asia/Tokyo', days: [1], windows: [{ start: '00:00', end: '01:00' }] });
    expectNext(tokyo, '2026-09-20T15:30:00Z', '2026-09-20T15:30:00Z');
});

test('deadline is inclusive at the first allowed instant, including millisecond boundaries', () => {
    const config = hours({ quiet: [{ start: '02:30', end: '04:00' }] });
    expectNext(config, '2026-03-08T03:30:00-04:00', '2026-03-08T04:00:00-04:00', '2026-03-08T04:00:00-04:00');
    expectNext(config, '2026-03-08T03:30:00-04:00', null, '2026-03-08T03:59:59.999-04:00');
    expectNext(config, '2026-03-08T04:00:00.001-04:00', null, '2026-03-08T04:00:00-04:00');
    const fold = hours({ windows: [{ start: '01:30', end: '01:45' }] });
    expectNext(fold, '2026-11-01T01:45:00-04:00', '2026-11-01T01:30:00-05:00', '2026-11-01T01:30:00-05:00');
    expectNext(fold, '2026-11-01T01:45:00-04:00', null, '2026-11-01T01:29:59.999-05:00');
});

test('maxWaitDays remains elapsed 24-hour days across a 23-hour or 25-hour local day', () => {
    const config = hours({ maxWaitDays: 1, days: [7], windows: [{ start: '04:30', end: '05:00' }] });
    expectNext(config, '2026-03-07T04:00:00-05:00', '2026-03-08T04:30:00-04:00');
    expectNext(config, '2026-10-31T04:00:00-04:00', null);
    expectNext({ ...config, maxWaitDays: 2 }, '2026-10-31T04:00:00-04:00', '2026-11-01T04:30:00-05:00');
    const exact = hours({ zone: 'UTC', maxWaitDays: 1, days: [2], windows: [{ start: '09:00', end: '10:00' }] });
    expectNext(exact, '2026-09-21T09:00:00Z', '2026-09-22T09:00:00Z');
});

test('schedule intersections keep every quiet interval and the original absolute deadline', () => {
    const quiet = hours({ quiet: [{ start: '02:30', end: '04:00' }] });
    const utcWindow = hours({ zone: 'UTC', windows: [{ start: '07:00', end: '08:30' }] });
    const start = at('2026-03-08T07:30:00Z'), end = at('2026-03-08T08:00:00Z');
    for (const schedules of [[quiet, utcWindow], [utcWindow, quiet]]) {
        assert.equal(scheduleDelivery(start, schedules, end), end);
        assert.equal(scheduleDelivery(start, schedules, end - 1), null);
        assert.equal(scheduleDelivery(start, [...schedules, hours({ zone: 'UTC', windows: [{ start: '06:00', end: '07:45' }] })], end), null);
    }
    assert.equal(scheduleDelivery(start, [], start), start);
    assert.equal(scheduleDelivery(start, [], start - 1), null);
});

test('30-minute DST gap and fold in Lord Howe use the actual offset change', () => {
    const zone = 'Australia/Lord_Howe';
    expectNext(hours({ zone, quiet: [{ start: '02:10', end: '03:00' }] }), '2026-10-04T02:45:00+11:00', '2026-10-04T03:00:00+11:00');
    expectNext(hours({ zone, windows: [{ start: '02:10', end: '02:20' }] }), '2026-10-04T01:45:00+10:30', '2026-10-05T02:10:00+11:00');
    const fold = hours({ zone, windows: [{ start: '01:45', end: '01:50' }] });
    expectNext(fold, '2026-04-05T01:45:00+11:00', '2026-04-05T01:45:00+11:00');
    expectNext(fold, '2026-04-05T01:55:00+11:00', '2026-04-05T01:45:00+10:30');
});

test('a midnight gap does not shift the following calendar day or exclusion boundary by one hour', () => {
    const config = hours({ zone: 'America/Havana', datesExcluded: ['2026-03-08'] });
    expectNext(config, '2026-03-08T01:30:00-04:00', '2026-03-09T00:00:00-04:00');
    expectNext({ ...config, datesExcluded: [], days: [1], windows: [{ start: '00:00', end: '00:30' }] }, '2026-03-08T01:30:00-04:00', '2026-03-09T00:00:00-04:00');
});

test('a future repeated midnight includes the first occurrence even when the origin has the other offset', () => {
    // Jan 1 uses standard time. Exclude the preceding Sundays so the next
    // selected date is Nov 1, whose midnight occurs in both daylight/standard time.
    const datesExcluded = Array.from({ length: 43 }, (_, i) => new Date(at('2026-01-04T00:00:00Z') + i * 7 * DAY).toISOString().slice(0, 10));
    const config = hours({ zone: 'America/Havana', days: [7], windows: [{ start: '00:10', end: '00:20' }], maxWaitDays: 366, datesExcluded });
    expectNext(config, '2026-01-01T00:00:00-05:00', '2026-11-01T00:10:00-04:00');
});

// Independent oracle: classify actual instants by their displayed local time.
// It does not reconstruct UTC intervals from local boundaries like the implementation.
for (const [name, first] of [['spring', '2026-03-08T05:00:00Z'], ['fall', '2026-11-01T04:00:00Z']]) {
    test(`${name} transition agrees with local-clock membership at every five-minute sample`, () => {
        const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
        const configs = [
            hours({ maxWaitDays: 1, windows: [{ start: '01:30', end: '03:30' }], quiet: [{ start: '01:45', end: '02:15' }] }),
            hours({ maxWaitDays: 1, quiet: [{ start: '02:30', end: '04:00' }] }),
        ];
        const windowMinute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
        for (const config of configs) {
            const before = structuredClone(config);
            const start = at(first), end = start + DAY + 6 * 60 * MINUTE;
            const eligible = [];
            for (let instant = start; instant <= end; instant += MINUTE) {
                const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
                const local = Number(parts.hour) * 60 + Number(parts.minute);
                const inside = window => local >= windowMinute(window.start) && local < windowMinute(window.end);
                if (config.windows.some(inside) && !config.quiet.some(inside)) eligible.push(instant);
            }
            for (let instant = start; instant < start + 6 * 60 * MINUTE; instant += 5 * MINUTE) {
                const expected = eligible.find(time => time >= instant && time <= instant + DAY) ?? null;
                assert.equal(nextWindow(instant, config), expected, new Date(instant).toISOString());
            }
            assert.deepEqual(config, before, 'the schedule input is never mutated');
        }
    });
}
