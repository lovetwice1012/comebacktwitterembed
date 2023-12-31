class fetchResult {
    message = null;
    plan = null;
    result = null;
    error = null;
    time = null;
    settings = null;
    
    constructor(messageClass, plan, result = null, settings = null, error = null) {
        this.message = messageClass;
        this.plan = plan;
        this.result = result;
        this.error = error;
        this.settings = settings;
        this.time = new Date();
    }
}

module.exports = fetchResult;