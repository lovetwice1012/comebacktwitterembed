class fetchResult {
    constructor(messageClass, plan, result = null, error = null) {
        this.message = messageClass;
        this.plan = plan;
        this.result = result;
        this.error = error;
        this.time = new Date();
    }
}

module.exports = fetchResult;