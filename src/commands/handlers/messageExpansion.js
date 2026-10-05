'use strict';

const { ApplicationCommandType, PermissionFlagsBits } = require('discord.js');
const traces = require('../../expansionTraceStore');
const { MAX_HISTORY, groupHistory, canRetryHistory } = require('../../expansionRetryPolicy');
const { failureReason } = require('../../userFacingErrors');
const { sendEmbedPages } = require('../../interactionResponse');

const STATUS_COMMAND = 'Expansion status';
const RETRY_COMMAND = 'Retry expansion';
const isJapanese = interaction => String(interaction.locale || '').startsWith('ja');

function statusText(row, ja) {
    const choose = (japanese, english) => ja ? japanese : english;
    if (['queued', 'processing', 'sending'].includes(row.state)) return choose('処理中', 'Processing');
    if (row.state === 'interrupted' || ['U', 'unknown'].includes(row.outcome)) return choose('結果を確認できません。重複防止のため再送しません。', 'Delivery is uncertain; automatic resend is disabled.');
    if (row.state === 'skipped') {
        const reasons = {
            provider_disabled: choose('このサービスの展開は無効です。', 'Expansion is disabled for this service.'),
            target_disabled: choose('投稿者・チャンネル・ロールの設定で対象外です。', 'Excluded by user, channel or role settings.'),
            bot_message_disabled: choose('Bot投稿の展開は無効です。', 'Expansion of Bot messages is disabled.'),
            member_unavailable: choose('投稿者の権限を確認できませんでした。', 'The author’s permissions could not be checked.'),
            upstream_non_expandable: choose('元の投稿を展開できません。公開状態や対応形式を確認してください。', 'The source cannot be expanded. Please check its visibility and format.'),
        };
        return reasons[row.reason_code] || choose('設定により展開対象外です。', 'Excluded by the current settings.');
    }
    if (row.outcome === 'P') return choose('一部送信済みです。重複防止のため一括再送しません。', 'Partially delivered; blanket resend is disabled.');
    if (row.state === 'failed') {
        let error;
        try { error = JSON.parse(row.error_json || 'null'); } catch { /* No raw errors in user replies. */ }
        return row.outcome === 'queue_rejected' ? choose('混雑のため処理できませんでした。', 'Processing could not start because the Bot was busy.')
            : failureReason(error, ja ? 'ja' : 'en');
    }
    if (['F', 'D'].includes(row.outcome)) return choose('展開済み', 'Delivered');
    return choose('表示する内容はありませんでした。', 'No output was produced.');
}

async function targetMessage(interaction, retry) {
    const ja = isJapanese(interaction);
    const reject = async (jp, en) => { await interaction.editReply({ content: ja ? jp : en }); return null; };
    if (!interaction.guildId || !interaction.channel?.messages?.fetch) return reject('サーバーの投稿から実行してください。', 'Use this action on a server message.');
    if (!interaction.memberPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return reject('このチャンネルの投稿履歴を閲覧する権限が必要です。', 'You need permission to view this channel and read its message history.');
    }
    let message;
    try { message = await interaction.channel.messages.fetch({ message: interaction.targetId, force: true, cache: false }); }
    catch { return reject('元の投稿が見つからないか、Botに閲覧権限がありません。', 'The original message is unavailable or the Bot cannot read it.'); }
    if (!message || (message.guildId || message.guild?.id) !== interaction.guildId
        || (message.channelId || message.channel?.id) !== interaction.channelId) {
        return reject('このチャンネルの元の投稿から実行してください。', 'Use this action on the original message in this channel.');
    }
    if (message.author?.bot || message.webhookId) return reject('Botの返信ではなく、URLを貼った元の投稿を選んでください。', 'Select the original link post, rather than a Bot or webhook message.');
    if (retry && message.author?.id !== interaction.user.id && !interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return reject('再試行できるのは投稿者またはメッセージ管理権限を持つ人です。', 'Only the author or a member with Manage Messages can retry this post.');
    }
    if (retry) {
        try {
            const member = await message.guild.members.fetch({ user: message.author.id, force: true });
            if (!member) throw new Error('Member is unavailable.');
            require('../../discordCache').retainMessageMember(message, member);
        } catch {
            return reject('投稿者の現在の権限を確認できませんでした。時間をおいて再試行してください。', 'The author’s current permissions could not be verified. Please try again later.');
        }
    }
    return message;
}

async function execute(interaction, client, retry = false) {
    const ja = isJapanese(interaction);
    const message = await targetMessage(interaction, retry);
    if (!message) return;
    let prefix = '';
    if (retry) {
        const result = await require('../../handlers/messageCreate').retryMessage(client, message);
        if (result?.status === 'busy') return interaction.editReply({ content: ja ? 'この投稿は処理中です。完了後に状況を確認してください。' : 'This post is already being processed. Check its status after it finishes.' });
        prefix = result?.status === 'processed'
            ? (ja ? `失敗したリンクを${result.count}件再試行しました。\n` : `Retried ${result.count} failed link(s).\n`)
            : (ja ? '再試行できるリンクはありません。送信前に失敗した履歴があり、前回の処理から30秒以上経過している場合に再試行できます。\n'
                : 'No links are eligible. Retry requires a recorded failure before sending and at least 30 seconds since the last attempt.\n');
    }
    const rows = await traces.getMessageExpansionTraces(message);
    const lines = [prefix].filter(Boolean);
    if (!rows.length) lines.push(ja ? 'この投稿の展開履歴はありません。対応URL、サービスの有効設定、<URL> や ||URL|| による展開抑止を確認してください。'
        : 'No expansion history was found. Check supported URLs, service settings, and suppression with <URL> or ||URL||.');
    let index = 0;
    for (const history of groupHistory(rows).values()) {
        const row = history[0];
        const retryable = rows.length <= MAX_HISTORY && canRetryHistory(history);
        let label = `${row.provider_id || (ja ? 'リンク' : 'Link')} / ${++index}`;
        try {
            const url = new URL(traces._internal.safeUrl(row.raw_url));
            if (['http:', 'https:'].includes(url.protocol)) label = `[${label}](${url.href.replace(/[()]/g, char => char === '(' ? '%28' : '%29')})`;
        } catch { /* A legacy invalid URL must not break the status response. */ }
        lines.push(`${label}: ${statusText(row, ja)}${retryable ? (ja ? ' ［再試行可能］' : ' [Retry available]') : ''}`);
    }
    if (rows.length > MAX_HISTORY) lines.push(ja ? '履歴が多いため一部を表示しています。この投稿は自動で再送しません。' : 'History is truncated. Automatic resend is disabled for this post.');
    await sendEmbedPages(interaction, { title: ja ? '展開状況' : STATUS_COMMAND, lines, ephemeralFollowUps: true });
}

const commands = [
    { definition: { name: STATUS_COMMAND, name_localizations: { ja: '展開状況を確認' }, type: ApplicationCommandType.Message, dm_permission: false }, execute: (interaction, client) => execute(interaction, client) },
    { definition: { name: RETRY_COMMAND, name_localizations: { ja: '展開を再試行' }, type: ApplicationCommandType.Message, dm_permission: false }, execute: (interaction, client) => execute(interaction, client, true) },
];

module.exports = { commands, STATUS_COMMAND, RETRY_COMMAND, _internal: { execute, targetMessage, statusText } };
