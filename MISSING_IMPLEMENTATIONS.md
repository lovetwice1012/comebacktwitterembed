# 未実装・不完全実装リスト

**監査日**: 2025-11-18
**総問題数**: **47件**

## 📊 問題の内訳

| 重要度 | 件数 | 説明 |
|--------|------|------|
| 🔴 **CRITICAL** | **11件** | 即座に修正が必要（クラッシュ・セキュリティリスク） |
| ❌ **ERROR** | **8件** | 機能不全を引き起こす問題 |
| ⚠️ **WARNING** | **28件** | コード品質・保守性の問題 |

---

## 🔴 CRITICAL問題（即座に修正必須）

### CRITICAL-001: スラッシュコマンドハンドラーが未実装
**ファイル**: `index.js`
**影響**: 6個のコマンドが登録されているが実行できない

未実装のコマンド:
1. `/showsavetweet` - 保存したツイートを表示
2. `/savetweetquotaoverride` - 管理者用：保存容量の上書き
3. `/deletesavetweet` - 保存したツイートを削除
4. `/quotastats` - 保存容量の統計表示
5. `/checkmyguildsettings` - ギルド設定の確認
6. `/autoextract` - 自動抽出機能（5個のサブコマンド）
   - `/autoextract list`
   - `/autoextract add`
   - `/autoextract delete`
   - `/autoextract additionalautoextractslot`
   - `/autoextract checkfreeslot`

**状況**: コマンドはDiscordに表示されるが、実行しても何も起こらない

---

### CRITICAL-002: Settings サブコマンドハンドラーが未実装
**ファイル**: `index.js` (657-808行目)
**影響**: 重要な設定機能が使用不可

未実装の設定:
1. `/settings button invisible` - ボタンの非表示設定
2. `/settings button disabled` - ボタンの無効化設定
3. `/settings secondaryextractmode` - セカンダリー展開モード

---

### CRITICAL-003: 保存ツイート機能が未完成
**ファイル**: `index.js` (1487-1494行目)
**状況**: ボタンは表示されるが、クリックしても "not yet implemented"

**必要な実装**:
- ツイートデータの保存
- 容量チェック
- データベース登録
- ファイルシステムへの保存

---

### CRITICAL-005: 未定義変数 `msg` の使用
**ファイル**: `index.js` (305行目)
**問題**:
```javascript
// 現在（エラー）:
await sendTweetEmbed(message, json.qrtURL, true, msg);  // msgは未定義!

// 正しい:
await sendTweetEmbed(message, json.qrtURL, true, message);
```
**影響**: 引用ツイート展開時にクラッシュ

---

### CRITICAL-013: server.jsで未定義変数 `dirPath`
**ファイル**: `server.js` (74, 105, 116行目)
**問題**:
```javascript
// 74行目 - dirPathが未定義
fs.readdir(dirPath, (err, files) => {  // ❌ エラー

// 116行目 - dirPathが宣言されていない
try{
    dirPath = antiDirectoryTraversalAttack(userid)  // ❌ let/const/var がない
```
**影響**: ダウンロード機能が完全に動作不能

---

### CRITICAL-014: 不正なディレクトリトラバーサルチェック
**ファイル**: `server.js` (86-92行目)
**問題**: tempディレクトリのパスをsavesディレクトリでチェックしているため常に失敗
```javascript
const zipPath = path.join(tempDir, zipName);  // tempDirはsaves/の外
zipPath = antiDirectoryTraversalAttack(zipPath)  // ❌ 常に失敗!
```

---

### CRITICAL-021: 本番コードにデータベース認証情報がハードコード
**ファイル**: `src/config/database.js` (3-7行目)
```javascript
const connection = mysql.createConnection({
    host: '192.168.100.22',      // ❌ セキュリティリスク
    user: 'comebacktwitterembed', // ❌ セキュリティリスク
    password: 'bluebird',         // ❌ セキュリティリスク（Git履歴に残存）
    database: 'ComebackTwitterEmbed'
});
```
**リスク**: データベース侵害のリスク

---

## ❌ ERROR問題

### ERROR-004: DeepL APIキーが未設定
**ファイル**: `index.js` (1433行目)
**問題**: `YOUR_DEEPL_API_KEY` がそのまま使用されている
**影響**: 翻訳機能が完全に動作不能

---

### ERROR-006: Interaction Type チェックが間違っている
**ファイル**: `index.js` (1012, 1234行目)
**問題**:
```javascript
// 現在（論理エラー）:
if (!interaction.type === InteractionType.ApplicationCommand) return;

// 正しい:
if (interaction.type !== InteractionType.ApplicationCommand) return;
```
**影響**: 誤ったインタラクションタイプでハンドラーが実行される

---

### ERROR-017, 019: migration/updateファイルに認証情報ハードコード
**ファイル**: `migration_of_settings.js`, `update.js`
**問題**: 同じデータベース認証情報が複数ファイルに重複

---

### ERROR-018, 020: settings.json参照エラー
**ファイル**: `migration_of_settings.js`, `update.js`
**問題**: require('./settings.json') が新しい構造では存在しない可能性

---

### ERROR-022: config.jsonのエラーハンドリング欠如
**ファイル**: `src/config/constants.js` (1行目)
**問題**: config.jsonが存在しない場合クラッシュ

---

## ⚠️ WARNING問題（28件）

### 主要なWARNING:

1. **WARNING-007**: 脆弱な文字列パースでユーザーID抽出（1392行目）
2. **WARNING-008**: Boolean設定のキーマッピング不完全
3. **WARNING-009**: deleteifonlypostedtweetlink の secoundaryextractmode オプション未処理
4. **WARNING-010**: 未使用の定数（must_be_main_instance、button_disabled_template等）
5. **WARNING-012**: ハードコードされたギルド/チャンネルID（統計送信）

その他23件のWARNING（詳細は完全レポート参照）

---

## 📋 優先度別修正計画

### 🚨 即時修正（本日中）

1. ✅ **CRITICAL-021**: データベース認証情報を環境変数化
2. ✅ **CRITICAL-013**: server.jsの未定義変数修正
3. ✅ **CRITICAL-005**: 未定義変数 `msg` を修正
4. ✅ **ERROR-006**: Interaction typeチェック修正
5. ✅ **CRITICAL-014**: ディレクトリトラバーサルチェック修正

### 🔥 高優先度（今週中）

6. **CRITICAL-001**: 未実装コマンドハンドラーを実装
7. **CRITICAL-002**: 未実装設定ハンドラーを実装
8. **CRITICAL-003**: 保存ツイート機能を完成
9. **ERROR-004**: DeepL APIキー設定
10. **WARNING-012**: ハードコードギルドID削除

### 📅 中優先度（2週間以内）

11. ERROR-017-020: 重複コード整理、環境変数化
12. WARNING-008, 009: 設定ハンドラー補完
13. ERROR-022: config.jsonエラーハンドリング
14. WARNING-007: ユーザーID抽出ロジック改善

### 📌 低優先度（1ヶ月以内）

15. その他WARNING問題の修正
16. 未使用コードのクリーンアップ
17. テストファイルの設定
18. ドキュメント整備

---

## 📁 ファイル別問題数

| ファイル | CRITICAL | ERROR | WARNING | 合計 |
|---------|----------|-------|---------|------|
| **index.js** | 5 | 2 | 10 | **17** |
| **server.js** | 3 | 0 | 0 | **3** |
| **src/config/database.js** | 1 | 0 | 0 | **1** |
| **src/config/constants.js** | 0 | 1 | 0 | **1** |
| **migration_of_settings.js** | 0 | 2 | 0 | **2** |
| **update.js** | 0 | 2 | 0 | **2** |
| **test.js** | 0 | 0 | 1 | **1** |
| **moduletest.js** | 0 | 0 | 1 | **1** |
| **その他** | 2 | 1 | 16 | **19** |

---

## 🧪 テスト推奨項目

修正後、以下をテスト:

1. ✅ 全スラッシュコマンドが実行可能
2. ✅ ボタンインタラクションが動作
3. ✅ ツイート保存機能が動作
4. ✅ ダウンロード機能が動作
5. ✅ 翻訳機能が動作
6. ✅ 設定変更が反映される
7. ✅ 引用ツイートの展開が動作

---

## 📊 進捗状況

- [ ] CRITICAL問題: 0/11 修正済み
- [ ] ERROR問題: 0/8 修正済み
- [ ] WARNING問題: 0/28 修正済み

**全体進捗**: 0/47 (0%)

---

**次のステップ**: 即時修正項目から順番に対応していきます。
