'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkQueue } = require('../../src/workQueue');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('message bursts have bounded concurrency and drain queued work in arrival order', async () => {
    const queue = new WorkQueue({ concurrency: 2, maxPending: 10 });
    const releases = [];
    const started = [];
    const jobs = Array.from({ length: 6 }, (_, index) => queue.run(() => {
        started.push(index);
        return new Promise(resolve => releases.push(resolve));
    }));
    await tick();
    assert.deepEqual(started, [0, 1]);
    assert.equal(queue.snapshot().pending, 4);
    for (let i = 0; i < 6; i++) {
        releases.shift()(i);
        await tick();
        assert.ok(queue.active <= 2);
    }
    assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    assert.equal(queue.active, 0);
});

test('full and expired queues release retained jobs without starting expired work', async () => {
    const queue = new WorkQueue({ concurrency: 1, maxPending: 1, maxWaitMs: 10 });
    let release;
    const running = queue.run(() => new Promise(resolve => { release = resolve; }));
    const waiting = queue.run(() => assert.fail('expired work started'));
    const expired = assert.rejects(waiting, { code: 'WORK_QUEUE_EXPIRED' });
    await assert.rejects(queue.run(() => assert.fail()), { code: 'WORK_QUEUE_FULL' });
    await new Promise(resolve => setTimeout(resolve, 25));
    await expired;
    assert.equal(queue.pending.size, 0);
    assert.equal(queue.active, 1);
    release();
    await running;
    await tick();
    assert.equal(queue.rejected, 2);
});

test('a throwing task releases its slot and does not stop later messages', async () => {
    const queue = new WorkQueue({ concurrency: 1 });
    const failed = queue.run(() => { throw new Error('provider failed'); });
    const next = queue.run(() => 42);
    await assert.rejects(failed, /provider failed/);
    assert.equal(await next, 42);
    await tick();
    assert.equal(queue.active, 0);
});
