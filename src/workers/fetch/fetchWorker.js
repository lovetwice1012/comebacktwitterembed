const fetchResult = require('./fetchResult');
const fetchTask = require('./fetchTask');
const {workerData,parentPort} = require('worker_threads');
const fetch = require('node-fetch');
const mysql = require('mysql');


// MySQL接続情報
const connection = mysql.createConnection({
    host: '192.168.100.22',
    user: 'comebacktwitterembed',
    password: 'bluebird',
    database: 'ComebackTwitterEmbed'
});

// MySQLに接続
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        return;
    }
    console.log('Connected to database');
    parentPort.postMessage("ready");
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
    let url = data.url.replace(/twitter.com/g, "fxapi.lovetwice1012.workers.dev").replace(/x.com/g, "fxapi.lovetwice1012.workers.dev");
    //テスト用
    //let url = data.url.replace(/twitter.com/g, "api.fxtwitter.com").replace(/x.com/g, "api.fxtwitter.com");
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
        let settings = null;
        const sql = 'SELECT * FROM settings WHERE guildId = ?';
        const params = [data.message.guildId];
        connection.query(sql, params, (error, results, fields) => {
            if (error) {
                console.error('Error connecting to database:', error);
                return;
            }
            if (results.length == 0) {
                //設定がない場合はデフォルトの設定を使用する
                const defaultSettings = {
                    guildId: queue.guildId,
                    bannedWords: null,
                    defaultLanguage: 'en-US',
                    editOriginalIfTranslate: 0,
                    sendMediaAsAttachmentsAsDefault: 0,
                    deleteMessageIfOnlyPostedTweetLink: 0,
                    alwaysReply: 0,
                    button_invisible_showMediaAsAttachments: 0,
                    button_invisible_showAttachmentsAsEmbedsImage: 0,
                    button_invisible_translate: 0,
                    button_invisible_delete: 0,
                    button_invisible_reload: 0,
                    button_disabled_users: null,
                    button_disabled_channels: null,
                    button_disabled_roles: null,
                    disable_users: null,
                    disable_channels: null,
                    disable_roles: null,
                    extractBotMessage: 0,
                    extractWebhookMessage: 0,
                    sendMovieAsLink: 0,
                    anonymous_users: null,
                    anonymous_channels: null,
                    anonymous_roles: null,
                };
                const sql = 'INSERT INTO settings SET ?';
                const params = [defaultSettings];
                connection.query(sql, params, (error, results, fields) => {
                    if (error) {
                        console.error('Error connecting to database:', error);
                        return;
                    }
                    console.log('Inserted default settings');
                });
                settings = defaultSettings;
            } else {
                //設定がある場合はそれを使用する
                settings = results[0];
            }
            parentPort.postMessage(new fetchResult(data.message, data.plan, result, settings, data.quotedCount));
        });
        
    }).catch((error) => {
        parentPort.postMessage(new fetchResult(data.message, data.plan, null, null, null, error));
    });
});





