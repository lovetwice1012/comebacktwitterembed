class fetchTask {
    message = null;
    url = null;
    plan = null;
    time = null;
    constructor(message, plan, url) {
        this.message = message;
        this.url = url;
        this.plan = plan;
        this.time = new Date();
    }
}

module.exports = fetchTask;