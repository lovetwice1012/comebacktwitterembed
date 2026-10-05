'use strict';
const { InteractionType } = require('discord.js');
const { getStore } = require('../personalLinks/store');
const model = require('../personalLinks/model');
const ui = require('../personalLinks/ui');
const { isAllowed } = require('./_permissionCheck');

function input(id, label, value, maxLength, style = 1, required = false) {
    return { type: 1, components: [{ type: 4, custom_id: id, label, style, value: String(value || '').slice(0, maxLength), max_length: maxLength, required }] };
}
async function cardFor(interaction, id, owner, store) {
    if (!interaction.guildId || owner && owner !== interaction.user.id) throw model.error('NOT_FOUND');
    const card = await store.getCard(id, interaction.guildId, interaction.channelId);
    if (!card?.messageId) throw model.error('CARD_EXPIRED');
    if (!owner && interaction.message.id !== card.messageId) throw model.error('NOT_FOUND');
    if (owner) {
        if (!interaction.memberPermissions?.has?.(['ViewChannel', 'ReadMessageHistory'])) throw model.error('NOT_FOUND');
        const source = await interaction.channel.messages.fetch({ message: card.messageId, force: true }).catch(() => null);
        if (source?.author?.id !== interaction.client.user.id) throw model.error('CARD_EXPIRED');
    }
    return card;
}
function timeMenu(card, interaction) {
    const prefix = `personal:time:${card.id}:${interaction.user.id}`;
    return { content: ui.text(interaction.locale, 'いつ見返しますか？通知は自分へのDMに届きます。', 'When would you like a reminder? It will be sent to your DMs.'),
        components: [ui.row(ui.button(ui.text(interaction.locale, '1時間後', 'In 1 hour'), `${prefix}:1h`),
            ui.button(ui.text(interaction.locale, '今日21時（日本時間）', 'Today 21:00 (Japan)'), `${prefix}:today21`),
            ui.button(ui.text(interaction.locale, '日時を指定', 'Choose date / time'), `${prefix}:custom`))] };
}
function stockMenu(card, interaction, requestedPage = 0) {
    const page = Math.max(0, Math.min(Math.ceil(card.restockOptions.length / 25) - 1, Number(requestedPage) || 0));
    const options = card.restockOptions.slice(page * 25, page * 25 + 25);
    if (!options.length) throw model.error('NOT_FOUND');
    return { content: ui.text(interaction.locale, '再入荷を待つ対象を選んでください。初回確認後、売り切れ→購入可能を検知したら1回DMします。', 'Choose what to watch. After the first check, a sold-out to available transition sends one DM.'),
        components: [ui.row({ type: 3, custom_id: `personal:stock:${card.id}:${interaction.user.id}`,
            options: options.map(v => ({ label: v.name.slice(0, 100), value: v.id })) }),
        ...(card.restockOptions.length > 25 ? [ui.row(
            { ...ui.button('←', `personal:variants:${card.id}:${interaction.user.id}:${Math.max(0, page - 1)}`), disabled: page === 0 },
            { ...ui.button('→', `personal:variants:${card.id}:${interaction.user.id}:${page + 1}`), disabled: (page + 1) * 25 >= card.restockOptions.length })] : [])] };
}

async function handle(interaction, store = getStore()) {
    const parts = String(interaction.customId || '').split(':');
    if (parts[0] !== 'personal' || !/^[a-f0-9]{32}$/.test(parts[2] || '')) return;
    if (interaction.type !== InteractionType.ModalSubmit && interaction.message?.author?.id !== interaction.client?.user?.id) return;
    const [, action, id, owner, option] = parts;
    const modal = interaction.type === InteractionType.ModalSubmit;
    try {
        if (action === 'edit') {
            const saved = await store.getSaved(interaction.user.id, id);
            if (!saved) throw model.error('NOT_FOUND');
            await interaction.showModal({ custom_id: `personal:note:${id}`, title: ui.text(interaction.locale, 'タグ・メモの編集', 'Edit tags / note'),
                components: [input('tags', ui.text(interaction.locale, 'タグ（カンマ区切り）', 'Tags (comma-separated)'), JSON.parse(saved.tags_json).join(', '), 410),
                    input('note', ui.text(interaction.locale, 'メモ', 'Note'), saved.note, 1000, 2)] });
            return;
        }
        if (modal && action === 'note') {
            await interaction.deferReply({ ephemeral: true });
            await store.editSaved(interaction.user.id, id, interaction.fields.getTextInputValue('tags'), interaction.fields.getTextInputValue('note'));
            return await interaction.editReply({ content: ui.text(interaction.locale, 'タグ・メモを更新しました。', 'Tags and note updated.') });
        }
        const customTime = action === 'time' && option === 'custom';
        if (!customTime) await interaction.deferReply({ ephemeral: true });
        const card = await cardFor(interaction, id, owner, store);
        if (!await isAllowed(interaction, { providerId: card.providerId })) return;
        if (action === 'save') return await interaction.editReply(ui.savedReply(await store.save(interaction.user.id, card.entry), interaction.locale));
        if (action === 'remind') return await interaction.editReply(timeMenu(card, interaction));
        if (action === 'restock' || action === 'variants') return await interaction.editReply(stockMenu(card, interaction, Number(option) || 0));
        if (customTime) return await interaction.showModal({ custom_id: `personal:when:${id}:${interaction.user.id}`,
            title: ui.text(interaction.locale, '見返す日時を指定', 'Schedule reminder'), components: [
                input('when', ui.text(interaction.locale, '日時（2026-10-01 21:00 または1h）', 'Time (2026-10-01 21:00 or 1h)'), '', 64, 1, true),
                input('timezone', ui.text(interaction.locale, 'タイムゾーン', 'Time zone'), 'Asia/Tokyo', 64, 1, true)] });
        if (action === 'time' || modal && action === 'when') {
            const zone = modal ? interaction.fields.getTextInputValue('timezone') : 'Asia/Tokyo';
            const due = model.dueAt(modal ? interaction.fields.getTextInputValue('when') : option, zone);
            const record = await store.createNotification(interaction.user.id, card.entry, { kind: 'reminder', requestKey: interaction.id,
                dueAtMs: due, timeZone: zone, locale: interaction.locale });
            return await interaction.editReply(ui.notificationReply(record, interaction.locale, 'reminder'));
        }
        if (action === 'stock') {
            const variant = interaction.values?.[0];
            const selected = card.restockOptions.find(v => v.id === variant);
            if (!selected) throw model.error('INVALID_VARIATION');
            const record = await store.createNotification(interaction.user.id, card.entry, { kind: 'restock', requestKey: interaction.id, variationId: variant, variationName: selected.name, locale: interaction.locale });
            return await interaction.editReply(ui.notificationReply(record, interaction.locale, 'restock'));
        }
        throw model.error('NOT_FOUND');
    } catch (error) { await ui.replyError(interaction, error); }
}
module.exports = { handle, timeMenu, stockMenu };
