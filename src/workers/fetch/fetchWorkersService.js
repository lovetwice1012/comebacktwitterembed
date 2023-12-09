const {Worker} = require("worker_threads");
const fetchResult = require("./fetchResult");
const fetchTask = require("./fetchTask");


class fetchWorkersService {
    constructor(queueManagerClass = null, workers = null, total_workers = 24) {
        if (workers == null) {
            workers = [];
        }
        this.workers = workers;
        this.total_workers = total_workers;
        this.queueManager = queueManagerClass;
        this.queue = [];
    }

    initialize() {
        if(this.queueManager == null) throw new Error("queueManager is required");
        if(this.workers.length != 0) throw new Error("Workers already initialized");
        for(let i = 0; i < this.total_workers; i++){
            let workerInstance = new Worker("./src/workers/fetch/fetchWorker.js");
            workerInstance.on("message", (data) => {
                if(typeof data === "string" && data === "ready") {
                    if(this.queue.length == 0) return workerInstance.postMessage(new fetchTask(null, null, "Standby"));
                    return workerInstance.postMessage(this.queue.shift());
                }
                if(data.error) {
                    console.error(data.error);
                    return workerInstance.postMessage(this.queue.shift());
                }
                this.queueManager.add_to_queue(data.result, data.plan);
                console.log(`[${data.time.toLocaleString()}] ${data.result.tweet.text}`);
                return workerInstance.postMessage(this.queue.shift());
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

    add_queue(message, plan, url) {
        this.queue.push(new fetchTask(message, plan, url));
    }

    get_queue() {
        return this.queue;
    }

    getQueueLength() {
        return this.queue.length;
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

module.exports = fetchWorkersService;