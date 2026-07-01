'use strict';

// booth.pm 商品の「販売開始時に DM で通知」ボタンハンドラ。
//
// customId 形式: `notifyBoothSale:<itemId>:<lang>:<unixSeconds>`
//   - itemId      : booth item id
//   - lang        : 'ja' | 'en'
//   - unixSeconds : 販売開始時刻 (秒)
//
// 動作:
//   1. 既に同じ user × item の未通知サブスクリプションがあれば「登録済み」と返す
//   2. なければ DM を一通送れるか試す (送れなければ DM 拒否設定の旨を返す)
//   3. サブスクリプションを保存し、登録完了を返信

const subs = require('../providers/booth/_notifications');
const {
    normalizeDiscordLocale,
    toApiLocaleFamily,
} = require('../discordLocales');

const STR = {
    ja: {
        already:       'すでに販売開始通知に登録されています。販売開始時にDMでお知らせします。',
        dmBlocked:     'DMを送れませんでした。サーバーのプライバシー設定で「サーバーメンバーからのダイレクトメッセージを許可する」を有効にしてから、もう一度ボタンを押してください。',
        registered:    '販売開始時にDMでお知らせします。\n対象: <itemUrl>\n通知予定: <when>',
        invalid:       'このボタンは無効です (情報を取得できませんでした)。',
        pastSale:      'すでに販売が開始されているか、開始時刻情報が古いため通知登録できません。',
    },
    en: {
        already:       "You're already subscribed to this sale notification. We'll DM you when it goes on sale.",
        dmBlocked:     "I couldn't send you a DM. Please enable 'Allow direct messages from server members' in your privacy settings and click the button again.",
        registered:    "You'll receive a DM when this item goes on sale.\nItem: <itemUrl>\nWhen: <when>",
        invalid:       'This button is no longer valid (missing information).',
        pastSale:      'This sale has already started or the start time is in the past; cannot register.',
    },
};

const BOOTH_SITE_LANGUAGE_BY_DISCORD_LOCALE = Object.freeze({
    ja: 'ja',
    ko: 'ko',
    'zh-CN': 'zh-cn',
    'zh-TW': 'zh-tw',
});

function pickLangByLocale(locale) {
    return normalizeDiscordLocale(locale, 'en-US');
}

function boothSiteLanguage(locale) {
    const normalized = normalizeDiscordLocale(locale, 'en-US');
    return BOOTH_SITE_LANGUAGE_BY_DISCORD_LOCALE[normalized] || toApiLocaleFamily(normalized);
}

function parseCustomId(customId) {
    if (typeof customId !== 'string') return null;
    const parts = customId.split(':');
    if (parts.length < 4 || parts[0] !== 'notifyBoothSale') return null;
    const itemId = parts[1];
    const lang = normalizeDiscordLocale(parts[2], 'en-US');
    const unix = Number(parts[3]);
    if (!itemId || !Number.isFinite(unix)) return null;
    return { itemId, lang, notifyAt: new Date(unix * 1000) };
}

function getItemUrlFromMessage(interaction) {
    const embed = interaction.message?.embeds?.[0];
    if (!embed?.url) return null;
    // anchor (#g1 等のグループフラグメント) を除去
    return String(embed.url).split('#')[0];
}

function getItemNameFromMessage(interaction) {
    return interaction.message?.embeds?.[0]?.title || null;
}

async function handle(interaction) {
    const parsed = parseCustomId(interaction.customId);
    const lang = parsed?.lang || pickLangByLocale(interaction.locale);
    const textLang = toApiLocaleFamily(lang);
    const s = STR[textLang];

    if (!parsed) {
        await interaction.editReply({ content: s.invalid });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return;
    }

    if (parsed.notifyAt.getTime() <= Date.now()) {
        await interaction.editReply({ content: s.pastSale });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return;
    }

    if (subs.hasActiveSubscription(interaction.user.id, parsed.itemId)) {
        await interaction.editReply({ content: s.already });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 8000);
        return;
    }

    // DM 送信可能かを確認 (失敗した場合に登録しても役に立たないため)
    try {
        const user = await interaction.client.users.fetch(interaction.user.id);
        await user.send({
            content: textLang === 'ja'
                ? '🔔 販売開始通知の登録を受け付けました。販売開始時にこのDMでお知らせします。'
                : "🔔 Sale notification registered. We'll DM you here when it goes on sale.",
        });
    } catch {
        await interaction.editReply({ content: s.dmBlocked });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 15000);
        return;
    }

    const itemUrl = getItemUrlFromMessage(interaction);
    const itemName = getItemNameFromMessage(interaction);
    subs.addSubscription({
        itemId: parsed.itemId,
        itemUrl: itemUrl || `https://booth.pm/${boothSiteLanguage(lang)}/items/${parsed.itemId}`,
        itemName,
        userId: interaction.user.id,
        guildId: interaction.guildId || null,
        channelId: interaction.channelId || null,
        language: lang,
        notifyAt: parsed.notifyAt.toISOString(),
    });

    const whenTag = `<t:${Math.floor(parsed.notifyAt.getTime() / 1000)}:F>`;
    const reply = s.registered
        .replace('<itemUrl>', itemUrl || '')
        .replace('<when>', whenTag);
    await interaction.editReply({ content: reply });
    setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 15000);
}

module.exports = { handle, _internal: { parseCustomId } };
