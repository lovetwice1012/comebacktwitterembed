'use strict';

const { deleteTarget } = require('../../../providers/autoWatch/store');
const { recordError } = require('../../../errorTracking');

module.exports = async function (interaction) {
    const japanese = String(interaction.locale || '').toLowerCase().startsWith('ja');
    const reply = (description, failed = false) => interaction.editReply({ embeds: [{
        title: japanese ? '新着通知の削除' : 'Auto watch', description, color: failed ? 0xe74c3c : 0x1DA1F2,
    }] });
    const id = interaction.options.getInteger('id');
    if (!Number.isSafeInteger(id) || id <= 0) {
        return await reply(japanese ? '削除する通知のIDを指定してください。' : 'A valid watch ID is required.', true);
    }
    try {
        await deleteTarget(interaction.user.id, id);
    } catch (error) {
        let notFound = false;
        // Only an established error code selects copy; messages and arbitrary
        // thrown values never cross into this public Discord reply.
        try { notFound = error?.code === 'AUTO_WATCH_NOT_FOUND'; } catch { /* Use the generic deletion guidance. */ }
        try { recordError(error, { source: 'autoextract.unwatch', userId: interaction.user.id, guildId: interaction.guildId, details: { targetId: id } }); }
        catch { /* Keep the failure reply available if internal diagnostics fail. */ }
        return await reply(notFound
            ? japanese ? '指定した通知が見つかりません。一覧でIDを確認してください。' : 'The watch was not found. Check its ID in the watch list.'
            : japanese ? '通知を削除できませんでした。少し待ってから、もう一度お試しください。' : 'The watch could not be deleted. Please try again shortly.', true);
    }
    // A reply transport failure belongs to the command dispatcher's safe error
    // handler; deleting succeeded and must not be presented as a deletion error.
    return await reply(japanese ? '新着通知を削除しました。' : 'Watch registration deleted.');
};
