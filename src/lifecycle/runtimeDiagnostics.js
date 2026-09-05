'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { messageWorkQueue } = require('../workQueue');

let timer = null;
let delay = null;

function start() {
    if (timer) return;
    delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let previous = performance.eventLoopUtilization();
    timer = setInterval(() => {
        const utilization = performance.eventLoopUtilization(previous);
        previous = performance.eventLoopUtilization();
        const memory = process.memoryUsage();
        const mib = value => Math.round(value / 1024 / 1024);
        console.log('[performance]', JSON.stringify({
            rssMiB: mib(memory.rss), heapUsedMiB: mib(memory.heapUsed),
            externalMiB: mib(memory.external), arrayBuffersMiB: mib(memory.arrayBuffers),
            eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
            eventLoopUtilization: Math.round(utilization.utilization * 1000) / 1000,
            messages: messageWorkQueue.snapshot(),
        }));
        delay.reset();
    }, 60000);
    timer.unref?.();
}

function stop() {
    clearInterval(timer);
    timer = null;
    delay?.disable();
    delay = null;
}

module.exports = { start, stop };
