'use strict';
const { ApplicationCommandOptionType: T } = require('discord.js');
const str = (name, description, required = false, max = 2048) => ({ name, description, type: T.String, required, max_length: max });
const page = { name: 'page', description: 'ページ / Page', type: T.Integer, min_value: 1, max_value: 1000 };
const id = str('id', '一覧に表示されたID / ID from your list', true, 32);
const url = str('url', '対応サービスのURL / Supported service URL', true);
const title = str('title', '自分用のタイトル / Your title', false, 100);
const tags = str('tags', 'カンマ区切りのタグ / Comma-separated tags', false, 410);
const note = str('note', 'メモ / Note', false, 1000);
const sub = (name, description, options) => ({ name, description, type: T.Subcommand, options });
const definitions = {
    saved: { name: 'saved', description: 'あとで見るを保存・検索・編集 / Save and manage links', options: [
        sub('add', 'あとで見るに保存 / Save a link', [url, title, tags, note]),
        sub('list', '自分の保存を検索 / Search your saved links', [str('query', 'タイトル・URL・メモを検索 / Search', false, 100), str('tag', 'タグ / Tag', false, 40), page]),
        sub('edit', 'タグ・メモを編集（空白1文字で消去） / Edit tags and note', [id, tags, note]),
        sub('delete', '保存を削除 / Remove saved link', [id]),
    ] },
    remind: { name: 'remind', description: 'リンクを見返す時刻を指定 / Remind yourself about a link', options: [
        sub('add', '指定時刻にDM / Schedule a DM', [url, str('when', '例: 1h、30m、2026-10-01 21:00 / Time', true, 64), title, str('timezone', '既定 Asia/Tokyo / Time zone', false, 64)]),
        sub('list', '通知の一覧と結果 / Your reminders and results', [page]),
        sub('cancel', '通知を解除 / Cancel a reminder', [id]),
    ] },
    restock: { name: 'restock', description: 'BOOTHの再入荷をDM通知 / BOOTH restock alerts', options: [
        sub('add', '次の再入荷を監視 / Watch for next restock', [url, title, str('variation', 'バリエーションID、省略で商品全体 / Variation ID', false, 20)]),
        sub('list', '監視の一覧と通知結果 / Your watches and results', [page]),
        sub('cancel', '再入荷通知を解除 / Cancel a restock alert', [id]),
    ] },
};
module.exports = { definitions };
