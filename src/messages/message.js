class message {
    message = null;
    plan = null;
    result = null;
    error = null;
    time = null;
    
    constructor(messageClass, plan, result = null, error = null) {
        this.message = messageClass;
        this.plan = plan;
        this.result = result;
        this.error = error;
        this.time = new Date();
    }
    
    send(message){
        this.message.channel.send(message);
    }
}

module.exports = message;