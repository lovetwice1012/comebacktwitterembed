const setting  = require('./settings.json');
const fs = require('fs');

const args = process.argv.slice(2);

if (args.length < 1) {
    console.log(setting.disable.user);
    console.log("Usage: node checkChannelSetting.js <ChennelId>");
    return;
}

console.log("ChannelId: " + args[0]);
console.log("Checking Channel has been disabled or not...");
console.log("Result: " + setting.disable.channel.includes(parseInt(args[0])));
