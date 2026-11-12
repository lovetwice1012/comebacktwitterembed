'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeCalibrationError } = require('../native-test/edge-mac-fixture-error.cjs');

test('synthetic calibration reports only fixed error codes', () => {
    assert.equal(safeCalibrationError('X_EDGE_CALIBRATION_TIMEOUT'), 'X_EDGE_CALIBRATION_TIMEOUT');
    assert.equal(safeCalibrationError('X_EDGE_MAC_BROWSER_INVALID'), 'X_EDGE_MAC_BROWSER_INVALID');
    for (const value of ['X_EDGE_CALIBRATION_SECRET', 'https://secret.example/', 'private', '', null, undefined, {}])
        assert.equal(safeCalibrationError(value), 'FIXTURE_FAILED');
});
