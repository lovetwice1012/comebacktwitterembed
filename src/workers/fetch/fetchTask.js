class fetchTask {
    construct(message, url, plan) {
        this.message = message;
        this.url = url;
        this.plan = plan;
        this.time = new Date();
    }
}

module.exports = fetchTask;