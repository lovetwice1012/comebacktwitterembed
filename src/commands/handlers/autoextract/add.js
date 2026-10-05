'use strict';

function stoppedReply(locale) {
    const japanese = String(locale || '').toLowerCase().startsWith('ja');
    return {
        embeds: [{
            title: 'Auto extract',
            description: japanese
                ? 'Twitter/X の自動展開登録は停止中です。既存の登録は変更されません。非Twitterプロバイダー向けの統合監視へ移行します。'
                : 'Twitter/X auto-extract registration is paused. Existing registrations are unchanged while monitoring moves to unified non-Twitter providers.',
            color: 0x1DA1F2,
        }],
    };
}

// Kept as a command handler so clients with an already-cached slash-command
// definition receive an explicit, non-mutating response instead of a timeout.
module.exports = async function (interaction) {
    return await interaction.editReply(stoppedReply(interaction.locale));
};

module.exports._internal = { stoppedReply };
