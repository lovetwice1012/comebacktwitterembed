# ComebackTwitterEmbed インストール手順

この文書は、Bot本体、通常ダッシュボード、独立管理エージェント、予備のクラウドサーバー上の復旧デーモンを同じGit revisionから配備する手順です。管理エージェントはLLMを使用しません。

## 構成

通常時は次の経路です。

```text
Cloudflare Tunnel
  ├─ cbte.sprink.cloud      → nginx:30987 → Next.js:30989
  ├─ twidata.sprink.cloud   → 保存メディア配信
  └─ cbte.sprink.cloud/ops/ → nginx:30987 → 独立管理コア:30988

Bot (cbte.service)
  ├─ 分析 worker                  : 30990 (loopback)
  ├─ 完全レポート worker           : 30991 (loopback)
  └─ 特権 executor                : Unix socket
```

Bot、Next.js、MySQLに依存しない独立管理コアを先に起動します。予備のクラウドサーバーでは、authority、guardian、controller、独立管理コアを別のsystemdサービスとして動かします。

## 必要条件

本体・予備サーバーとも、対象CPU向けの依存関係をそのホスト上で生成してください。

- Ubuntuなどのsystemd環境、root権限、Python 3、Git、tar、nginx、MySQL 8系
- Node.js **22.12.0以上**（本番BotはNodeで起動し、Bunは使用しない）
- Go **1.25以上**（管理エージェントのビルド時のみ）
- Cloudflare Tunnelのconnector、DNS/Tunnel編集権限
- Discord Bot token。Discord OAuth client ID/secretとOAuth callback登録権限は、管理画面でDiscordログインを使う場合だけ必要
- MySQLのアプリケーションDBと接続資格情報
- Niconicoの動画生成を使う場合は対象OSのffmpeg
- 予備側の暗号化バックアップ復元を使う場合は、NAS exporter、age鍵、SSH経路

本番配布スクリプトはソースを `/root/comebacktwitterembed` に置くことを前提にしています。`/root` 配下をsymlinkで置き換えないでください。

## ソースと秘密設定の準備

```sh
sudo install -d -m 0755 /root
sudo git clone https://github.com/lovetwice1012/comebacktwitterembed.git /root/comebacktwitterembed
cd /root/comebacktwitterembed
git checkout <配備するコミットまたはタグ>
node --version
npm --version
```

`config.json` はGitへ秘密値を追加せず、秘密管理手段からroot所有・`0600`で配置します。最低限、次のキーを用意します。値は実際の資格情報に置き換えてください。

```json
{
  "token": "<DISCORD_BOT_TOKEN>",
  "URL": "<CONSOLE_WEBHOOK_URL>",
  "errorNotificationURL": "<DEPENDENCY_FAILURE_WEBHOOK_URL>",
  "nextAuthSecret": "<RANDOM_SECRET_32_BYTES_OR_LONGER>",
  "dashboard": {
    "enabled": true,
    "port": 30989,
    "publicBaseUrl": "https://cbte.sprink.cloud",
    "clientId": "<DISCORD_OAUTH_CLIENT_ID>",
    "clientSecret": "<DISCORD_OAUTH_CLIENT_SECRET>",
    "useBotGuildApi": false,
    "loadGuildProviderSummary": false,
    "discordApiTimeoutMs": 8000,
    "guildCacheTtlMs": 60000,
    "dbConnectionLimit": 16,
    "delegatedAccessEnabled": true,
    "adminUserIds": ["<OWNER_DISCORD_ID>", "<ADDITIONAL_ADMIN_DISCORD_ID>"],
    "adminAnalyticsPrewarm": false
  },
  "mediaDelivery": {
    "publicBaseUrl": "https://twidata.sprink.cloud",
    "serverMode": "dashboard",
    "useLegacyRoutes": false
  },
  "db": {
    "host": "127.0.0.1",
    "user": "<MYSQL_USER>",
    "password": "<MYSQL_PASSWORD>",
    "database": "ComebackTwitterEmbed",
    "charset": "utf8mb4"
  }
}
```

`URL`は通常のログ転送用、`errorNotificationURL`は依存API障害用の専用Webhookに分けます。Webhook URLやOAuth secretを同じユーザー向け通知先へ流用しないでください。

管理Worker・完全レポートWorker・管理下DashboardのDiscord API呼び出しは、ここで設定した`token`を同じ`DISCORD_BOT_TOKEN`として使用します。`db`を指定した場合は、同じ接続設定をWorkerにも明示的に渡します。OAuthの`clientId`/`clientSecret`はブラウザのDiscordログインを使う場合だけ必要で、Bot API認証の代わりにはなりません。OAuthを使わない場合も、管理コアは生成した初期パスワードまたはPasskeyで利用できます。

```sh
sudo chown root:root /root/comebacktwitterembed/config.json
sudo chmod 0600 /root/comebacktwitterembed/config.json
```

初回だけ、既存DBへスキーマと設定を投入します。既存環境ではバックアップと差分を確認してから実行し、`reset:db`は本番で実行しません。

```sh
npm ci
npm --prefix dashboard ci
npm --prefix dashboard run prisma:generate
npm run init:db
# 旧settings.jsonを移行する場合だけ。既存のMySQL設定を上書きしないこと。
npm run seed:settings -- settings.json
```

## 管理エージェントのビルドと本体配備

依存関係、Prisma client、Next.js buildは本体のCPU・OS上で生成します。

```sh
cd /root/comebacktwitterembed/admin-agent
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/cbte-admin .
```

ARM64ホストでは最後の`GOARCH`を`arm64`にします。ビルドしたバイナリ、`.env`、管理SQLiteをGitへ追加しないでください。

```sh
cd /root/comebacktwitterembed
npm --prefix dashboard run build
sudo bash deploy/admin-platform/install-runtime.sh \
  /root/comebacktwitterembed /tmp/cbte-admin
```

`install-runtime.sh`が行うのは、管理ユーザー・保護された状態ディレクトリ・revision固定runtime・systemd unit・nginx用drop-in・環境ファイルの準備です。サービス起動、Bot再起動、DNS切り替えは行いません。実行時に既存の管理サービスが動作中なら停止を要求して終了するため、無停止更新が必要な場合は新しいreleaseを別途準備して計画的に切り替えます。

初期パスワードを使う場合、生成された`/etc/cbte-admin/bootstrap-password`をrootだけで一度読み取り、管理画面で変更してください。ブラウザへ`ADMIN_AGENT_TOKEN`を渡してはいけません。

初回インストールでBot unitがない場合だけ、既存unitを確認したうえで配置します。

```sh
sudo install -D -m 0644 deploy/systemd/cbte.service \
  /etc/systemd/system/cbte.service
sudo systemctl daemon-reload
```

## nginxとCloudflare Tunnel

`deploy/admin-platform/nginx-gateway.conf`は次を提供します。

- `30987/ops/` → `127.0.0.1:30988`（独立管理コア）
- `30987/` → `127.0.0.1:30989`（通常Next.js）
- `/ops` → `/ops/`の308リダイレクト

既存のserver blockとlistenポートが重複しないよう、現在の設定を確認してから配置します。

```sh
sudo install -m 0644 deploy/admin-platform/nginx-gateway.conf \
  /etc/nginx/sites-available/cbte-admin-gateway
sudo ln -sfn /etc/nginx/sites-available/cbte-admin-gateway \
  /etc/nginx/sites-enabled/cbte-admin-gateway
sudo nginx -t
sudo systemctl reload nginx
```

Cloudflare側では、本体Tunnelの`cbte.sprink.cloud`を`http://localhost:30987`へ向けます。`twidata.sprink.cloud`は、実際の保存メディアを配信する本体側nginx/locationへ向けてください。Tunnelのtoken、origin証明書、DNS設定はリポジトリに含めず、root所有`0600`の外部設定として保管します。

Discord Developer Portalには、使用するOAuth clientへ次のcallbackを登録します。

```text
https://cbte.sprink.cloud/ops/auth/discord/callback
https://cbte-recovery.sprink.cloud/ops/auth/discord/callback
```

管理者IDのallowlistは`deploy/admin-platform/write-config.py`と本体のDashboard設定で同じ値にします。現在の配備値を変更する場合は、コード・設定・テストの3か所を同時に更新してください。

## systemdの起動順序

管理コアはBotと別に起動します。executor → worker → core → Botの順に確認します。

```sh
sudo systemctl daemon-reload
sudo systemctl enable cbte-admin-executor.service
sudo systemctl enable cbte-admin-analysis.service
sudo systemctl enable cbte-admin-reports.service
sudo systemctl enable cbte-admin.service

sudo systemctl start cbte-admin-executor.service
sudo systemctl start cbte-admin-analysis.service
sudo systemctl start cbte-admin-reports.service
sudo systemctl start cbte-admin.service
sudo systemctl enable --now cbte.service
```

保存データの既存ACL修復は管理起動に含まれません。I/Oが安定していることを確認した後、必要な場合だけ小さいバッチで実行します。

```sh
sudo systemctl start cbte-admin-saves-acl.service
sudo journalctl -u cbte-admin-saves-acl.service -n 20 --no-pager
```

### readiness確認

```sh
systemctl is-active cbte.service cbte-admin.service \
  cbte-admin-analysis.service cbte-admin-reports.service
curl -fsS https://cbte.sprink.cloud/api/health
curl -fsS https://cbte.sprink.cloud/ops/healthz
```

`/api/health`は公開経路とノード識別だけを確認する軽量probeです。BotのDiscord Ready、DB、完全レポートの準備完了を意味しません。管理APIの未認証応答が`401`になること、`journalctl`で各サービスのworker接続とSQLite書き込みが進んでいることも確認します。

Bot起動時は、既存のproduction buildがなければDashboard buildを行ってからDiscordへloginします。起動時間を短くするには、更新前に次を実行してbuildを準備します。

```sh
npm --prefix dashboard run build
```

## 予備のクラウドサーバーへの復旧基盤配備

予備側は本体とは別のLinux/ARM64環境で、同じGit revisionからrootと`dashboard`の依存関係を生成します。Windowsやx86_64の`node_modules`、Next SWC、Prisma engineをコピーしません。

予備側で先に、次のroot所有・`0600`設定を用意します。

```text
/etc/cbte-recovery/authority.json
/etc/cbte-recovery/controller.json
/etc/cbte-recovery/bot-config.json
/etc/cbte-recovery/cloudflare-origin-cert.pem
/etc/cbte-recovery/cloudflared.yml
```

`authority.json`にはprimary/oci/controllerの3つの異なるrole token、authority DB、primary enrollment policyを設定します。`controller.json`にはNAS exporter、候補DB、保存領域、status token、controller tokenを設定します。秘密値をこの文書やGitへ書きません。

ARM64向け管理バイナリとreleaseを準備した後、`configure_oci.py`で予備側のworkload、guardian、routing、backup、管理envを生成します。このスクリプトは復旧をarmしたりサービスを起動したりしません。

```sh
cd /opt/cbte-recovery/source
npm ci
npm --prefix dashboard ci
npm --prefix dashboard run prisma:generate
REV="$(git rev-parse HEAD)"
RELEASE="/opt/cbte-recovery/releases/$REV"
sudo install -d -m 0755 "$RELEASE"
git archive "$REV" | sudo tar -x -C "$RELEASE"
sudo cp -a node_modules "$RELEASE/"
sudo cp -a dashboard/node_modules "$RELEASE/dashboard/"
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -C admin-agent \
  -trimpath -o /tmp/cbte-admin .

sudo python3 recovery/configure_oci.py \
  --release-dir "$RELEASE" \
  --node /usr/local/bin/node \
  --admin-binary /tmp/cbte-admin \
  --config-dir /etc/cbte-recovery
```

`--release-dir`は対象アーキテクチャで依存関係・Prismaを生成済みの物理ディレクトリにします。生成後にJSON/envの所有者・`0600`、stateディレクトリの`0700`、cloudflared実行ファイルのroot所有を確認します。

復旧用Pythonとsystemd unitを配置してから、authority → cloudflared/link → workload/controllerの順に起動します。

```sh
find recovery -maxdepth 1 -type f -name '*.py' ! -name 'test_*.py' \
  -exec sudo install -m 0755 {} /opt/cbte-recovery/ \;
sudo install -m 0644 recovery/systemd/*.service /etc/systemd/system/
sudo install -m 0644 recovery/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cbte-recovery-authority.service
sudo systemctl enable --now cbte-recovery-cloudflared.service
sudo systemctl enable --now cbte-recovery-link.service
sudo systemctl enable --now cbte-recovery-controller.service
sudo systemctl enable --now cbte-recovery-workload.service
```

復旧データをNASへ送る場合は、`cbte-recovery-backup.service`とtimer、NAS側の`cbte-nas-exporter.service`を別々に構成します。日次timerの時刻はホストのtimezoneと一致させ、暗号化原本・受領証拠・退役記録を保持します。

## 自動切り替えと切り戻し

予備側の`cbte-recovery-controller.service`が障害検知と予備稼働を担当し、`cbte-recovery-failback.service`が本体復旧後の切り戻しを担当します。切り戻しサービスは予備側に常駐するため、管理者PCやCodexの起動を必要としません。

切り戻し設定はroot所有・`0600`の`/etc/cbte-recovery/failback.json`に置きます。少なくとも次を固定します。

- 本体へのSSH鍵・known_hosts・loopback転送ポート
- authority URL/config、handoff marker、source lease file
- 本体の暗号化スナップショットと復元完了marker
- 本体Tunnel IDと`cbte.sprink.cloud`/`twidata.sprink.cloud`
- ユーザー通知Webhook設定

```sh
sudo systemctl enable cbte-recovery-failback.service
sudo systemctl start cbte-recovery-failback.service
sudo journalctl -u cbte-recovery-failback.service -f
```

本体のDB・管理サービス・guardian・スナップショット・件数検証が揃うまでは予備側workloadを停止しません。切り戻し状態は`/var/lib/cbte-recovery/failback/state.json`へ保存され、成功した段階は再起動後も再開されます。`PRIMARY_ACTIVE`到達後にだけ本体を正本として扱います。

管理画面の「復旧先の手動切り替え・日時予約」から、現在の稼働先とは逆方向への切り替えを即時受付または日時指定で登録できます。予約はcontrollerのroot所有stateへ保存され、実行時に現在epoch、lease、候補・バックアップ、DB、管理サービス、公開経路を再検証します。予約時刻は画面では端末のJSTとして入力し、保存時にUTCへ正規化します。指定時刻は現在から30秒前〜30日後、実行開始前のキャンセルが可能です。条件が変わった場合は所有権を変更せず`blocked`または`failed`で停止します。

OCI方向の手動実行は既存の候補限定昇格処理を通り、primary方向の手動実行は`cbte-recovery-failback.service`の最終同期・writer停止・handoff・lease排水・公開経路検証を通ります。確認チェックを省略してleaseやDBを直接変更する操作は提供しません。

通常のDNS変更だけで切り替えたり、authority SQLiteのepoch/leaseを手編集したりしないでください。失敗時は状態ファイル、authorityのledger、両ホストのsystemd/journalを保存してから再試行します。

## ローカル開発・画面検証

WindowsまたはLinuxで依存関係を準備し、Goバイナリを指定して独立管理の統合環境を起動します。これは一時ディレクトリとloopbackポートを使う検証用です。

```powershell
cd C:\Users\<user>\Documents\comebacktwitterembed
npm ci
npm --prefix dashboard ci
cd admin-agent
go test ./...
go build -o ..\cbte-admin.exe .
cd ..
$env:CBTE_ADMIN_TEST_BINARY = "$PWD\cbte-admin.exe"
$env:CBTE_LOCAL_DASHBOARD = '1'
node scripts/run-admin-platform-local.cjs
```

起動後の検証入口は通常admin `http://127.0.0.1:34187/admin`、独立管理Web `http://127.0.0.1:34188/`です。ローカルの統合パスワードと署名セッションは検証用で、本番認証の代わりにはなりません。画面で送信・設定変更を選んだ場合は実操作になるため、テスト先を限定します。

## 更新とロールバック

1. Git revisionを固定し、root/dashboardの依存関係、Prisma、Goテスト、Nodeテスト、Dashboard型チェックを対象環境で実行する。
2. `cbte-admin`を新revisionでビルドし、`install-runtime.sh`で新しいrelease/runtimeを準備する。
3. `nginx -t`、管理workerのhealth、`/api/health`、管理APIの認証を確認する。
4. 管理サービスだけを計画的に再起動し、Botの切り替えが必要な場合はバックアップとDiscord Gatewayの影響を確認してから`cbte.service`を再起動する。
5. 失敗時は前revisionの`/opt/cbte-admin/current`と`worker-runtime` symlinkへ戻し、state SQLite、Bot DB、保存メディアを削除せずにログを保全する。

`install-runtime.sh`は未コミットの変更を配布しません。更新前に配備対象revision、生成済みbuild ID、設定ファイルのhash、systemdのInvocationIDを記録してください。DBの`reset`、古いqueued操作の再実行、保存lock/PIDの再利用、旧authority leaseの復活はロールバック手順に含めません。

既存の管理SQLiteを新しい要求単位集計へ更新する場合は、管理コアを止めずに次のバックフィルを一度実行します。処理中もBotのイベントは従来のevents表へ保存され、完了後に`request_roots_meta.ready=1`となった照会だけが要約表を使用します。失敗時はreadyが0のままなので従来照会へ戻ります。

```sh
sudo python3 deploy/admin-platform/backfill-request-roots.py \
  --db /var/lib/cbte-admin/state.db
```

予備のクラウドサーバーでは、同じrevisionのスクリプトを使い、`ADMIN_AGENT_STATE_DIR`配下の`state.db`へ実行します。バックフィル後に管理コアだけを計画再起動し、`/v1/metrics`、`/v1/shards`、`/v1/runs`のHTTP応答と`request_roots_meta.ready`を確認します。

## 検証コマンド

```sh
npm test
python3 -m unittest discover -s recovery -p 'test*.py'
(cd admin-agent && go test ./... && go vet ./...)
npm --prefix dashboard run typecheck

systemctl --no-pager --full status cbte.service cbte-admin.service \
  cbte-admin-analysis.service cbte-admin-reports.service
journalctl -u cbte.service -u cbte-admin.service --since '15 minutes ago' --no-pager
curl -fsS https://cbte.sprink.cloud/api/health
curl -fsS https://twidata.sprink.cloud/api/health
```

管理指標では、分母・期間・定義版・欠測を同時に確認します。Discord APIから取得できない閲覧・既読・リンククリックを成功値として補完しません。完全レポートは独立workerの完了済みsnapshotを表示し、再生成失敗時は前回の完成データを保持します。

詳細な運用仕様は次を参照してください。

- [管理エージェント説明](admin-agent/README.md)
- [サポート操作設計](docs/admin-support-console-design.md)
- [指標・統計設計](docs/admin-metrics-and-statistics-design.md)
- [分析デーモン設計](docs/admin-analysis-daemon-design.md)
- [復旧状態の棚卸し](docs/admin-recovery-state-inventory.md)
- [切り戻し設計](docs/admin-failback-design.md)
- [レポートworker](dashboard/ADMIN-REPORT-WORKER.md)
