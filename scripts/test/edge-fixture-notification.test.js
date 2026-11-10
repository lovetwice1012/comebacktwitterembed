'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { workerSource, acceptedCase } = require('../../experiments/chrome-push/edge-fixture-notification.cjs');

test('every synthetic push reaches a matching fixture observation endpoint', async () => {
    let onPush;
    const requests = [];
    vm.runInNewContext(workerSource, {
        self: { addEventListener(name, fn) { assert.equal(name, 'push'); onPush = fn; }, registration: { showNotification: async () => {} } },
        fetch: async (url, options) => { requests.push([url, options.method]); }, Promise,
    });
    for (const [body, expected] of [
        ['synthetic-wns-probe', 'initial'], ['synthetic-after-browser-exit', 'second'],
        ['synthetic-after-node-ack', 'third'], ['synthetic-after-reconnect', 'fourth'], ['synthetic-wns-copy-probe', 'copy'],
    ]) {
        let work;
        onPush({ data: { text: () => body }, waitUntil(promise) { work = promise; } });
        await work;
        const [url, method] = requests.pop();
        assert.equal(acceptedCase(url, method), expected);
    }
    assert.equal(acceptedCase('/seen?case=unknown', 'POST'), null);
    assert.equal(acceptedCase('/seen?case=copy', 'GET'), null);
});
