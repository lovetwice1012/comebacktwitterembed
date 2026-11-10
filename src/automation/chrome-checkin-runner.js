'use strict';

const { createHash } = require('node:crypto');
const { checkin } = require('./chrome-checkin');
const MAX_TIMER = 2147483647;

// One timer per owned subscription, never one process. The caller's lease and
// authorization are rechecked immediately before and after network I/O.
function createChromeCheckinRunner({ lease, credentials, store, authorize, onFailure, now = Date.now,
    send = checkin, setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (!lease || !credentials || !store || typeof store.chromeCheckinState !== 'function'
        || typeof store.recordChromeCheckin !== 'function' || typeof store.assertLease !== 'function'
        || typeof authorize !== 'function' || typeof onFailure !== 'function') throw new Error('X_PUSH_CHECKIN_CONFIG_INVALID');
    const controller = new AbortController();
    let stopped = false, timer, work = Promise.resolve(), interval = 172800, target = null;
    const initialSpread = createHash('sha256').update(lease.subscriptionId).digest().readUInt32BE(0) % 60000;
    function schedule(at) {
        if (stopped) return;
        target = at;
        timer = setTimer(() => {
            if (stopped) return;
            if (now() < target) { schedule(target); return; }
            work = execute().catch(error => { if (!stopped) onFailure(error); });
        }, Math.max(1, Math.min(MAX_TIMER, at - now())));
    }
    async function execute() {
        await store.assertLease(lease, { authorize });
        if (stopped) return;
        const result = await send(credentials, { previousInterval: interval, signal: controller.signal });
        if (stopped) return;
        const saved = await store.recordChromeCheckin(lease, result, { authorize });
        if (stopped) return;
        interval = saved.intervalSeconds;
        schedule(saved.checkedAtMs + interval * 1000);
    }
    return {
        async start() {
            const state = await store.chromeCheckinState(lease, { authorize });
            if (stopped) return;
            interval = state.intervalSeconds;
            const due = state.checkedAtMs === null ? 0 : state.checkedAtMs + interval * 1000;
            schedule(Math.max(due, now() + initialSpread + 1));
        },
        async stop() {
            stopped = true; clearTimer(timer); controller.abort();
            await work;
        },
    };
}
module.exports = { createChromeCheckinRunner, MAX_TIMER };
