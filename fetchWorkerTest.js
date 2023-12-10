const tweets = require('./tweet.json');
const workersManager = require('./src/workers/workersManager');
const queueManager = require('./src/queue/queueManager');
const queueManagerInstance = new queueManager();
const fetchWorkersServiceInstance = new workersManager(queueManagerInstance);


console.log(tweets.length);

fetchWorkersServiceInstance.set_FetchTotalWorkers(64);
fetchWorkersServiceInstance.set_SendTotalWorkers(64);

fetchWorkersServiceInstance.initialize();

for(let i = 0; i < tweets.length; i++){
    fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.normal, tweets[i]);
    fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
    fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
}

setInterval(() => {
    for(let i = 0; i < tweets.length; i++){
        fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.normal, tweets[i]);
        fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
        fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
        fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
        fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
        fetchWorkersServiceInstance.add_FetchQueue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
    }

    console.log(fetchWorkersServiceInstance.get_FetchQueueLength());
}  , 20000);