'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finiteNumber, parseMetricNumber, createProviderAnalytics } = require('../../src/analytics/providerMetrics');

test('strict metric numbers preserve real zero and recognize complete compact magnitudes', () => {
    for (const [raw, expected] of [[0, 0], ['0', 0], ['1,234', 1234], ['-3.5', -3.5], ['.25', 0.25], ['1e3', 1000],
        ['1.2K', 1200], ['2.5m', 2500000], ['3B', 3000000000], ['1.2万', 12000], ['2億', 200000000], ['１.２万', 12000]]) {
        assert.equal(finiteNumber(raw), expected, String(raw));
    }
});
test('unknown strings and malformed grouping never become their first numeric substring', () => {
    for (const raw of ['about 100', '100 views', '1K-2K', '10–20', '4.5 / 5', '2026-09-05', '1,23', '1,234,56',
        '1.234,56', 'NaN', 'Infinity', '1e309', '1.2Q', '1万2千', '$9.99', '50%', '1:30', true, [], {}, NaN, Infinity, 9007199254740992]) {
        assert.equal(finiteNumber(raw), null, String(raw));
    }
});
test('money and percentage formats are explicit and do not conceal ranges or unknown locale', () => {
    assert.equal(finiteNumber('¥1,234', { kind: 'money' }), 1234);
    assert.equal(finiteNumber('$19.99', { kind: 'money' }), 19.99);
    assert.equal(finiteNumber('19.99 USD', { kind: 'money' }), 19.99);
    assert.equal(parseMetricNumber('JPY 0', { kind: 'money' }).unit, 'JPY');
    assert.equal(finiteNumber('$10 - $20', { kind: 'money' }), null);
    assert.equal(finiteNumber('€1.234,56', { kind: 'money' }), null);
    assert.equal(finiteNumber('$10 USD', { kind: 'money' }), null);
    assert.equal(finiteNumber('25% off', { kind: 'percent' }), 25);
    assert.equal(finiteNumber('25%-50%', { kind: 'percent' }), null);
});
test('duration and rating parsing keep their units and validate complete known formats', () => {
    assert.equal(finiteNumber('1h 30m', { kind: 'duration' }), 5400);
    assert.equal(finiteNumber('3:25', { kind: 'duration' }), 205);
    assert.equal(finiteNumber('1:02:03', { kind: 'duration' }), 3723);
    assert.equal(finiteNumber('3:99', { kind: 'duration' }), null);
    assert.equal(finiteNumber('4.5 / 5 (1,234)', { kind: 'rating' }), 4.5);
    assert.equal(parseMetricNumber('4.5 / 5', { kind: 'rating' }).unit, 'out_of_5');
    assert.equal(finiteNumber('6 / 5', { kind: 'rating' }), null);
    assert.equal(finiteNumber('2K', { kind: 'duration' }), null);
});
test('metric parsing keeps raw values and distinguishes unobserved from invalid data', () => {
    assert.equal(parseMetricNumber(null).status, 'missing');
    assert.equal(parseMetricNumber('unknown 100').status, 'invalid');
    const analysis = createProviderAnalytics({ metrics: { views: '1.2K', likes: 'unknown 100', comments: 0 } });
    assert.deepEqual(analysis.metrics, { views: 1200, comments: 0 });
    assert.equal(analysis.metadata.numericParsing.likes.raw, 'unknown 100');
    assert.equal(analysis.metadata.numericParsing.likes.reason, 'unrecognized_numeric_format');
    assert.equal(analysis.metadata.numericParsing.comments.status, 'ok');
});
