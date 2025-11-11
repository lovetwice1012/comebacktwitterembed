const fetchResult = require('./fetchResult');
const fetchTask = require('./fetchTask');
const {workerData,parentPort} = require('worker_threads');
const fetch = require('node-fetch');

// Workerの準備完了を通知
parentPort.postMessage("ready");

parentPort.on("message", (data) => {
    if(data === undefined) return parentPort.postMessage("ready");
    if(data.url === "Standby"){
        setTimeout(() => {
            parentPort.postMessage("ready");
        }, 100);
        return;
    }
    
    // URLを変換
    let url = data.url.replace(/twitter.com/g, "api.fxtwitter.com").replace(/x.com/g, "api.fxtwitter.com");
    
    // ツイートデータを取得（DB処理は削除）
    fetch(url, {
        method: "GET",
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/90.0.4430.212 Safari/537.36"
        }
    }).then((response) => {
        if(!response.ok) throw new Error(`Fetch error: ${response.status} ${response.statusText}`);
        return response.json();
    }).then((json) => {
        // 結果を返す（settingsはnullで返し、メインプロセスで取得）
        parentPort.postMessage(new fetchResult(data.message, data.plan, json, null, data.quotedCount));
    }).catch((error) => {
        if(data.retryCount == undefined) data.retryCount = 0;
        data.retryCount++;
        parentPort.postMessage(new fetchResult(data.message, data.plan, null, null, null, {error:error, data:data, count: data.retryCount}));
    });
});





