'use strict';

// booth.pm 「販売開始時に DM で通知」サブスクリプションの定期チェッカー。
//
// 60 秒ごとに `data/booth_sale_notifications.json` を見て、notifyAt が
// 現在時刻を過ぎている未通知レコードについて DM を送る。
//
// DM 送信に失敗 (DM 拒否設定など) した場合は attempts をインクリメント。
// 5 回失敗で諦めて notified=true 扱いにする。

const subs = require('../providers/booth/_notifications');
const { toApiLocaleFamily } = require('../discordLocales');

const POLL_INTERVAL_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function buildMessage(record) {
    const lang = toApiLocaleFamily(record.language);
    if (lang === 'ja') {
        return [
            `🛎️ booth.pm の商品の販売が開始されました。`,
            `**${record.itemName || `booth #${record.itemId}`}**`,
            record.itemUrl,
        ].join('\n');
    }
    return [
        `🛎️ A booth.pm item you're watching is now on sale.`,
        `**${record.itemName || `booth #${record.itemId}`}**`,
        record.itemUrl,
    ].join('\n');
}

async function deliverOne(client, record) {
    try {
        const user = await client.users.fetch(record.userId);
        await user.send({ content: buildMessage(record) });
        subs.markNotified(record.id);
        return true;
    } catch (err) {
        const attempts = subs.bumpAttempts(record.id);
        console.log(`[boothSaleNotifier] DM failed for ${record.userId}/${record.itemId} (attempt ${attempts}): ${err?.message || err}`);
        if (attempts >= MAX_ATTEMPTS) {
            subs.markNotified(record.id); // give up
        }
        return false;
    }
}

async function tick(client) {
    const due = subs.findDue();
    for (const record of due) {
        // 直列に送って rate limit を踏みにくくする
        await deliverOne(client, record);
    }
    subs.pruneOld();
}

function start(client) {
    setInterval(() => {
        tick(client).catch(err => console.log('[boothSaleNotifier] tick error:', err));
    }, POLL_INTERVAL_MS);
}

module.exports = { start, tick, _internal: { buildMessage } };
