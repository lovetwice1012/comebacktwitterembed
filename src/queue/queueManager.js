const queue = require('./queue');
const plan = require('../plan/plan');
class queueManager {
    constructor(queueClass = null) {
        if (queueClass == null) {
            queueClass = new queue();
        }
        this.processed_count = 0;
        this.plan = new plan();
        this.queue = queueClass;
    }

    add_to_queue(data, plan) {
        switch (plan) {
            case this.plan.normal:
                this.queue.normal.push(data);
                break;
            case this.plan.basic:
                this.queue.basic.push(data);
                break;
            case this.plan.premium:
                this.queue.premium.push(data);
                break;
        }
    }

    get_next() {
        let next = null;
        switch (this.processed_count) {
            case 0:
            case 1:
            case 2:
                if (this.queue.premium.length > 0) {
                    next = this.queue.premium.shift();
                }else if (this.queue.basic.length > 0) {
                    next = this.queue.basic.shift();
                }else if (this.queue.normal.length > 0) {
                    next = this.queue.normal.shift();
                }
                break;
            case 3:
            case 4:
                if (this.queue.basic.length > 0) {
                    next = this.queue.basic.shift();
                } else if (this.queue.normal.length > 0) {
                    next = this.queue.normal.shift();
                }
                break;
            case 5:
                if (this.queue.normal.length > 0) {
                    next = this.queue.normal.shift();
                }
                break;
        }
        this.processed_count++;
        if (this.processed_count > 5) {
            this.processed_count = 0;
        }
        return next;
    }

    get_queue() {
        return this.queue;
    }

    getQueueLength() {
        return this.queue.normal.length + this.queue.basic.length + this.queue.premium.length;
    }

    getQueueLengthByPlan(plan) {
        switch (plan) {
            case this.plan.normal:
                return this.queue.normal.length;
            case this.plan.basic:
                return this.queue.basic.length;
            case this.plan.premium:
                return this.queue.premium.length;
        }
    }

    getProcessedCount() {
        return this.processed_count;
    }

    setProcessedCount(processed_count) {
        this.processed_count = processed_count;
    }
}

module.exports = queueManager;