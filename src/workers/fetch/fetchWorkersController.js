const fetchWorkersService = require('./fetchWorkersService');
const fetchWorkersServiceInstance = new fetchWorkersService();

class fetchWorkersController {
    constructor(fetchWorkersService = null) {
        if (fetchWorkersService == null) {
            fetchWorkersService = fetchWorkersServiceInstance;
        }
        this.fetchWorkersService = fetchWorkersService;
    }
    
    initialize() {
        this.fetchWorkersService.initialize();
    }
    
    add_queue(message, plan, url) {
        this.fetchWorkersService.add_queue(message, plan, url);
    }

    get_queue() {
        return this.fetchWorkersService.get_queue();
    }

    getQueueLength() {
        return this.fetchWorkersService.getQueueLength();
    }

    get_workers() {
        return this.fetchWorkersService.get_workers();
    }

    get_total_workers() {
        return this.fetchWorkersService.get_total_workers();
    }

    get_queueManager() {
        return this.fetchWorkersService.get_queueManager();
    }

    set_queueManager(queueManager) {
        this.fetchWorkersService.set_queueManager(queueManager);
    }

    set_total_workers(total_workers) {
        this.fetchWorkersService.set_total_workers(total_workers);
    }
}

module.exports = fetchWorkersController;