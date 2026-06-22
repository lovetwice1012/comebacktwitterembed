'use strict';
const fs = require('fs');
const FILE = 'index.js';
const src = fs.readFileSync(FILE, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';

function findMatchingBrace(content, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < content.length; i++) {
        const ch = content[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            i++;
            while (i < content.length) {
                if (content[i] === '\\') { i += 2; continue; }
                if (content[i] === quote) break;
                if (quote === '`' && content[i] === '$' && content[i + 1] === '{') {
                    i += 2;
                    let td = 1;
                    while (i < content.length && td > 0) {
                        if (content[i] === '{') td++;
                        else if (content[i] === '}') td--;
                        i++;
                    }
                    continue;
                }
                i++;
            }
            continue;
        }
        if (ch === '/' && content[i + 1] === '/') {
            while (i < content.length && content[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && content[i + 1] === '*') {
            i += 2;
            while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
            i += 1;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    throw new Error('No matching brace');
}

function findFunctionBlock(content, signature) {
    const s = content.indexOf(signature);
    if (s < 0) throw new Error('Function not found: ' + signature.slice(0, 80));
    const open = content.indexOf('{', s);
    const close = findMatchingBrace(content, open);
    return { start: s, end: close + 1, body: content.slice(s, close + 1) };
}

function findClientOnBlock(content, headerLine, fromIdx) {
    const s = content.indexOf(headerLine, fromIdx || 0);
    if (s < 0) throw new Error('Handler not found: ' + headerLine);
    const open = content.indexOf('{', s);
    const close = findMatchingBrace(content, open);
    let i = close + 1;
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] !== ')') throw new Error('Expected ) after handler body');
    i++;
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] === ';') i++;
    return { start: s, end: i, body: content.slice(s, i) };
}

function indentBlock(text, spaces) {
    const pad = ' '.repeat(spaces);
    return text.split(/\r?\n/).map(l => l.length ? pad + l : l).join(eol);
}

const twStart = src.indexOf('async function fetchTweetJson(newUrl) {');
if (twStart < 0) throw new Error('twStart');
const sendTweetBlock = findFunctionBlock(src, 'async function sendTweetEmbed(message, url, quoted = false, parent = null, saved = false, depth = 0) {');
const twitterCode = src.slice(twStart, sendTweetBlock.end);

const shouldIgnoreFn = findFunctionBlock(src, 'function shouldIgnoreMessage(message) {');
const isMsgDisabledFn = findFunctionBlock(src, 'function isMessageDisabledForUserOrChannel(message) {');

const readyBlock = findClientOnBlock(src, "client.on('ready', () => {");
const mc1Block = findClientOnBlock(src, 'client.on(Events.MessageCreate, async message => {');
const mc2Block = findClientOnBlock(src, 'client.on(Events.MessageCreate, async (message) => {');
const ic1Block = findClientOnBlock(src, 'client.on(Events.InteractionCreate, async (interaction) => {');
const ic2Block = findClientOnBlock(src, 'client.on(Events.InteractionCreate, async (interaction) => {', ic1Block.end);

function n(s) { return s.replace(/\n/g, eol); }

const TWITTER_JS = n("'use strict';\n\n"
    + "const fetch = require('node-fetch');\n"
    + "const { ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField } = require('discord.js');\n"
    + "const { counters } = require('./state');\n"
    + "const { t } = require('./locales');\n"
    + "const { videoExtensions, isUnknownMessageError, sendContentPromise } = require('./utils');\n"
    + "const { settings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('./settings');\n\n"
) + twitterCode + eol + eol + n("module.exports = { sendTweetEmbed };\n");
fs.writeFileSync('src/twitter.js', TWITTER_JS);

const MC_JS = n("'use strict';\n\n"
    + "const { Events } = require('discord.js');\n"
    + "const { settings } = require('../settings');\n"
    + "const { ifUserHasRole, cleanMessageContent, extractTwitterUrls } = require('../utils');\n"
    + "const { sendTweetEmbed } = require('../twitter');\n\n"
    + "function register(client) {\n")
    + indentBlock(shouldIgnoreFn.body, 4) + eol + eol
    + indentBlock(isMsgDisabledFn.body, 4) + eol + eol
    + indentBlock(mc1Block.body, 4) + eol + eol
    + indentBlock(mc2Block.body, 4) + eol
    + n("}\n\nmodule.exports = { register };\n");
fs.writeFileSync('src/handlers/messageCreate.js', MC_JS);

const AC_JS = n("'use strict';\n\n"
    + "const { Events, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');\n"
    + "const fsMod = require('fs');\n"
    + "const pathMod = require('path');\n"
    + "const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../locales');\n"
    + "const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');\n"
    + "const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../db');\n"
    + "const {\n"
    + "    button_disabled_template,\n"
    + "    button_invisible_template,\n"
    + "    antiDirectoryTraversalAttack,\n"
    + "    ifUserHasRole,\n"
    + "    convertBoolToEnableDisable,\n"
    + "    conv_en_to_en_US,\n"
    + "} = require('../utils');\n\n"
    + "function register(client) {\n")
    + indentBlock(ic1Block.body, 4) + eol
    + n("}\n\nmodule.exports = { register };\n");
fs.writeFileSync('src/handlers/applicationCommands.js', AC_JS);

const MCOMP_JS = n("'use strict';\n\n"
    + "const { Events, ButtonBuilder, ButtonStyle, ComponentType, ActionRowBuilder, EmbedBuilder } = require('discord.js');\n"
    + "const { t } = require('../locales');\n"
    + "const { settings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');\n"
    + "const { videoExtensions, ifUserHasRole } = require('../utils');\n\n"
    + "function register(client) {\n")
    + indentBlock(ic2Block.body, 4) + eol
    + n("}\n\nmodule.exports = { register };\n");
fs.writeFileSync('src/handlers/messageComponents.js', MCOMP_JS);

const READY_JS = n("'use strict';\n\n"
    + "const { ActivityType } = require('discord.js');\n"
    + "const { counters, consoleBuffer } = require('../state');\n"
    + "const { connection } = require('../db');\n"
    + "const { buildSlashCommands } = require('../commands');\n\n"
    + "function register(client, webhookClient) {\n")
    + indentBlock(readyBlock.body, 4) + eol
    + n("}\n\nmodule.exports = { register };\n");
fs.writeFileSync('src/handlers/ready.js', READY_JS);

const NEW_INDEX = n("//discord.js v14\n"
    + "const { Client, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');\n"
    + "const config = require('./config.json');\n"
    + "const { consoleBuffer } = require('./src/state');\n\n"
    + "const client = new Client({\n"
    + "    intents: [\n"
    + "        GatewayIntentBits.Guilds,\n"
    + "        GatewayIntentBits.GuildMessages,\n"
    + "        GatewayIntentBits.MessageContent,\n"
    + "    ],\n"
    + "    partials: [Partials.Channel],\n"
    + "    shards: 'auto',\n"
    + "});\n"
    + "const webhookClient = new WebhookClient({ url: config.URL });\n\n"
    + "// Buffer stdout/stderr for the periodic webhook flush in the ready handler.\n"
    + "process.stdout.write = (write => function (string) {\n"
    + "    consoleBuffer.text += string;\n"
    + "    write.apply(process.stdout, arguments);\n"
    + "})(process.stdout.write);\n"
    + "process.stderr.write = (write => function (string) {\n"
    + "    consoleBuffer.text += string;\n"
    + "    write.apply(process.stderr, arguments);\n"
    + "})(process.stderr.write);\n\n"
    + "process.on('unhandledRejection', error => {\n"
    + "    console.error('Unhandled promise rejection:', error);\n"
    + "});\n"
    + "process.on('uncaughtException', error => {\n"
    + "    console.error('Uncaught exception:', error);\n"
    + "});\n\n"
    + "require('./src/handlers/ready').register(client, webhookClient);\n"
    + "require('./src/handlers/messageCreate').register(client);\n"
    + "require('./src/handlers/applicationCommands').register(client);\n"
    + "require('./src/handlers/messageComponents').register(client);\n\n"
    + "client.login(config.token);\n");
fs.writeFileSync(FILE, NEW_INDEX);

console.log('twitter.js lines:', TWITTER_JS.split(/\r?\n/).length);
console.log('messageCreate.js lines:', MC_JS.split(/\r?\n/).length);
console.log('applicationCommands.js lines:', AC_JS.split(/\r?\n/).length);
console.log('messageComponents.js lines:', MCOMP_JS.split(/\r?\n/).length);
console.log('ready.js lines:', READY_JS.split(/\r?\n/).length);
console.log('NEW index.js lines:', NEW_INDEX.split(/\r?\n/).length);
'use strict';
const fs = require('fs');
const FILE = 'index.js';
const src = fs.readFileSync(FILE, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';

function findMatchingBrace(content, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < content.length; i++) {
        const ch = content[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            i++;
            while (i < content.length) {
                if (content[i] === '\\') { i += 2; continue; }
                if (content[i] === quote) break;
                if (quote === '`' && content[i] === '$' && content[i + 1] === '{') {
                    i += 2;
                    let td = 1;
                    while (i < content.length && td > 0) {
                        if (content[i] === '{') td++;
                        else if (content[i] === '}') td--;
                        i++;
                    }
                    continue;
                }
                i++;
            }
            continue;
        }
        if (ch === '/' && content[i + 1] === '/') {
            while (i < content.length && content[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && content[i + 1] === '*') {
            i += 2;
            while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
            i += 1;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    throw new Error('No matching brace');
}

function findFunctionBlock(content, signature) {
    const s = content.indexOf(signature);
    if (s < 0) throw new Error('Function not found: ' + signature.slice(0, 80));
    const open = content.indexOf('{', s);
    const close = findMatchingBrace(content, open);
    return { start: s, end: close + 1, body: content.slice(s, close + 1) };
}

function findClientOnBlock(content, headerLine, fromIdx) {
    const s = content.indexOf(headerLine, fromIdx || 0);
    if (s < 0) throw new Error('Handler not found: ' + headerLine);
    const open = content.indexOf('{', s);
    const close = findMatchingBrace(content, open);
    let i = close + 1;
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] !== ')') throw new Error('Expected ) after handler body');
    i++;
    while (content[i] === ' ' || content[i] === '\t') i++;
    if (content[i] === ';') i++;
    return { start: s, end: i, body: content.slice(s, i) };
}

function indentBlock(text, spaces) {
    const pad = ' '.repeat(spaces);
    return text.split(/\r?\n/).map(l => l.length ? pad + l : l).join(eol);
}

const twStart = src.indexOf('async function fetchTweetJson(newUrl) {');
if (twStart < 0) throw new Error('twStart');
const sendTweetBlock = findFunctionBlock(src, 'async function sendTweetEmbed(message, url, quoted = false, parent = null, saved = false, depth = 0) {');
const twitterCode = src.slice(twStart, sendTweetBlock.end);

const shouldIgnoreFn = findFunctionBlock(src, 'function shouldIgnoreMessage(message) {');
const isMsgDisabledFn = findFunctionBlock(src, 'function isMessageDisabledForUserOrChannel(message) {');

const readyBlock = findClientOnBlock(src, "client.on('ready', () => {");
const mc1Block = findClientOnBlock(src, 'client.on(Events.MessageCreate, async message => {');
const mc2Block = findClientOnBlock(src, 'client.on(Events.MessageCreate, async (message) => {');
const ic1Block = findClientOnBlock(src, 'client.on(Events.InteractionCreate, async (interaction) => {');
const ic2Block = findClientOnBlock(src, 'client.on(Events.InteractionCreate, async (interaction) => {', ic1Block.end);

const TWITTER_JS = "'use strict';\n\n"
    + "const fetch = require('node-fetch');\n"
    + "const { ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField } = require('discord.js');\n"
    + "const { counters } = require('./state');\n"
    + "const { t } = require('./locales');\n"
    + "const { videoExtensions, isUnknownMessageError, sendContentPromise } = require('./utils');\n"
    + "const { settings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('./settings');\n\n"
    + twitterCode + "\n\n"
    + "module.exports = { sendTweetEmbed };\n";
fs.writeFileSync('src/twitter.js', TWITTER_JS.replace(/\n/g, eol));

const MC_JS = "'use strict';\n\n"
    + "const { Events } = require('discord.js');\n"
    + "const { settings } = require('../settings');\n"
    + "const { ifUserHasRole, cleanMessageContent, extractTwitterUrls } = require('../utils');\n"
    + "const { sendTweetEmbed } = require('../twitter');\n\n"
    + "function register(client) {\n"
    + indentBlock(shouldIgnoreFn.body, 4) + eol + eol
    + indentBlock(isMsgDisabledFn.body, 4) + eol + eol
    + indentBlock(mc1Block.body, 4) + eol + eol
    + indentBlock(mc2Block.body, 4) + eol
    + "}\n\n"
    + "module.exports = { register };\n";
fs.writeFileSync('src/handlers/messageCreate.js', MC_JS);

const AC_JS = "'use strict';\n\n"
    + "const { Events, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');\n"
    + "const fsMod = require('fs');\n"
    + "const pathMod = require('path');\n"
    + "const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../locales');\n"
    + "const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');\n"
    + "const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../db');\n"
    + "const {\n"
    + "    button_disabled_template,\n"
    + "    button_invisible_template,\n"
    + "    antiDirectoryTraversalAttack,\n"
    + "    ifUserHasRole,\n"
    + "    convertBoolToEnableDisable,\n"
    + "    conv_en_to_en_US,\n"
    + "} = require('../utils');\n\n"
    + "function register(client) {\n"
    + indentBlock(ic1Block.body, 4) + eol
    + "}\n\n"
    + "module.exports = { register };\n";
fs.writeFileSync('src/handlers/applicationCommands.js', AC_JS);

const MCOMP_JS = "'use strict';\n\n"
    + "const { Events, ButtonBuilder, ButtonStyle, ComponentType, ActionRowBuilder, EmbedBuilder } = require('discord.js');\n"
    + "const { t } = require('../locales');\n"
    + "const { settings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../settings');\n"
    + "const { videoExtensions, ifUserHasRole } = require('../utils');\n\n"
    + "function register(client) {\n"
    + indentBlock(ic2Block.body, 4) + eol
    + "}\n\n"
    + "module.exports = { register };\n";
fs.writeFileSync('src/handlers/messageComponents.js', MCOMP_JS);

const READY_JS = "'use strict';\n\n"
    + "const { ActivityType } = require('discord.js');\n"
    + "const { counters, consoleBuffer } = require('../state');\n"
    + "const { connection } = require('../db');\n"
    + "const { buildSlashCommands } = require('../commands');\n\n"
    + "function register(client, webhookClient) {\n"
    + indentBlock(readyBlock.body, 4) + eol
    + "}\n\n"
    + "module.exports = { register };\n";
fs.writeFileSync('src/handlers/ready.js', READY_JS);

const NEW_INDEX = "//discord.js v14\n"
    + "const { Client, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');\n"
    + "const config = require('./config.json');\n"
    + "const { consoleBuffer } = require('./src/state');\n\n"
    + "const client = new Client({\n"
    + "    intents: [\n"
    + "        GatewayIntentBits.Guilds,\n"
    + "        GatewayIntentBits.GuildMessages,\n"
    + "        GatewayIntentBits.MessageContent,\n"
    + "    ],\n"
    + "    partials: [Partials.Channel],\n"
    + "    shards: 'auto',\n"
    + "});\n"
    + "const webhookClient = new WebhookClient({ url: config.URL });\n\n"
    + "// stdout/stderr の冁E��めEwebhook に流すためのバッファ。実際の送信は ready ハンドラ冁EsetInterval、En"
    + "process.stdout.write = (write => function (string) {\n"
    + "    consoleBuffer.text += string;\n"
    + "    write.apply(process.stdout, arguments);\n"
    + "})(process.stdout.write);\n"
    + "process.stderr.write = (write => function (string) {\n"
    + "    consoleBuffer.text += string;\n"
    + "    write.apply(process.stderr, arguments);\n"
    + "})(process.stderr.write);\n\n"
    + "process.on('unhandledRejection', error => {\n"
    + "    console.error('Unhandled promise rejection:', error);\n"
    + "});\n"
    + "process.on('uncaughtException', error => {\n"
    + "    console.error('Uncaught exception:', error);\n"
    + "});\n\n"
    + "require('./src/handlers/ready').register(client, webhookClient);\n"
    + "require('./src/handlers/messageCreate').register(client);\n"
    + "require('./src/handlers/applicationCommands').register(client);\n"
    + "require('./src/handlers/messageComponents').register(client);\n\n"
    + "client.login(config.token);\n";
fs.writeFileSync(FILE, NEW_INDEX.replace(/\n/g, eol));

console.log('twitter.js lines:', TWITTER_JS.split(/\r?\n/).length);
console.log('messageCreate.js lines:', MC_JS.split(/\r?\n/).length);
console.log('applicationCommands.js lines:', AC_JS.split(/\r?\n/).length);
console.log('messageComponents.js lines:', MCOMP_JS.split(/\r?\n/).length);
console.log('ready.js lines:', READY_JS.split(/\r?\n/).length);
console.log('NEW index.js lines:', NEW_INDEX.split(/\r?\n/).length);