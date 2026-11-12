# Mac Edge のセッション排他：研究設計

この設計は未実装です。研究 addon は候補アプリから読み込まず、利用者データや本番設定を変更しません。

## 対象と境界

同時起動の片方が旧 index を読み、もう片方が新プロフィールへ切替えた後に旧設定を続ける競合を防ぎます。排他は index 読取前に取得し、設定の中止・ファイル保存・明示的な切替のすべてが完了するまで保持します。既存の registry lock とプロフィール lease はそれぞれの領域の保護として残します。どれか一つでも取得できない場合は作業を開始しません。

session lock は setup を実行する Node 本体内の Node-API addon が保持する案です。別 helper の終了により Node が動作中のまま lock だけ失われる問題を避けます。[Node 24.21.0 の Node-API](https://nodejs.org/download/release/v24.21.0/docs/api/n-api.html) の環境ごとの状態と cleanup を使用します。`flock` は協調ロックであり、すべての設定経路が参加する必要があります。既存の fcntl helper と混在させて排他できると仮定しません。

## 所有権と終了

- lock 用ファイルは専用の私有ディレクトリに置き、通常時に unlink しません。最初に既存の通常ファイルか、新規作成したファイルかを区別し、所有者・mode・単一リンク・inode を検証します。
- 可能な部分は検証した親 directory の descriptor から `openat` と `O_NOFOLLOW` を使い、親階層と最終ファイルの identity を検証します。名前変更や同じ UID による unlink／置換に対する残る競合を明示し、同一 inode の確認ができないときは停止します。研究試験では inode 置換による排他回避が再現しています。
- descriptor は addon 内で保持し `O_CLOEXEC` を設定します。JS に生の descriptor を渡さず、子の明示 unlock や意図しない close を防ぎます。Node の spawn における descriptor 制限と CLOEXEC 自体の動作は別に検証します。
- 同一 process の複数 environment／worker を含め、単一の process-wide guard で同時取得を拒否します。環境終了時に他の environment の lock を誤って解除せず、取得者の終了時に必ず後片付けする設計が必要です。研究版では worker 終了時に lock が残る負例を確認しています。
- cleanup は実行中の filesystem 操作とブラウザーの終了が確認できた後に行います。通常の JS のタイマーや abort だけでは、停止に応じない操作の終了を保証できません。操作の所有・完了を追跡し、追跡できない場合は lock を解放せず停止します。worker 強制終了の際に進行中の操作が収束することも、導入前の検証条件です。
- close の失敗や所有権の不一致は不確定として以後の操作・再取得を拒否します。プロセスが異常終了した場合は OS の descriptor 解放に依存しますが、古い registry lock やプロフィール lease の回復は別問題です。index／backup の同期順と失敗時の復旧手順を保持します。

## 配布時に必要な変更

研究版は配布物に含めません。採用する場合は両 CPU 向けに固定 Node 24.21.0 と互換性のある addon をビルドし、実行時に検証できるよう署名済み addon の identity と hash を manifest に結び付けます。署名は manifest 作成前に行い、Node と addon を含む app 全体の署名、Apple 公証、ZIP 展開後の signature／manifest／Gatekeeper 検証を追加します。既存の `MacLevelDB.node` の検証を弱めず、ビルド元・architecture・Node-API の互換性も検査します。

未接続の v2 研究版は、環境終了時に操作中でなければ lock を閉じ、追跡中の操作が残る場合はプロセス終了まで lock を保持して再取得を拒否します。親ディレクトリ descriptor と lock file の identity を開始・終了時に確認します。実装自体の Mac コンパイル・実行、両 CPU と署名はこれからの検証です。名前の検査と実際の変更の間の同一 UID による置換を防ぐものではなく、合成試験の成功もその競合窓を閉じた証明にはなりません。

研究 addon の filesystem syscall は同期実行です。OS 側で長時間停止した場合に JS のタイマーで復帰させる保証はなく、UI の応答性と停止時の扱いは未解決です。

## 実証条件

専用の合成ディレクトリとプロフィールで、両 CPU それぞれに次を検証します。

1. 旧 index を読む前に session lock を取得し、競合する設定は index に触れず停止する。
2. 実 registry と rotation を用い、競合する別 process が切替中に旧プロフィールで作業しない。旧 profile・backup・現在 index が保全される。
3. 同一 process 内の複数 environment／worker の取得、正常 cleanup、worker 強制終了、進行中の filesystem 操作の収束を確認する。
4. stale な lock ファイル、別 FD の close、Node spawn と descriptor の非継承、close 失敗注入、親／最終 inode 置換で fail-closed になる。
5. owner SIGKILL や強制終了後の再取得と、途中で失敗した index／backup の検証・復旧を確認する。OS 障害の注入と実際の障害は区別する。
6. 署名済み候補を展開して固定 Node から addon を読み込み、署名・manifest・公証と Finder 経由を検証する。

上記の完了前に利用者向け入口に接続しません。実 X、WNS 停止中の通知欠落、長期互換性は別の公開条件です。
