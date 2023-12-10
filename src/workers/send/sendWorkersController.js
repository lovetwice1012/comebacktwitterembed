const sendWorkersService = require('./sendWorkersService');
class sendWorkersController {
    constructor(sendWorkersServiceInstance = null) {
        if (sendWorkersServiceInstance == null) {
            sendWorkersServiceInstance = new sendWorkersService();
        }
        this.sendWorkersService = sendWorkersServiceInstance;
    }
    
    initialize() {
        this.sendWorkersService.initialize();
    }

    getQueueLength() {
        return this.sendWorkersService.getQueueLength();
    }

    get_workers() {
        return this.sendWorkersService.get_workers();
    }

    get_total_workers() {
        return this.sendWorkersService.get_total_workers();
    }

    get_queueManager() {
        return this.sendWorkersService.get_queueManager();
    }

    set_queueManager(queueManager) {
        this.sendWorkersService.set_queueManager(queueManager);
    }

    set_total_workers(total_workers) {
        this.sendWorkersService.set_total_workers(total_workers);
    }
}

module.exports = sendWorkersController;