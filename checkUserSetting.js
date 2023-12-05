const setting  = require('./setting.json');
const fs = require('fs');

const args = process.argv.slice(2);

if (args.length < 1) {
    console.log("Usage: node checkUserSetting.js <username>");
    return;
}

console.log("UserId: " + args[0]);
console.log("Checking user has been disabled or not...");
console.log("User Disabled: " + setting.disable.users.includes(parseInt(args[0])));
