'use strict';

/**
 * Slash command 集約。
 *
 * Discord に登録するコマンド定義は 2 系統:
 *   - core: src/commands/handlers/<name>.js                  汎用 (どの provider にも依存しない)
 *   - provider: src/providers/<id>/commands/*.js             provider が export するもの
 *
 * 既存の Twitter 固有コマンド (showsavetweet/deletesavetweet/savetweetquotaoverride)
 * は src/providers/twitter/commands/ 配下で provider 自身が export している。
 * Twitter 設定系は core 側 `/settings twitter ...` に統合されている。
 */

const { loadProviderCommands } = require('./providers/_loader');

const HANDLER_NAMES = [
    "help",
    "ping",
    "invite",
    "support",
    "settings",
    "quotastats",
    "checkmyguildsettings",
    "autoextract",
    "provider",
];

function buildSlashCommands() {
    const core = HANDLER_NAMES.map(name => require(`./commands/handlers/${name}`).definition);
    const provider = loadProviderCommands().map(c => c.definition);
    return [...core, ...provider];
}

module.exports = { buildSlashCommands, HANDLER_NAMES };
