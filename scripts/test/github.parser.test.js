'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseContributionCalendar } = require('../../src/providers/github/githubSourceParser');

test('GitHub source parser decodes calendar cells, totals, and date bounds', () => {
    const calendar = parseContributionCalendar(`
        <h2 id="js-contribution-activity-description">1,234 contributions in the last year</h2>
        <td class="ContributionCalendar-day" data-date="2026-01-03" data-level="9"></td>
        <td class="ContributionCalendar-day" data-date='2026-01-01' data-level='-1'></td>
        <td class="ContributionCalendar-day" data-date=2026-01-02 data-level=2></td>
        <td class="ContributionCalendar-day" data-level="1"></td>
    `);
    assert.deepEqual(calendar, {
        cells: [
            { date: '2026-01-03', level: 4 },
            { date: '2026-01-01', level: 0 },
            { date: '2026-01-02', level: 2 },
        ],
        fromDate: '2026-01-01',
        toDate: '2026-01-03',
        total: 1234,
    });
});

test('GitHub source parser rejects missing and invalid calendar dates', () => {
    assert.equal(parseContributionCalendar('<html></html>'), null);
    assert.equal(parseContributionCalendar('<td class="ContributionCalendar-day" data-date="unknown" data-level="1">'), null);
});
