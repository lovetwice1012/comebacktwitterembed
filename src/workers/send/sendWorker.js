const {workerData,parentPort} = require('worker_threads');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField} = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],shards:'auto' });
const config = require('../../../config.json');
const embed = require('./embed');
const { databaseManager, columnBuilder, commandBuilder } = require('easy-sql-builder');
const db = new databaseManager();

client.on(Events.CLIENT_READY, () => {
    console.log('Client is ready!');
    parentPort.postMessage({status:'ready'});
});

parentPort.on('message', async (data) => {
    /*
        data.message = discord incoming message class(../../messages/postMessage.js or ../../messages/editMessage.js);
        data.plan = plan;
        data.result = fetchedTweetData;
        data.error = always null;
        data.time = Date object;
    */ 
    //埋め込み送信処理をここに記述
});

client.login(config.token);