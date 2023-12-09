const fetchWorkersController = require('./fetch/fetchWorkersController');
const fetchWorkersControllerInstance = new fetchWorkersController();

const sendWorkersController = require('./send/sendWorkersController');
const sendWorkersControllerInstance = new sendWorkersController();

class workersManager {
    constructor(fetchWorkersController = null, sendWorkersController = null) {
        if (fetchWorkersController == null) {
            fetchWorkersController = fetchWorkersControllerInstance;
        }
        if (sendWorkersController == null) {
            sendWorkersController = sendWorkersControllerInstance;
        }
        this.fetchWorkersController = fetchWorkersController;
        this.sendWorkersController = sendWorkersController;
    }
}

module.exports = workersManager;