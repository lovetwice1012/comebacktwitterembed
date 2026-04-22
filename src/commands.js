'use strict';

// Slash command definitions live alongside their handlers in src/commands/handlers/<name>.js.
// Each handler module exports both `.execute` (async handler) and `.definition` (Discord API payload).

const HANDLER_NAMES = [
    "help",
    "ping",
    "invite",
    "support",
    "settings",
    "showsavetweet",
    "savetweetquotaoverride",
    "deletesavetweet",
    "quotastats",
    "checkmyguildsettings",
    "autoextract",
];

function buildSlashCommands() {
    return HANDLER_NAMES.map(name => require(`./commands/handlers/${name}`).definition);
}

module.exports = { buildSlashCommands, HANDLER_NAMES };
