const tweets = require('./tweet.json');
const fetchWorkersService = require('./src/workers/fetch/fetchWorkersService');
const queueManager = require('./src/queue/queueManager');
const queueManagerInstance = new queueManager();
const fetchWorkersServiceInstance = new fetchWorkersService(queueManagerInstance, null, 32);


console.log(tweets.length);

for(let i = 0; i < tweets.length; i++){
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.normal, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.premium, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
    fetchWorkersServiceInstance.add_queue({content:tweets[i]}, queueManagerInstance.plan.basic, tweets[i]);
}

fetchWorkersServiceInstance.initialize();

setTimeout(() => {
    console.log(queueManagerInstance.getQueueLength());
    console.log("Normal:"+queueManagerInstance.getQueueLengthByPlan(queueManagerInstance.plan.normal) + " Basic:"+queueManagerInstance.getQueueLengthByPlan(queueManagerInstance.plan.basic) + " Premium:"+queueManagerInstance.getQueueLengthByPlan(queueManagerInstance.plan.premium));
    while(queueManagerInstance.getQueueLength() > 0){
        queueManagerInstance.get_next()
        console.log("Normal:"+queueManagerInstance.getQueueLengthByPlan(queueManagerInstance.plan.normal) + " Basic:"+queueManagerInstance.getQueueLengthByPlan(queueManagerInstance.plan.basic) + " Premium:"+queueManagerInstance.getQueueLengthByPlan(queueManagerInstance.plan.premium));
    }
}, 20000);