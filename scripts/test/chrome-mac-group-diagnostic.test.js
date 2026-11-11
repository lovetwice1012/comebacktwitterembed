'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSyntheticGroup } = require('../native-test/chrome-mac-group-diagnostic.cjs');

test('group diagnostics retain only aggregate state for the selected synthetic group', () => {
    const text = '100 1 50 Z /private/SECRET/Google Chrome Helper\n101 3 50 S /usr/bin/osascript\n102 1 50 S /private/SECRET/unknown\n103 1 51 Z /private/SECRET/Google Chrome';
    const counts = summarizeSyntheticGroup(text, 50);
    assert.deepEqual(counts, { zombie: 1, live: 2, orphan: 2, chrome: 1, osascript: 1, other: 1 });
    assert.ok(!JSON.stringify(counts).includes('SECRET'));
});
