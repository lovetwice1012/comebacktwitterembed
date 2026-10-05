'use strict';
const { escapeMarkdown } = require('discord.js');
const model = require('./model');
const { getStore } = require('./store');
const isJa = locale => String(locale || 'ja').startsWith('ja');
const text = (locale, ja, en) => isJa(locale) ? ja : en;
const safe = value => escapeMarkdown(String(value || ''));
const ERRORS = {
    INVALID_LINK: ['URLの形式を確認してください。', 'Please check the URL.'],
    UNSUPPORTED_LINK: ['このBotの対応サービスのURLを指定してください。', 'Use a URL from a service supported by this bot.'],
    INVALID_BOOTH_LINK: ['BOOTHの商品URLを指定してください。', 'Use a BOOTH item URL.'],
    INVALID_VARIATION: ['バリエーションIDを確認してください。', 'Check the variation ID.'],
    INVALID_TAGS: ['タグはカンマ区切りで10個まで、各40文字以内です。', 'Use up to 10 comma-separated tags, each at most 40 characters.'],
    NOTE_TOO_LONG: ['メモは1000文字以内で入力してください。', 'Notes must be at most 1,000 characters.'],
    INVALID_TIME_ZONE: ['タイムゾーンを確認してください。例: Asia/Tokyo', 'Check the time zone, for example Asia/Tokyo.'],
    INVALID_TIME: ['日時は「2026-10-01 21:00」または「1h」「30m」で指定してください。夏時間で曖昧な時刻はUTCオフセット付きISO日時を使ってください。', 'Use 2026-10-01 21:00, 1h or 30m. For ambiguous daylight-saving times, use an ISO date with an explicit UTC offset.'],
    TIME_OUT_OF_RANGE: ['現在から1分後〜366日後の日時を指定してください。「今日21時」は21時を過ぎると登録できません。', 'Choose a time between one minute and 366 days from now. Today at 21:00 must still be in the future.'],
    SAVED_LIMIT: ['保存上限の1000件に達しました。不要な項目を削除してください。', 'The 1,000 saved-link limit has been reached.'],
    NOTIFICATION_LIMIT: ['有効な通知は合計100件までです。不要な通知を解除してください。', 'Up to 100 active notifications are allowed.'],
    NOT_FOUND: ['対象が見つかりません。自分の一覧からIDを確認してください。', 'Not found. Check the ID in your own list.'],
    ALREADY_SENDING: ['送信が始まっているため、この通知は取り消せません。', 'Delivery has started; this notification can no longer be cancelled.'],
    ALREADY_FINISHED: ['この通知は送信済み、または送信結果が未確認です。一覧で状態を確認してください。', 'This notification was sent or its delivery is uncertain. Check its status in the list.'],
    CARD_EXPIRED: ['この操作は期限切れです。/saved add または /remind add に元URLを指定できます。', 'This action has expired. Use /saved add or /remind add with the original URL.'],
};
function errorText(error, locale) { return ERRORS[error?.code]?.[isJa(locale) ? 0 : 1] || text(locale, '操作を完了できませんでした。時間をおいて再試行してください。', 'The action could not be completed. Please try again later.'); }
async function replyError(interaction, error) {
    if (!ERRORS[error?.code]) require('../errorTracking').recordError(error, { source: 'personalLinks.interaction', fallbackType: 'personal_link_action_failed' });
    const payload = { content: errorText(error, interaction.locale), allowedMentions: { parse: [] }, ephemeral: true };
    await (interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload));
}
function button(label, customId, style = 2) { return { type: 2, style, label, custom_id: customId }; }
function row(...components) { return { type: 1, components }; }
function savedReply(item, locale) {
    return { content: text(locale, item.already ? 'すでに保存されています。既存のタグ・メモは保持しました。' : '「あとで見る」に保存しました。', item.already ? 'Already saved. Existing tags and notes were kept.' : 'Saved for later.'),
        components: [row(button(text(locale, 'タグ・メモを編集', 'Edit tags / note'), `personal:edit:${item.id}`))], allowedMentions: { parse: [] } };
}
const STATES = {
    watching: ['再入荷を監視中', 'Watching'], pending: ['通知待ち', 'Pending'], preparing: ['送信準備中', 'Preparing'],
    sending: ['送信中', 'Sending'], sent: ['送信済み', 'Sent'], failed: ['送信失敗', 'Failed'],
    unknown: ['送信結果不明（自動再送なし）', 'Delivery unknown (no automatic retry)'], cancelled: ['解除済み', 'Cancelled'],
    quarantined: ['復旧に伴い停止', 'Stopped after recovery'],
};
const DELIVERY_DETAILS = {
    DM_REJECTED: ['DMの受信設定を確認してください。', 'Please check your DM privacy settings.'],
    RATE_LIMITED: ['Discordの送信制限で待機しています。', 'Waiting for Discord to allow delivery.'],
    DELIVERY_PREPARATION_FAILED: ['DMの送信準備に失敗しました。', 'Could not prepare the DM.'],
    DELIVERY_UNKNOWN: ['重複を避けるため自動では再送しません。', 'Will not automatically resend to avoid duplicates.'],
    RECOVERY_QUARANTINED: ['復旧前の通知のため停止しました。', 'Stopped because this notification predates recovery.'],
};
function listing(rows, locale, kind) {
    return { content: text(locale, rows.length ? '自分専用の一覧です。次のページは page、編集・解除はIDを指定してください。' : '登録はありません。', rows.length ? 'Your private list. Use page for more results, or an ID to edit/remove.' : 'No entries.'),
        allowedMentions: { parse: [] }, embeds: rows.map(item => ({ title: String(item.title || item.url).slice(0, 90), url: item.url,
            description: kind === 'saved' ? [JSON.parse(item.tags_json).map(safe).join(' / '), safe(item.note)].filter(Boolean).join('\n').slice(0, 350) || '—'
                : [STATES[item.status]?.[isJa(locale) ? 0 : 1] || item.status,
                    Number(item.due_at_ms) > 0 ? `<t:${Math.floor(Number(item.due_at_ms) / 1000)}:F>` : '',
                    kind === 'restock' ? (item.variation_id === '*' ? text(locale, '商品全体', 'Any variation') : safe(item.variation_name || item.variation_id)) : item.time_zone,
                    DELIVERY_DETAILS[item.last_error]?.[isJa(locale) ? 0 : 1] || ''].filter(Boolean).join('\n'),
            footer: { text: `ID: ${item.id}` } })) };
}

async function execute(interaction, kind, store = getStore()) {
    const opts = interaction.options, userId = interaction.user.id, locale = interaction.locale;
    try {
        const sub = opts.getSubcommand();
        if (sub === 'list') {
            const rows = kind === 'saved' ? await store.listSaved(userId, { query: opts.getString('query') || '', tag: opts.getString('tag') || '', page: opts.getInteger('page') || 1 })
                : await store.listNotifications(userId, kind, opts.getInteger('page') || 1);
            return await interaction.editReply(listing(rows, locale, kind));
        }
        if (sub === 'delete' || sub === 'cancel') {
            if (kind === 'saved') await store.deleteSaved(userId, opts.getString('id', true));
            else await store.cancel(userId, opts.getString('id', true), kind);
            return await interaction.editReply({ content: text(locale, kind === 'saved' ? '保存を削除しました。' : '通知を解除しました。', kind === 'saved' ? 'Saved link removed.' : 'Notification cancelled.'), components: [] });
        }
        if (sub === 'edit') {
            const id = opts.getString('id', true), saved = await store.getSaved(userId, id);
            if (!saved) throw model.error('NOT_FOUND');
            await store.editSaved(userId, id, opts.getString('tags') ?? JSON.parse(saved.tags_json), opts.getString('note') ?? saved.note);
            return await interaction.editReply({ content: text(locale, 'タグ・メモを更新しました。', 'Tags and note updated.') });
        }
        const entry = model.link(opts.getString('url', true), opts.getString('title') || '');
        if (kind === 'saved') return await interaction.editReply(savedReply(await store.save(userId, entry, { tags: opts.getString('tags'), note: opts.getString('note') }), locale));
        const zone = kind === 'reminder' ? opts.getString('timezone') || 'Asia/Tokyo' : 'Asia/Tokyo';
        const due = kind === 'reminder' ? model.dueAt(opts.getString('when', true), zone) : 0;
        const record = await store.createNotification(userId, entry, { kind, requestKey: interaction.id, dueAtMs: due, timeZone: zone, locale,
            variationId: kind === 'restock' ? opts.getString('variation') || '*' : '*' });
        return await interaction.editReply(notificationReply(record, locale, kind));
    } catch (error) { await replyError(interaction, error); }
}
function notificationReply(record, locale, kind) {
    const content = kind === 'restock'
        ? text(locale, '再入荷通知を登録しました。最初の確認を基準に、売り切れから購入可能へ変化したら1回DMします。', 'Registered. After the initial baseline, a sold-out to available change sends one DM.')
        : text(locale, '見返す通知を登録しました。指定時刻にDMします。', 'Reminder registered. A DM will arrive at the selected time.');
    return { content: `${content}${Number(record.due_at_ms) > 0 ? `\n<t:${Math.floor(Number(record.due_at_ms) / 1000)}:F>` : ''}\nID: ${record.id}`,
        components: [], allowedMentions: { parse: [] } };
}
module.exports = { execute, text, safe, isJa, replyError, button, row, savedReply, listing, notificationReply };
