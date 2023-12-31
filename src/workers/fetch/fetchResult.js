class fetchResult {
    message = null;
    plan = null;
    result = null;
    error = null;
    time = null;
    settings = null;
    quotedCount = 0;
    constructor(messageClass, plan, result = null, settings = null, quotedCount = 0, error = null) {
        this.message = messageClass;
        this.plan = plan;
        this.result = result;
        this.error = error;
        this.settings = settings;
        this.quotedCount = quotedCount;
        this.time = new Date();
    }
}

module.exports = fetchResult;