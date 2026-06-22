'use strict';

const { PermissionsBitField } = require('discord.js');
const { t } = require('../locales');

function extractIdFromText(text) {
    if (typeof text !== 'string') return null;
    // 末尾側の "(id:...)" を採用する。pixiv の埋め込みは author.name に
    // pixiv 作者の "(id:作者ID)" が含まれることがあるため、最後の
    // "(id:" を優先することで「展開者ID」を確実に取り出す。
    const idx = text.lastIndexOf('(id:');
    if (idx === -1) return null;
    const tail = text.slice(idx + '(id:'.length);
    const end = tail.indexOf(')');
    if (end === -1) return null;
    const id = tail.slice(0, end).trim();
    // Discord のユーザー ID は数字のみ。pixiv の作者 ID も数字なので
    // ここでは数字判定では区別できないが、後段で interaction.user.id と
    // 厳密一致させるため、抽出のみ行う。
    return id || null;
}

function getRequesterIdFromMessage(interaction) {
    const embed = interaction.message.embeds[0];

    // pixiv/booth は footer.text に「展開者: USER(id:DISCORDID) · ...」を
    // 入れる一方、author.name にはプロバイダ側 (pixiv 作者 / booth ショップ)
    // 由来の値を入れる。Twitter は author.name に展開者を入れ、footer は
    // ツイート投稿者情報。よって footer を先に確認することで全プロバイダで
    // 「展開者の Discord ID」を取得できる。
    const fromFooter = extractIdFromText(embed?.footer?.text);
    if (fromFooter) return fromFooter;

    return extractIdFromText(embed?.author?.name);
}

async function handle(interaction) {
    const finishAndCleanup = async () => {
        await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
        setTimeout(() => { interaction.deleteReply(); }, 3000);
    };

    if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        await interaction.message.delete();
        await finishAndCleanup();
        return;
    }

    // Non-managers can only delete embeds they originally requested.
    const requesterId = getRequesterIdFromMessage(interaction);
    if (!requesterId || requesterId !== interaction.user.id) {
        await interaction.editReply({ content: t('youcantdeleteotherusersmessagesLocales', interaction.locale), ephemeral: true });
        setTimeout(() => { interaction.deleteReply(); }, 3000);
        return;
    }
    await interaction.message.delete();
    await finishAndCleanup();
}

module.exports = { handle };
