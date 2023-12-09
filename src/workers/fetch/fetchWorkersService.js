const worker = require("worker_threads");
const fetchResult = require("./fetchResult");
const fetchTask = require("./fetchTask");


class fetchWorkersService {
    constructor(queueManagerClass = null, workers = null, total_workers = 24) {
        if (queueManagerClass == null) throw new Error("Queue manager not initialized");
        if (workers == null) {
            workers = [];
        }
        this.workers = workers;
        this.total_workers = total_workers;
        this.queueManager = queueManagerClass;
        this.queue = [];
    }

    initialize() {
        if(this.workers.length != 0) throw new Error("Workers already initialized");
        for(let i = 0; i < this.total_workers; i++){
            let worker = new worker("./src/workers/fetch/fetchWorker.js");
            worker.on("message", (data) => {
                if(!(data instanceof fetchResult)) {
                    if(this.queue.length == 0) return worker.postMessage(new fetchTask(nul, null, "Standby"));
                    return worker.postMessage(this.queue.shift());
                }
                if(data.error) throw new Error(data.error);
                this.queueManager.add_to_queue(data.result, data.plan);
            });
            worker.on("error", (error) => {
                throw new Error(error);
            });
            worker.on("exit", (code) => {
                if(code != 0) throw new Error(`Worker stopped with exit code ${code}`);
            });
            this.workers.push(worker);
        }
    }

    add_queue(message, plan, url) {
        this.queue.push(new fetchTask(message, plan, url));
    }
}

module.exports = fetchWorkersService;