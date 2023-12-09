const fetchResult = require('./fetchResult');
const fetchTask = require('./fetchTask');
const {workerData,parentPort} = require('worker_threads');
const fetch = require('node-fetch');

process.on("uncaughtException", (error) => {
    console.error(error);
});

parentPort.on("message", (data) => {
    if(data === undefined) return parentPort.postMessage("ready");
    if(data.url === "Standby"){
        setTimeout(() => {
            parentPort.postMessage("ready");
        }, 100);
        return;
    }
    let result = null;
    //let url = data.url.replace(/twitter.com/g, "fxapi.lovetwice1012.workers.dev").replace(/x.com/g, "fxapi.lovetwice1012.workers.dev");
    let url = data.url.replace(/twitter.com/g, "api.fxtwitter.com").replace(/x.com/g, "api.fxtwitter.com");
    fetch(url, {
        method: "GET",
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/90.0.4430.212 Safari/537.36"
        }
    }).then((response) => {
        if(!response.ok) throw new Error(`Fetch error: ${response.status} ${response.statusText}`);
        return response.json();
    }).then((json) => {
        result = json;
        parentPort.postMessage(new fetchResult(data.message, data.plan, result));
    }).catch((error) => {
        parentPort.postMessage(new fetchResult(data.message, data.plan, null, error));
    });
});

parentPort.postMessage("ready");



