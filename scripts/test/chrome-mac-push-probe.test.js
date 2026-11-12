'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeAfterGone } = require('../native-test/chrome-mac-push-probe.cjs');

test('diagnostic retry stops at the first acceptance and reports only fixed categories', async () => {
    let now = 0, calls = 0; const events = [], waits = [];
    const result = await probeAfterGone({ send: async () => { calls++; now += 3; if (calls < 3) throw { statusCode: 410, body: 'expired secret' }; },
        sleep: async ms => { waits.push(ms); now += ms; }, elapsedMs: () => now, report: event => events.push(event) });
    assert.deepEqual(result, { accepted: true, attempts: 3 });
    assert.deepEqual(waits, [250, 750]); assert.equal(calls, 3);
    assert.deepEqual(events.map(event => event.result), ['410_EXPIRED', '410_EXPIRED', 'accepted']);
    assert.equal(JSON.stringify(events).includes('secret'), false);
});

test('diagnostic retry stops on non-410 and on bounded repeated 410', async () => {
    for (const statusCode of [500, 429, undefined]) {
        let calls = 0;
        const result = await probeAfterGone({ send: async () => { calls++; throw { statusCode, body: 'secret' }; },
            sleep: async () => assert.fail('no retry after non-410'), elapsedMs: () => 0, report: () => {} });
        assert.deepEqual(result, { accepted: false, attempts: 1, stopped: 'non_410' }); assert.equal(calls, 1);
    }
    let calls = 0;
    const result = await probeAfterGone({ send: async () => { calls++; throw { statusCode: 410 }; }, sleep: async () => {}, elapsedMs: () => 0, report: () => {} });
    assert.deepEqual(result, { accepted: false, attempts: 5, stopped: 'all_410' }); assert.equal(calls, 5);
});
