const setting  = require('./settings.json');
const fs = require('fs');

const args = process.argv.slice(2);

if (args.length < 1) {
    console.log("Usage: node checkGuildSetting.js <GuildId>");
}

console.log("GuildId: " + args[0]);

// check guild setting
//default language
if (!setting.defaultLanguage[args[0]]) {
    console.log("defaultLanguage not found");
}

console.log("defaultLanguage: " + setting.defaultLanguage[args[0]]);

//banned words

if (!setting.bannedWords[args[0]]) {
    console.log("bannedWords not found");
}

console.log("bannedWords: " + setting.bannedWords[args[0]]);

//edit original if translate

if (!setting.editOriginalIfTranslate[args[0]]) {
    console.log("editOriginalIfTranslate not found");
}

console.log("editOriginalIfTranslate: " + setting.editOriginalIfTranslate[args[0]]);

/*
        "sendMediaAsAttachmentsAsDefault": {},
        "deletemessageifonlypostedtweetlink": {},
        "alwaysreplyifpostedtweetlink": {},
        "button_invisible": {},
        "button_disabled": {},
        "extract_bot_message": {},
        "quote_repost_do_not_extract": {},
*/

//sendMediaAsAttachmentsAsDefault
if (!setting.sendMediaAsAttachmentsAsDefault[args[0]]) {
    console.log("sendMediaAsAttachmentsAsDefault not found");
}

console.log("sendMediaAsAttachmentsAsDefault: " + setting.sendMediaAsAttachmentsAsDefault[args[0]]);

//deletemessageifonlypostedtweetlink
if (!setting.deletemessageifonlypostedtweetlink[args[0]]) {
    console.log("deletemessageifonlypostedtweetlink not found");
}

console.log("deletemessageifonlypostedtweetlink: " + setting.deletemessageifonlypostedtweetlink[args[0]]);  

//alwaysreplyifpostedtweetlink

if (!setting.alwaysreplyifpostedtweetlink[args[0]]) {
    console.log("alwaysreplyifpostedtweetlink not found");
}

console.log("alwaysreplyifpostedtweetlink: " + setting.alwaysreplyifpostedtweetlink[args[0]]);

//button_invisible

if (!setting.button_invisible[args[0]]) {
    console.log("button_invisible not found");
}

console.log("button_invisible: " );
console.log(setting.button_invisible[args[0]])

//button_disabled

if (!setting.button_disabled[args[0]]) {
    console.log("button_disabled not found");
}

console.log("button_disabled: ");
console.log(setting.button_disabled[args[0]])
//extract_bot_message

if (!setting.extract_bot_message[args[0]]) {
    console.log("extract_bot_message not found");
}

console.log("extract_bot_message: " + setting.extract_bot_message[args[0]]);

//quote_repost_do_not_extract

if (!setting.quote_repost_do_not_extract[args[0]]) {
    console.log("quote_repost_do_not_extract not found");
}

console.log("quote_repost_do_not_extract: " + setting.quote_repost_do_not_extract[args[0]]);

