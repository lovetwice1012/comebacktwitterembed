const {workerData,parentPort} = require('worker_threads');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField} = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],shards:'auto' });
const config = require('../../../config.json');
const embed = require('./embed');
const { databaseManager, columnBuilder, commandBuilder } = require('easy-sql-builder');
const db = new databaseManager();

client.on(Events.ClientReady, () => {
    console.log('Client is ready!');
    parentPort.postMessage('ready');
});

parentPort.on('message', async (data) => {
    //キューに何も入っていないときにはStandbyが送られてくるので0.1秒待ってからreadyを送信する
    //送信処理終了後もreadyを送信する
    if(data == "Standby") {
        setTimeout(() => {
            parentPort.postMessage('ready');
        }, 100);
    };
    //data.resultがundefinedのときにはreadyを送信する
    if(data.result === undefined) return parentPort.postMessage('ready');
    /*
        data.message = discord incoming message class(../../messages/postMessage.js or ../../messages/editMessage.js);
        data.plan = plan;
        data.result = fetchedTweetData;
        data.error = always null;
        data.time = Date object;
    */ 
    //埋め込み送信処理をここに記述

    parentPort.postMessage('ready');
});

client.login(config.token);