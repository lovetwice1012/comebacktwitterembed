'use strict';

/**
 * Twitter プロバイダが Discord に登録する slash commands の一覧。
 * registry (src/providers/_loader.loadProviderCommands) が拾って自動登録する。
 *
 * 各エントリは { definition, execute } の形式。core 側 (src/commands/handlers/*) と同じ規約。
 */

module.exports = [
    require('./showsavetweet'),
    require('./deletesavetweet'),
    require('./savetweetquotaoverride'),
];
