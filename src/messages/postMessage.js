const message = require('./message');
class postMessage extends message {
    constructor(messageClass, plan, result = null, error = null) {
        super(messageClass, plan, result, error);
    }

    send(message){
        this.message.channel.send(message);
    }
}

module.exports = postMessage;