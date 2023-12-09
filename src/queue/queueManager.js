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
                if (this.queue.normal.length > 0) {
                    next = this.queue.premium.shift();
                }
            case 3:
            case 4:
                if (this.queue.basic.length > 0) {
                    next = this.queue.basic.shift();
                }
            case 5:
                if (this.queue.premium.length > 0) {
                    next = this.queue.normal.shift();
                }
            default:
                this.processed_count++;
                if (this.processed_count > 5) {
                    this.processed_count = 0;
                }
                break;
            }
        return next;
    }
}

module.exports = queueManager;