# 依存関係の確認と更新（2026-11-11）

Mac版通知ツールの作業中に確認したnpm監査では、前段の修正後も中程度の指摘が4件残っていた。JSONストリーミング用 `stream-json` を3.9.0へ更新し、Nodeストリーム用の `parserStream` に呼び出しを合わせた。ZIP作成用 `archiver` は8.0.0を維持し、その依存 `readdir-glob` を4.0.0に固定して、修正済みの `minimatch` を使用する。`archiver` が宣言する依存のメジャーバージョンを上書きしているため、今後の更新時は再確認する。

更新後の `npm audit` は0件。npmのロックファイルからBunのロックファイルを生成し、Bun 1.4.4の `bun install --frozen-lockfile --ignore-scripts` と `bun audit` を隔離環境で実行した結果、監査は0件だった。監査結果は取得時点の既知の指摘に限る。

実際の利用に関わるZIPの個別ファイル追加とglob・除外、GitHub・Twitch・Pixiv・Spotify・BOOTH・YouTubeの通知データ処理、分割文字列・大きな未選択データ・不正データの回帰テストを実行した。Node 24の対象テスト36件、Node 22.12の対象テスト24件、Bun 1.4.4の対象テスト24件が成功。Node 22.12ではCommonJSからESMを読み込む実験的機能の警告が出る。

Bun 1.4.4のローカル通信試験で、Discord用WebSocketに接続前の送信を行うと例外になることを確認した。Discord専用アダプターで従来どおり接続前の送信を無視し、接続後と切断後の挙動は元のWebSocketに委ねる。グローバルのWebSocketと通常の `ws` モジュールは変更しない。隔離環境でREST・WebSocketのローカル通信試験が成功したが、実際のDiscordへの接続はこの試験に含まない。

通常の `npm run typecheck` は、この作業用チェックアウトに実行環境の `config.json` がないため解決できない。実データを作成せず、一時的な型宣言で同ファイルを `any` として扱う限定的な型チェックは成功した。Mac・Safariの実機検証と本番反映は別途必要。
