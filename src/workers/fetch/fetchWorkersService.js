const {Worker} = require("worker_threads");
const fetchResult = require("./fetchResult");
const fetchTask = require("./fetchTask");
const SettingsService = require("../../database/settingsService");


class fetchWorkersService {
    constructor(workers = null, total_workers = 24) {
        if (workers == null) {
            workers = [];
        }
        this.workers = workers;
        this.donorWorkers = [];      // 寄付者専用Worker
        this.normalWorkers = [];     // 一般ユーザー用Worker
        this.donorQueue = [];        // 寄付者用キュー
        this.normalQueue = [];       // 一般用キュー
        this.total_workers = total_workers;
        this.processResultCallback = null;
    }

    async initialize(client, processResultCallback) {
        if(this.workers.length != 0) throw new Error("Workers already initialized");
        this.processResultCallback = processResultCallback;
        
        // Worker数の配分を計算
        const donorWorkerCount = Math.floor(this.total_workers * 0.33); // 33%を寄付者用
        const normalWorkerCount = this.total_workers - donorWorkerCount; // 残りを一般用
        
        console.log(`Initializing ${donorWorkerCount} donor workers and ${normalWorkerCount} normal workers...`);
        
        // 寄付者専用Workerの作成
        for(let i = 0; i < donorWorkerCount; i++){
            let workerInstance = new Worker("./src/workers/fetch/fetchWorker.js", {workerData: {workerId: `donor-${i}`}});
            this.setupWorkerHandlers(workerInstance, client, true); // true = 寄付者用
            this.donorWorkers.push(workerInstance);
            this.workers.push(workerInstance);
        }
        
        // 一般ユーザー用Workerの作成
        for(let i = 0; i < normalWorkerCount; i++){
            let workerInstance = new Worker("./src/workers/fetch/fetchWorker.js", {workerData: {workerId: `normal-${i}`}});
            this.setupWorkerHandlers(workerInstance, client, false); // false = 一般用
            this.normalWorkers.push(workerInstance);
            this.workers.push(workerInstance);
        }
    }
    
    setupWorkerHandlers(workerInstance, client, isDonor) {
        workerInstance.on("message", async (data) => {
            if(typeof data === "string" && data === "ready") {
                // Workerが準備完了したら、対応するキューから次のタスクを渡す
                const queue = isDonor ? this.donorQueue : this.normalQueue;
                if(queue.length == 0) return workerInstance.postMessage(new fetchTask(null, null, "Standby"));
                return workerInstance.postMessage(queue.shift());
            }
            if(data.error) {
                if(data.error.count < 6) return workerInstance.postMessage({message: data.error.data.message, plan: data.error.data.plan, url: data.error.data.url, quotedCount: data.error.data.quotedCount});
                console.error(data.error);
                data.message = await client.channels.cache.get(data.message.channelId).messages.cache.get(data.message.id);
                const myReactions = data.message.reactions.cache.filter(reaction => reaction.users.cache.has(client.user.id));
                for (const reaction of myReactions.values()) {
                    await reaction.users.remove(client.user.id).catch((error) => {});
                }
                data.message.react("❌").catch((error) => {});
                const queue = isDonor ? this.donorQueue : this.normalQueue;
                return workerInstance.postMessage(queue.shift());
            }
            
            // Workerからの結果を受け取り、設定データを取得してからコールバックを呼び出す
            if(this.processResultCallback) {
                try {
                    // キャッシュ優先で設定を取得
                    const settings = await SettingsService.getSettings(data.message.guildId);
                    data.settings = settings;
                    
                    // コールバックで処理
                    this.processResultCallback(data);
                } catch (error) {
                    console.error('設定取得エラー:', error);
                    // エラー時もデフォルト設定で続行
                    this.processResultCallback(data);
                }
            }
            
            const queue = isDonor ? this.donorQueue : this.normalQueue;
            if(queue.length == 0) return workerInstance.postMessage(new fetchTask(null, null, "Standby"));
            return workerInstance.postMessage(queue.shift());
        });
        workerInstance.on("error", (error) => {
            throw new Error(error);
        });
        workerInstance.on("exit", (code) => {
            if(code != 0) throw new Error(`Worker stopped with exit code ${code}`);
            console.log("Worker stopped");
        });
    }

    add_queue(message, plan, url, quotedCount = 0) {
        const task = new fetchTask(message, plan, url, quotedCount);
        
        // plan が 1 以上（basic または premium）なら寄付者キューへ
        if(plan >= 1) {
            this.donorQueue.push(task);
        } else {
            // plan が 0（normal）なら一般キューへ
            this.normalQueue.push(task);
        }
    }

    get_queue() {
        return {
            donor: this.donorQueue,
            normal: this.normalQueue,
            total: this.donorQueue.length + this.normalQueue.length
        };
    }

    getQueueLength() {
        return this.donorQueue.length + this.normalQueue.length;
    }
    
    getDonorQueueLength() {
        return this.donorQueue.length;
    }
    
    getNormalQueueLength() {
        return this.normalQueue.length;
    }

    get_workers() {
        return this.workers;
    }

    get_total_workers() {
        return this.total_workers;
    }

    set_total_workers(total_workers) {
        this.total_workers = total_workers;
    }
}

module.exports = fetchWorkersService;