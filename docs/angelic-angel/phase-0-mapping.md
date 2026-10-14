# Phase 0 Rust → Node.js 機能対照・互換性証拠

Git root: `C:/Users/yussy/Documents/comebacktwitterembed`。
旧Rust CLIは既存Bot本体とは別の外部参考実装であり、Bot本体は既にNode.js。
比較基準は `packages/angelic-angel/legacy-rust/` の8個のRustソースと
元の `Cargo.toml` / `Cargo.lock` / README / LICENSE。基準ファイルは変更しない。
ソースのSHA-256検査は `packages/angelic-angel/scripts/verify-baseline.mjs`。

## 全ファイル・関数の対照

| 元Rustファイル・機能 | Node.js / TypeScript | 比較テスト・根拠 |
|---|---|---|
| `main.rs`: `main`, CLIディスパッチ、終了コード、SIGINT | `src/index.ts`, `src/cli.ts:runCli` | CLI単体、実プロセスSIGINT試験、COMP-CLI |
| `main.rs`: `spinner`, `spin` | `src/cli.ts` の進捗表示・エラー表示 | 人間向けspinner整形は差分として扱う。通信処理・終了コードは維持 |
| `main.rs`: `cmd_init`, 対話・引数指定、設定保存 | `src/cli.ts`, `src/config.ts` | CLI単体、COMP-CLI、COMP-CONFIG |
| `main.rs`: `cmd_register` | `src/cli.ts`, `src/push.ts`, `src/legacy/twitter-registration.ts` | モックCLI一連試験、COMP-WS、COMP-X-REGISTRATION |
| `main.rs`: `cmd_listen` | `src/cli.ts`, `src/listener.ts` | 登録なし、暗号通知→Webhook→ACK、切断・再接続・SIGINT |
| `main.rs`: `cmd_status`, `cmd_unregister` | `src/cli.ts`, `src/autopush.ts:unregister` | COMP-CLI、COMP-WS。状態保存・登録削除 |
| `cli.rs`: `Cli`, `Commands`, 全5サブコマンド、`-c/--config`, `-v/--verbose`, `-h/--help` | `src/cli.ts:parseCli`, `help`, `runCli` | CLI引数単体、COMP-CLI。省略・不正引数・終了コード |
| `config.rs`: `Config`, `TwitterConfig`, `WebPushKeys`, `AutoPushSession`, `Registration` | `src/config.ts` の同名interface | COMP-CONFIG。未知フィールドの無視、必須フィールド・文字列・u8配列検査 |
| `config.rs`: `Config::load`, `Config::save`, `get_webhook_endpoint` | `loadConfig`, `saveConfig`, `getWebhookEndpoint` | COMP-CONFIG、COMP-WEBHOOK。双方向TOML、実ファイル読み書き、未設定ENV |
| `error.rs`: 全11エラー型・変換・表示 | `src/errors.ts:AngelicAngelError`, `safeError`、各モジュールの境界変換 | 型別単体、CLIエラー、ACK101/102、秘密値漏洩試験。低水準文言は安全な定型へ変更 |
| `push.rs`: `PushSubscription`, `generate_keys`, `subscribe` | `src/push.ts:generateKeys`, `subscribe` | COMP-CRYPTO。65-byte SEC1公開鍵、32-byte秘密鍵、16-byte auth secret、再購読時の新規鍵 |
| `autopush.rs`: 全message/response型、`AckCode`, `Notification`, `ConnectResult`, `ReregistrationInfo` | `src/autopush.ts` のinterface/union/enum | COMP-PROTOCOL。serdeと同一フィクスチャ、Option省略/null、u16・型・未知タグ・重複既知field |
| `autopush.rs`: `connect_ws`、TLS、UA/Origin、TCP keepalive/NODELAY | `AutoPushClient.connect` | ローカルWS/WSS・TLS拒否・TCPソケット試験。UAは旧値保持、追加の偽装なし |
| `autopush.rs`: `register_new`、HELLO→REGISTER→close | `registerNew`, `AutoPushClient.hello`, `AutoPushClient.register` | COMP-WS。空UAID、`channelIDs`省略、VAPID key、UUID、endpoint |
| `autopush.rs`: `connect_and_listen`、UAID一致・変更→新規鍵/登録 | `connectAndListen` | UAID一致・変更・登録失敗。旧再登録経路は明示許可時のみ実行 |
| `autopush.rs`: `is_pong`, `is_backoff_close` | `isPong`, `isBackoffClose` | COMP-KEEPALIVE、COMP-WS。`{}` / messageTypeなしobject、close4774 |
| `autopush.rs`: `next_notification`、timer reset、binary/nonnotification無視、duplicate100件queue | `AutoPushClient.nextNotification` | COMP-WS、AutoPush結合試験。version単独・別CHIDも重複としてACK100、FIFO100件 |
| `autopush.rs`: `wait_for_pong_or_notification`、request timeout | `AutoPushClient.waitForPongOrNotification` | ping/pong・通知割込・timeout・4774・close試験。Rustの通知割込時dedupe bypassを保持 |
| `autopush.rs`: `ack_notification`, `uaid`, `channel_id`, `unregister` | `ack`, `ackNotification`, `ack_notification`, `uaid`, `channelId`, `channel_id`, `unregister` | COMP-WS。ACK100/101/102、UNREGISTER code200、HELLO検査 |
| `listener.rs`: `SessionOutcome`, `calc_backoff`, `listen`, `listen_once` | `src/listener.ts:listen`, `calcBackoff` | COMP-KEEPALIVE。未接続5→10→20→…300秒、接続後1秒、4774後1800秒、fatal停止 |
| `listener.rs`: `try_connect`、X再登録→更新保存→再接続 | `tryConnect` | ローカルモック失効・新規鍵・設定再読込/保存・2度目失効fatal。既定はX登録停止 |
| `listener.rs`: `run_notification_loop`, `is_decryption_error` | `processNotification`, `listen` | 復号失敗101、他失敗102、空通知100、ACK失敗で再接続 |
| `listener.rs`: `handle_notification_data`, UTF8、JSON/raw fallback | `handleNotificationData`, `src/crypto.ts:decryptNotification` | COMP-WEBHOOK、COMP-CRYPTO-GOLDEN。不正UTF8、JSON number境界、raw文字列、BOM、surrogate/recursion |
| `listener.rs`: `send_to_webhook` | `sendToWebhook` | COMP-WEBHOOK。JSON POST、ネットワーク失敗、HTTP非成功、有限timeout |
| `listener.rs`: `decrypt_ece`, `decrypt_aesgcm`, `parse_header_param` | `src/crypto.ts:decryptEce`, `parseHeaderParam` | COMP-CRYPTO、COMP-CRYPTO-GOLDEN、COMP-KEEPALIVE。両ECE方式の同一ciphertextと双方向暗号相互運用 |
| `twitter.rs`: `register`, `register_push_subscription`, bearer/device固定値、Cookie/header/body/status/json | `src/legacy/twitter-registration.ts:register`, `buildRegistrationRequest`, `assertLegacyPermission` | COMP-X-REGISTRATION。元Rustの実HTTP requestとNodeをloopbackで比較。機密response bodyは表示しない |

表は全8ファイルの全責務を含む。互換性の証拠は実行成功と対応して更新する。
未実施を成功と扱わない。Node CLIからRustへの実行委譲は行わない。

## 差分の扱い

設定・protocol・復号平文・HTTP要求の意味値はRustと一致させる。
TOMLの順番・整形、JSON object key順、spinner描画、OS固有の例外文言は
正規化可能な表示差とする。次の安全性変更は隠さず記録する。

| 差分 | 元Rust | Node版・理由 |
|---|---|---|
| 秘密値の表示 | statusにCookie先頭、UAID/CHID、endpoint。debugにheader/body、INFOに平文 | `[REDACTED]` と機密を含まない構造化イベント。MIG-008で指定 |
| 危険な旧X登録 | registerおよびUAID変更時に自動でCookie付非公開APIを呼ぶ | 旧実装の全経路を隔離して保持。明示的な各実行の許可時だけ有効。既定では送信前に失敗 |
| Webhook非2xx | 警告のみで成功を返しACK100 | Httpエラー、ACK102。配信失敗をDeliveredにしない。MIG-005/006の旧不具合修正として試験 |
| HTTP timeout/redirect | 明示的な有限timeoutなし。reqwest既定のredirect | 有限timeout。旧X登録はredirect拒否。Webhookは10回上限・method切替・Basic認証を維持し、別originへAuthorizationを渡さない |
| 設定保存 | 直接上書き | 保存前バックアップ、秘密ファイル権限、temporary→atomic rename。TOML形式の変更なし |
| 診断詳細 | header/encoding/HTTP response bodyを例外へ含む | error categoryとACKを保持し、秘密を含む可能性のある値は固定文言へ変更 |
| 壊れたlegacy ECE・ローカル鍵 | `ece 2.3.1` debugで16byte未満blockの減算、または不正なpublic componentのunwrapがpanicしうる | 制御されたDecryptionエラー。鍵・状態を変更せずACK101。COMP-CRYPTO-GOLDEN / COMP-KEY-EXCEPTIONSで元のpanicも観測 |
| 対話入力 | `ct0`通常input、auth_token password | 両方を表示しないsecret入力。引数指定の機能は保持 |

## Rust oracleの独立性

`compat-rust` の比較用crateは元のlockfileを基に依存を固定し、
`ece=2.3.1`を使用する。元CLI binaryは旧 `main.rs` を直接compileする。
private helperのoracleはbuild outputへ旧moduleをcopyし、同module内へ
test wrapperを追加する。通信はloopback endpointに差し替え、必要なtimerのみ
試験用に短縮できる。基準ディレクトリは書き換えない。

Rust oracleとNodeへ同じfixtureを与える。双方の自己roundtripだけでは
暗号互換の証拠としない。Rustが暗号化したpayloadをNodeで復号し、
Nodeの独立fixture builderが暗号化したpayloadをRust ECEで復号する。
公開ECE vector、改ざん、長さ不正、padding、多record、UTF8不正を
同じgolden fileで両方へ投入する。比較binary不在の場合は失敗する。

比較基盤で実行したRust補助確認は次のとおり。Rustに元々unit testが
存在しないため、`cargo test`だけを機能互換の証拠としない。

| 確認 | 実測結果 |
|---|---|
| `cargo build --locked` | 元CLI binary・oracle binaryとも成功。Windows MSVC、vendored OpenSSL |
| `cargo test --all-targets --locked` | 成功。両binaryともRust unit testは0件。実機能の比較はJSから実binaryへ入力する13組のCOMP suite |
| oracle自身の4Rustファイル `rustfmt --check` | 成功 |
| 全crate `cargo fmt -- --check` | 失敗。保持した旧ソースの既存import順・折返し。比較基準を変更しない |
| `cargo clippy --all-targets -- -D warnings` | 失敗。旧ソース由来の `ptr_arg` / `result_large_err` / `large_enum_variant` / `collapsible_if`。元CLI35件、同ソースを含むoracle30件。新Node版のlint判定とは分ける |

## MIG追跡

| 要件 | 実装・試験対象 | 受入の確認 |
|---|---|---|
| MIG-001 | 全CLI、help、対話、SIGINT、exit | COMP-CLI + CLI単体/プロセス |
| MIG-002 | TOML/ENV、旧byte array、optional登録 | COMP-CONFIG + config単体 |
| MIG-003 | AutoPush全wire/登録/解除/ACK/UAID/unknown/close | COMP-PROTOCOL、COMP-WS、AutoPush結合 |
| MIG-004 | P256/HKDF/ECE両方式 | COMP-CRYPTO、COMP-CRYPTO-GOLDEN |
| MIG-005 | socket/TLS/ping/keepalive/retry/4774 | COMP-KEEPALIVE + AutoPush/listener結合 |
| MIG-006 | HTTP送達・エラー・timeout・ACK | COMP-WEBHOOK + listener結合 |
| MIG-007 | 永続設定・新規/失効/再起動 | COMP-CONFIG + CLI/listener結合 |
| MIG-008 | secret redaction・legacy隔離 | COMP-CLI + エラー/ログ漏洩試験 |
| MIG-009 | strict TypeScript、locked Node/npm、build/start/lint/typecheck/test | clean installと全品質command |
| MIG-010 | 真の同fixture Rust↔Node比較 | `tests/compatibility.test.mjs`、Rust oracle |
| MIG-011 | CLI/config/crypto/WS/webhook回帰保護 | 各test suite全成功 |
| MIG-012 | 新方式と分離 | Phase 0 packageのみ。Firefox移譲・Gateway・新DBは未着手 |
| MIG-013 | 全8ファイル・全責務対応 | 本表、retained source hash検査 |
| MIG-014 | G0完了判断 | 上記成功・clean install・証拠集計後のみ |

G0の最終合否および実行件数は親作業のレビュー記録で確定する。
この表の存在だけで合格とはしない。

## 既存実サービスの接続点と容量要件（調査のみ）

現在の `src/automation/entitlements.js` の `inspectPlan` はユーザー単位の
planをサーバー側で解決する。管理者の有効な有償割当を優先し、次に
現merchant/environmentのSquare verified contractと有効期限を検査する。
支援者は `users.is_donor` または有効なSquare donation grantで判定する。
`users.additional_auto_extract_slots` とdonation addonは既存枠に加算される。

既存 `automation_notification_slots` はautoとpriceのtargetおよび確認間隔短縮の
boostと共有するユーザー単位枠である。ownerの `users` rowを `FOR UPDATE`
でlockし、割当・解放・downgrade・既存targetのadoptを直列化する。
組み込み無料/支援者の初期値はいずれも5枠。有償planは
`automation_notification_plans` のDB設定であり、コードに固定のbasic planや
上位plan順序はない。本番basic登録はユーザーの申告であり、この工程で
本番DBを参照して確認した事実ではない。

ユーザー指定を新方式の要件として次のように保持する。

| pool | 総容量 | 既存ユーザー枠との関係 |
|---|---|---|
| 無料共有pool | 全ユーザー合計50 | 新機能のglobal capacity。既存各ユーザーの5枠を50に変更しない |
| 支援者優先共有pool | 合計100 | 無料poolと別に計数し、無料枠を奪わない |
| 有償special allocation | basic以上、planごとに設定 | 使用時に既存ユーザー単位枠も消費する。具体的quotaは未指定 |

basic以上の判定・各planのspecial quotaは既存DBのplan ID/priorityから
推測しない。管理者が指定するeligible plan設定とspecial quotaに結び付ける
設計が必要。名称・金額・priorityの大小で勝手に有償順位を作らない。
1枠は利用者が通知を監視するXアカウント1件とユーザーが明示した。
購読/UAIDの受信接続数とは別に数える。支援者poolから無料poolへの自動振替は
行わず、quota縮小時も既存登録を勝手に削除しない。実割当はG1後に検証する。

後続の実装対象は既存契約を再利用する。

| 対象 | 既存の接続点 |
|---|---|
| 認可・有償/支援者判定・ユーザー枠 | `src/automation/entitlements.js`, `square-billing.js`, `square-donations.js`, `schema.sql.js` |
| 管理者の支援者設定 | `src/commands/handlers/autoextract/additionalautoextractslot.js`。`is_donor=1`を明示設定 |
| YAML/JSON読み書き | `src/automation/format.js`。YAML1.2、duplicate key拒否、alias無効、schema検査、安全な構文エラー |
| 既存rule・event・queue | `src/automation/engine.js`, `evaluation.js`, `evaluation-worker.js`, `queue.js`, `flow-runtime.js` |
| 通知先と配送の境界 | `src/automation/destinations.js`, `transport.js`, `delivery-gate.js`, `fanout.js` |

Phase 0でこの容量poolやFirefox内部鍵のimport、分散Gateway、新DB/APIを
本実装しない。既存のdirtyなBot/dashboard変更を巻き戻さない。
実X・Mozillaへの接続、Firefox実機、Mac/Linux実機、本番DB/Discord配送は
この比較試験の証拠に含まれない。
