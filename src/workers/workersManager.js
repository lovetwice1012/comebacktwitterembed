const queue = require('../queue/queue');
const fetchWorkersController = require('./fetch/fetchWorkersController');
const fetchWorkersControllerInstance = new fetchWorkersController();

const sendWorkersController = require('./send/sendWorkersController');
const sendWorkersControllerInstance = new sendWorkersController();

class workersManager {
    constructor(queueManager, fetchWorkersController = null, sendWorkersController = null) {
        if (queueManager == null) {
            throw new Error('queueManager is required');
        }
        if (fetchWorkersController == null) {
            fetchWorkersController = fetchWorkersControllerInstance;
        }
        if (sendWorkersController == null) {
            sendWorkersController = sendWorkersControllerInstance;
        }
        this.queueManager = queueManager;
        this.fetchWorkersController = fetchWorkersController;
        this.sendWorkersController = sendWorkersController;
        this.fetchWorkersController.set_queueManager(queueManager);
        this.sendWorkersController.set_queueManager(queueManager);
    }

    initialize() {
        this.fetchWorkersController.initialize();
        this.sendWorkersController.initialize();
    }

    add_FetchQueue(message, plan, url) {
        this.fetchWorkersController.add_queue(message, plan, url);
    }

    add_SendQueue(message, plan, url) {
        this.sendWorkersController.add_queue(message, plan, url);
    }

    get_FetchQueue() {
        return this.fetchWorkersController.get_queue();
    }

    get_SendQueue() {
        return this.sendWorkersController.get_queue();
    }

    get_FetchQueueLength() {
        return this.fetchWorkersController.getQueueLength();
    }

    get_SendQueueLength() {
        return this.sendWorkersController.getQueueLength();
    }

    get_FetchWorkers() {
        return this.fetchWorkersController.get_workers();
    }

    get_SendWorkers() {
        return this.sendWorkersController.get_workers();
    }

    get_FetchTotalWorkers() {
        return this.fetchWorkersController.get_total_workers();
    }

    get_SendTotalWorkers() {
        return this.sendWorkersController.get_total_workers();
    }

    get_FetchQueueManager() {
        return this.fetchWorkersController.get_queueManager();
    }

    get_SendQueueManager() {
        return this.sendWorkersController.get_queueManager();
    }

    set_FetchTotalWorkers(queueManager) {
        this.fetchWorkersController.set_total_workers(queueManager);
    }

    set_SendTotalWorkers(queueManager) {
        this.sendWorkersController.set_total_workers(queueManager);
    }

    set_FetchTotalWorkers(total_workers) {
        this.fetchWorkersController.set_total_workers(total_workers);
    }

    set_SendTotalWorkers(total_workers) {
        this.sendWorkersController.set_total_workers(total_workers);
    }

    get_FetchWorkersController() {
        return this.fetchWorkersController;
    }

    get_SendWorkersController() {
        return this.sendWorkersController;
    }

    set_FetchWorkersController(fetchWorkersController) {
        this.fetchWorkersController = fetchWorkersController;
    }

    set_SendWorkersController(sendWorkersController) {
        this.sendWorkersController = sendWorkersController;
    }
}

module.exports = workersManager;