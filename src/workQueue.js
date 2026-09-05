'use strict';

const { positiveInteger } = require('./databasePool');
const { AsyncResource } = require('async_hooks');

class WorkQueue {
    constructor({ concurrency = 32, maxPending = 512, maxWaitMs = 30000 } = {}) {
        this.concurrency = concurrency;
        this.maxPending = maxPending;
        this.maxWaitMs = maxWaitMs;
        this.active = 0;
        this.pending = new Set();
        this.completed = 0;
        this.rejected = 0;
    }

    overload(code) {
        this.rejected++;
        return Object.assign(new Error('Message processing capacity exceeded'), { code });
    }

    run(work) {
        if (this.active >= this.concurrency && this.pending.size >= this.maxPending) {
            return Promise.reject(this.overload('WORK_QUEUE_FULL'));
        }
        return new Promise((resolve, reject) => {
            const item = { work: AsyncResource.bind(work), resolve, reject, timer: null };
            if (this.active < this.concurrency) this.start(item);
            else {
                this.pending.add(item);
                item.timer = setTimeout(() => {
                    this.pending.delete(item);
                    reject(this.overload('WORK_QUEUE_EXPIRED'));
                }, this.maxWaitMs);
                item.timer.unref?.();
            }
        });
    }

    start(item) {
        clearTimeout(item.timer);
        this.active++;
        // Never release a slot by racing a timeout against work that is still
        // running: that would allow timed-out downloads to grow without bound.
        Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
            this.active--;
            this.completed++;
            const next = this.pending.values().next().value;
            if (next) {
                this.pending.delete(next);
                this.start(next);
            }
        });
    }

    snapshot() {
        return { active: this.active, pending: this.pending.size, completed: this.completed, rejected: this.rejected };
    }
}

const messageWorkQueue = new WorkQueue({
    concurrency: positiveInteger(process.env.BOT_MESSAGE_CONCURRENCY, 32, 256),
    maxPending: positiveInteger(process.env.BOT_MESSAGE_QUEUE_LIMIT, 512, 10000),
    maxWaitMs: positiveInteger(process.env.BOT_MESSAGE_QUEUE_WAIT_MS, 30000, 300000),
});

module.exports = { WorkQueue, messageWorkQueue };
