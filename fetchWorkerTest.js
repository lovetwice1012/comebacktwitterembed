const tweets = require('./tweet.json');
const fetchWorkersService = require('./src/workers/fetch/fetchWorkersService');
const queueManager = require('./src/queue/queueManager');
const queueManagerInstance = new queueManager();
const fetchWorkersServiceInstance = new fetchWorkersService(queueManagerInstance, null, 144);


console.log(tweets.length);

for(let i = 0; i < tweets.length; i++){
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.normal, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.normal, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.normal, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
}

fetchWorkersServiceInstance.initialize();