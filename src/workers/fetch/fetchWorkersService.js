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

    async initialize(client) {
        if(this.queueManager == null) throw new Error("queueManager is required");
        if(this.workers.length != 0) throw new Error("Workers already initialized");
        for(let i = 0; i < this.total_workers; i++){
            let workerInstance = new Worker("./src/workers/fetch/fetchWorker.js", {workerData: {workerId: i}});
            workerInstance.on("message",async  (data) => {
                if(typeof data === "string" && data === "ready") {
                    if(this.queue.length == 0) return workerInstance.postMessage(new fetchTask(null, null, "Standby"));
                    return workerInstance.postMessage(this.queue.shift());
                }
                if(data.error) {
                    console.error(data.error);
                    data.message = await client.channels.cache.get(data.message.channelId).messages.cache.get(data.message.id);
                    const myReactions = data.message.reactions.cache.filter(reaction => reaction.users.cache.has(client.user.id));
                    for (const reaction of myReactions.values()) {
                        await reaction.users.remove(client.user.id);
                    }
                    data.message.react("❌")
                    return workerInstance.postMessage(this.queue.shift());
                }
                this.queueManager.add_to_queue(data, data.plan);
                if(this.queue.length == 0) return workerInstance.postMessage(new fetchTask(null, null, "Standby"));
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

    add_queue(message, plan, url, quotedCount = 0) {
        this.queue.push(new fetchTask(message, plan, url, quotedCount));
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