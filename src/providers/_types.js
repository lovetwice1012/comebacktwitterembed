'use strict';

// ============================================================================
// Provider extractor 型定義。
//
// 各サービス用の extractor は 1 ファイル (例: src/providers/twitter.js) として実装する。
//   1. 指定 URL から API レスポンス取得 → 表示用 Embed 構造を生成
//   2. 表示後に必要な後処理 (元メッセージ削除/埋め込み抑制) を結果として宣言
//   3. 引用ポスト等の連鎖送信は SendStep[] 配列形式で複数ステップを返す
//
// dispatcher (src/handlers/messageCreate.js) は extract() の結果を機械的に
// Discord に送信し、後処理を実施する。送信ロジックや behaviour は extractor 内に
// 完全封入される。pipeline / behaviors / engine 等の共通機構はもう存在しない。
// ============================================================================

/**
 * @typedef {object} SendStep
 * 1 回の Discord 送信単位 + 送信後の後処理指示。
 * extract() は SendStep または SendStep[] を返す (または null = 何もしない)。
 *
 * @property {any[]} [embeds]                 送信する embeds
 * @property {string[]} [files]               添付ファイル URL
 * @property {any[]} [components]             button row 等のコンポーネント
 * @property {string} [content]               テキスト本文 (引用ポストの prefix 等)
 * @property {object} [allowedMentions]       Discord allowedMentions
 * @property {'channel'|'reply-source'|'reply-previous'} [send]
 *   送信モード:
 *   - 'channel'        = message.channel.send (デフォルト: 配列の最初のステップ)
 *   - 'reply-source'   = 元メッセージへの reply (alwaysReply モード)
 *   - 'reply-previous' = 直前ステップで送ったメッセージへの reply (デフォルト: 2 番目以降)
 * @property {boolean} [deleteSource]         送信後 message.delete()
 * @property {boolean} [suppressSourceEmbeds] 送信後 message.suppressEmbeds(true)
 */

/**
 * @callback Extractor
 * @param {any} message                     Discord メッセージ
 * @param {string} url                      マッチした URL
 * @param {object} settings                 そのプロバイダの設定 (フラットな key→value)
 * @param {object} [opts]                   内部 (dispatcher 経由では渡さない)
 * @returns {Promise<SendStep|SendStep[]|null|undefined>}
 *   null/undefined = extractor 内で処理完了 (例: banned-word 削除) → dispatcher は何もしない
 */

/**
 * @typedef {object} Provider
 * @property {string} id                  一意な識別子 (例: 'twitter')
 * @property {boolean} [enabledByDefault] ギルド未設定時の既定有効フラグ (省略時 false)
 * @property {RegExp} urlPattern          本文中の URL を検出する g 付き正規表現
 * @property {RegExp} [cleanPattern]      `<URL>` / `||URL||` 除去用 (省略時は urlPattern から自動生成)
 * @property {Extractor} extract          メイン extractor (この 1 関数だけが必須インターフェース)
 */

module.exports = {};