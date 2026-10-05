'use strict';

function stoppedReply(locale) {
    const japanese = String(locale || '').toLowerCase().startsWith('ja');
    return {
        embeds: [{
            title: 'Auto extract',
            description: japanese
                ? 'Twitter/X の自動展開は現在対応できないため、登録を停止しています。'
                : 'Twitter/X automatic expansion is currently unsupported; registration is disabled.',
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
