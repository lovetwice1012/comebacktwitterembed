class fetchTask {
    message = null;
    url = null;
    plan = null;
    time = null;
    quotedCount = 0;
    constructor(message, plan, url, quotedCount = 0) {
        this.message = message;
        this.url = url;
        this.plan = plan;
        this.time = new Date();
        this.quotedCount = quotedCount;
    }
}

module.exports = fetchTask;