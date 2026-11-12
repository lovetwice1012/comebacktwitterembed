'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { trackFixtureChild, runFixtureCleanup } = require('../native-test/edge-mac-suppression-cleanup.cjs');
test('child error does not count as confirmed close', async () => {
    const child = new EventEmitter(), item = trackFixtureChild(child); child.emit('error', new Error('synthetic'));
    const before = await Promise.race([item.done.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5))]);
    assert.equal(before, false); assert.equal(item.closed, false);
    child.emit('close'); await item.done; assert.equal(item.closed, true);
});
test('cleanup continues after failures and marks the fixture unsafe', async () => {
    const events = [], safe = await runFixtureCleanup([async () => { events.push('first'); throw new Error('synthetic'); },
        async () => { events.push('second'); return false; }, async () => { events.push('third'); return true; }]);
    assert.equal(safe, false); assert.deepEqual(events, ['first', 'second', 'third']);
});
