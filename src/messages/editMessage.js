const message = require('./message');
class editMessage extends message {
    constructor(messageClass, plan, result = null, error = null) {
        super(messageClass, plan, result, error);
    }
    
    send(message){
        this.message.edit(message);
    }
}

module.exports = editMessage;