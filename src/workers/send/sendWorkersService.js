const {Worker} = require("worker_threads");

class sendWorkersService {
    constructor(queueManagerClass = null, workers = null, total_workers = 24) {
        if (workers == null) {
            workers = [];
        }
        this.workers = workers;
        this.total_workers = total_workers;
        this.queueManager = queueManagerClass;
    }

    initialize() {
        if(this.queueManager == null) throw new Error("queueManager is required");
        if(this.workers.length != 0) throw new Error("Workers already initialized");
        for(let i = 0; i < this.total_workers; i++){
            let workerInstance = new Worker("./src/workers/send/sendWorker.js", {workerData: {workerId: i}});
            workerInstance.on("message", (data) => {
                let next = this.queueManager.get_next();
                if(typeof data === "string" && data === "ready") {
                    if(next === null) return workerInstance.postMessage("Standby");
                    return workerInstance.postMessage(next);
                }
                console.log(data);
            });
            workerInstance.on("error", (error) => {
                throw new Error(error);
            });
            workerInstance.on("exit", (code) => {
                if(code != 0) throw new Error(`Worker stopped with exit code ${code}`);
                console.log("Worker stopped");
            });
            this.workers.push(workerInstance);
        }
    }

    getQueueLength() {
        return this.queueManager.getQueueLength();
    }

    get_workers() {
        return this.workers;
    }

    get_total_workers() {
        return this.total_workers;
    }

    get_queueManager() {
        return this.queueManager;
    }

    set_queueManager(queueManager) {
        this.queueManager = queueManager;
    }

    set_total_workers(total_workers) {
        this.total_workers = total_workers;
    }
}

module.exports = sendWorkersService;