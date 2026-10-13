'use strict';

const db = require('../../../db');
const { getEntitlementSummary } = require('../../../automation/entitlements');

module.exports = async function (interaction) {
    const summary = await getEntitlementSummary(db, interaction.user.id);
    const japanese = String(interaction.locale || '').toLowerCase().startsWith('ja');
    const auto = summary.slots.filter(slot => slot.targetKind === 'auto').length;
    const price = summary.slots.filter(slot => slot.targetKind === 'price').length;
    const overflow = summary.slots.filter(slot => !slot.allowed).length;
    const content = japanese ? [
        `利用プラン: ${summary.label}`,
        `通知枠: ${summary.usedSlots}/${summary.slotLimit}枠（空き ${summary.remainingSlots}枠）`,
        `新着 ${auto}件・価格 ${price}件。一時停止中の登録も枠を使います。`,
        `1枠あたりの送信上限: 1日${summary.dayLimit}通・1分${summary.minuteLimit}通`,
        '1メッセージの送信を1通として数えます。日次上限は日本時間0時にリセットします。',
        `処理の優先度: ${summary.priority}`,
        ...(summary.manualExtraSlots ? [`既存の追加枠: ${summary.manualExtraSlots}枠`] : []),
        ...(summary.donationPaymentCount || summary.addonGrantUnits ? [`対象期間内のSquare支援: 決済${summary.donationPaymentCount}回・${summary.addonGrantUnits}口・追加${summary.addonExtraSlots}枠`] : []),
        ...(overflow ? [`上限を超える${overflow}件は送信・再開できません。停止・削除はできます。`] : []),
    ] : [
        `Your plan: ${summary.label}`,
        `Notification slots: ${summary.usedSlots}/${summary.slotLimit} (${summary.remainingSlots} available)`,
        `New-post watches: ${auto}; price watches: ${price}. Paused registrations also occupy slots.`,
        `Per-slot send limits: ${summary.dayLimit} messages/day; ${summary.minuteLimit} messages/minute`,
        'Each sent message counts as one. Daily limits reset at midnight in Japan.',
        `Processing priority: ${summary.priority}`,
        ...(summary.manualExtraSlots ? [`Existing additional slots: ${summary.manualExtraSlots}`] : []),
        ...(summary.donationPaymentCount || summary.addonGrantUnits ? [`Square support in the eligible period: ${summary.donationPaymentCount} payments; ${summary.addonGrantUnits} units; ${summary.addonExtraSlots} additional slots`] : []),
        ...(overflow ? [`${overflow} registration${overflow === 1 ? '' : 's'} above your allowance cannot send or resume. You can still pause or delete them.`] : []),
    ];
    await interaction.editReply({ embeds: [{ title: japanese ? '通知枠の利用状況' : 'Notification slot usage', description: content.join('\n'), color: 0x1DA1F2 }] });
};
