# X通知の抽出とファイル保存を担当します。GUI/CLIが配布物と所有確認を終えた後に呼びます。
# 読み取りには、Firefoxの通知データだけをコピーした作業用の保存場所を使います。
# 作業用データの片付け後、ほかのサイトの通知があれば扱いを説明し、同意を確認します。
# X通知を読むための秘密情報は、利用者が指定した新しいファイルにだけ保存します。

function Set-XSetupNewPathPrivateAcl {
    param([string] $Path, [switch] $File)
    Assert-SafePath $Path
    if ($File) { $acl = New-Object Security.AccessControl.FileSecurity }
    else { $acl = New-Object Security.AccessControl.DirectorySecurity }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($script:UserSid, $script:SystemSid)) {
        if ($File) {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,
                [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
        }
        else {
            $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl,
                $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        }
        $null = $acl.AddAccessRule($rule)
    }
    if ($File) { $info = New-Object IO.FileInfo($Path) } else { $info = New-Object IO.DirectoryInfo($Path) }
    if ($PSVersionTable.PSVersion.Major -le 5) { $info.SetAccessControl($acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl($info, $acl) }
}

function Write-XSetupNewText {
    param([string] $Path, [string] $Text)
    Assert-SafePath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $script:Utf8.GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally { $stream.Dispose() }
}

function Get-XSetupOwnedUaid {
    # prefs.js全体をJSONや文字列として保持しません。対象prefの1行だけを厳格に採用します。
    # ブラウザーが生成したファイルを行単位で走査し、それ以外の設定値は保存・表示しません。
    $path = [IO.Path]::Combine($script:ProfilePath, 'prefs.js')
    Assert-SafePath $path
    $info = New-Object IO.FileInfo($path)
    if (-not $info.Exists -or $info.Length -gt 8388608) { throw 'X_SETUP_UAID_UNAVAILABLE: 専用Firefoxの通知識別情報を確認できません。' }
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $reader = New-Object IO.StreamReader($stream, $script:Utf8, $true, 4096)
    $uaid = $null
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            if ($line.Length -gt 65536) { throw 'X_SETUP_PREF_FORMAT_REJECTED: 専用Firefoxの設定形式に対応できません。' }
            if ($line.Contains('dom.push.userAgentID')) {
                $match = [regex]::Match($line, '^\s*user_pref\(\s*"dom\.push\.userAgentID"\s*,\s*"([0-9a-f-]+)"\s*\);\s*$')
                if (-not $match.Success -or $null -ne $uaid) { throw 'X_SETUP_UAID_INVALID: 通知識別情報が重複しているか、形式が無効です。' }
                $value = $match.Groups[1].Value
                if ($value -cnotmatch '^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$') {
                    throw 'X_SETUP_UAID_INVALID: 通知識別情報の形式に対応できません。'
                }
                $uaid = $value
            }
        }
    }
    finally { $reader.Dispose() }
    if ($null -eq $uaid) { throw 'X_SETUP_UAID_UNAVAILABLE: X通知の識別情報がありません。専用Firefoxで手動設定してください。' }
    return $uaid
}

function Copy-XSetupPushSnapshot {
    param([string] $ReaderProfile)
    $source = [IO.Path]::Combine($script:ProfilePath, 'storage', 'permanent', 'chrome', 'idb')
    Assert-SafePath $source
    $destination = [IO.Path]::Combine($ReaderProfile, 'storage', 'permanent', 'chrome', 'idb')
    $null = [IO.Directory]::CreateDirectory($destination)
    $handles = New-Object 'Collections.Generic.List[object]'
    $total = [long]0
    try {
        # 既知Push DBのbasenameだけを対象にします。Cookie/履歴/permissions/storage.sqlite等はコピーしません。
        foreach ($suffix in @('.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal')) {
            $path = [IO.Path]::Combine($source, ('2918063365piupsah' + $suffix))
            Assert-SafePath $path
            $attributes = Get-PathAttributes $path
            if ($null -eq $attributes) {
                if ($suffix -eq '.sqlite') { throw 'X_SETUP_PUSH_DATABASE_MISSING: 専用Firefoxに通知情報が見つかりません。' }
                continue
            }
            if ($attributes -band [IO.FileAttributes]::Directory) { throw 'X_SETUP_PUSH_DATABASE_INVALID: 通知保存先の形式が無効です。' }
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $handles.Add([pscustomobject]@{ Stream = $stream; Name = [IO.Path]::GetFileName($path) })
            $total += $stream.Length
            if ($stream.Length -gt 67108864 -or $total -gt 134217728) { throw 'X_SETUP_PUSH_DATABASE_TOO_LARGE: 通知保存データが対応範囲を超えています。' }
        }
        foreach ($entry in $handles) {
            $target = [IO.Path]::Combine($destination, $entry.Name)
            Assert-SafePath $target
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $entry.Stream.CopyTo($output); $output.Flush() }
            finally { $output.Dispose() }
        }
        # Push DB自身の添付blob領域だけを許可します。別DBの.filesへはアクセスしません。
        $files = [IO.Path]::Combine($source, '2918063365piupsah.files')
        Assert-SafePath $files
        if ([IO.Directory]::Exists($files)) {
            $queue = New-Object 'Collections.Generic.Queue[string]'
            $queue.Enqueue($files)
            $count = 0
            while ($queue.Count -gt 0) {
                $directory = $queue.Dequeue()
                $targetDirectory = [IO.Path]::Combine($destination, '2918063365piupsah.files' + $directory.Substring($files.Length))
                Assert-SafePath $targetDirectory
                $null = [IO.Directory]::CreateDirectory($targetDirectory)
                foreach ($entry in [IO.Directory]::GetFileSystemEntries($directory)) {
                    Assert-SafePath $entry
                    $count++
                    if ($count -gt 512) { throw 'X_SETUP_PUSH_DATABASE_TOO_LARGE: 通知の添付領域が対応範囲を超えています。' }
                    if ([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory) { $queue.Enqueue($entry) }
                    else {
                        $input = [IO.File]::Open($entry, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                        try {
                            $total += $input.Length
                            if ($input.Length -gt 33554432 -or $total -gt 134217728) { throw 'X_SETUP_PUSH_DATABASE_TOO_LARGE: 通知の添付領域が大きすぎます。' }
                            $target = [IO.Path]::Combine($targetDirectory, [IO.Path]::GetFileName($entry))
                            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                            try { $input.CopyTo($output); $output.Flush() } finally { $output.Dispose() }
                        }
                        finally { $input.Dispose() }
                    }
                }
            }
        }
    }
    finally { foreach ($entry in $handles) { $entry.Stream.Dispose() } }
}

function Remove-XSetupOwnedScratch {
    param([string] $Path, [string] $Token, [string] $ProfileId)
    # 再帰削除できるのは、今回自分が作った名前・場所・マーカーが全て一致する作業先だけです。
    $expected = [IO.Path]::Combine($script:Root, ('export-scratch-' + $Token))
    if ($Path -cne $expected -or $Token -cnotmatch '^[0-9a-f]{32}$') { throw 'Scratch path mismatch' }
    Assert-SafePath $Path
    $markerPath = [IO.Path]::Combine($Path, 'scratch-owner.json')
    $marker = Read-SmallJson $markerPath
    if ($marker.appId -cne $script:AppId -or $marker.token -cne $Token -or $marker.profileId -cne $ProfileId) { throw 'Scratch ownership mismatch' }
    $directories = New-Object 'Collections.Generic.List[string]'
    $files = New-Object 'Collections.Generic.List[string]'
    $directories.Add($Path)
    for ($index = 0; $index -lt $directories.Count; $index++) {
        foreach ($entry in [IO.Directory]::GetFileSystemEntries($directories[$index])) {
            Assert-SafePath $entry
            if ([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory) { $directories.Add($entry) }
            elseif ($entry -cne $markerPath) { $files.Add($entry) }
        }
    }
    # 全件のreparse検証を終えてから削除を始めます。所有マーカーは最後まで残します。
    foreach ($file in $files) {
        [IO.File]::SetAttributes($file, ([IO.File]::GetAttributes($file) -band (-bnot [IO.FileAttributes]::ReadOnly)))
        [IO.File]::Delete($file)
    }
    for ($index = $directories.Count - 1; $index -gt 0; $index--) { [IO.Directory]::Delete($directories[$index], $false) }
    [IO.File]::Delete($markerPath)
    [IO.Directory]::Delete($Path, $false)
}

function Write-XSetupProtectedExport {
    param([string] $Path, [string] $Text)
    # CreateFileのSECURITY_ATTRIBUTESへprivate DACLを渡し、生成する瞬間から共有不可・本人+SYSTEMにします。
    # 生成後にACLを付けるまでの競合時間を作りません。既存ファイルはCREATE_NEWにより拒否します。
    $created = $false
    $stream = $null
    try {
        Assert-SafePath $Path
        Initialize-XSetupReaderJob
        $stream = [XSetupNative.ReaderJob]::CreatePrivateFile($Path, $script:UserSid.Value)
        $created = $true
        $bytes = $script:Utf8.GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose(); $stream = $null }
        if ($created) { Assert-SafePath $Path; [IO.File]::Delete($Path) }
        throw 'X_SETUP_EXPORT_FILE_FAILED: 新しい保存ファイルを安全に作成できませんでした。既存ファイルは上書きしていません。'
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Show-XSetupOtherNotificationsConsent {
    param([string] $Message)
    # GUIから起動された子PowerShellにだけ表示します。既定は「いいえ」です。
    # 親画面は抽出終了を待ちながら応答を保ち、二重操作を禁止しています。
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object Windows.Forms.Form
    try {
        $owner.ShowInTaskbar = $false
        $owner.TopMost = $true
        return ([Windows.Forms.MessageBox]::Show($owner, $Message, 'ほかのサイトの通知について',
            [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning,
            [Windows.Forms.MessageBoxDefaultButton]::Button2) -eq [Windows.Forms.DialogResult]::Yes)
    }
    finally { $owner.Dispose() }
}

function Confirm-XSetupOtherNotifications {
    param($OtherSubscriptionCount, [switch] $AllowOtherNotifications, [switch] $PromptForOtherNotifications)
    # 件数は補助JSの固定形式から来ます。不明・欠落を0件と読み替えて確認を飛ばしません。
    # 値が変換可能な文字列や小数でも拒否し、索引の上限64件のうちXの1件を除いた範囲に限定します。
    if (($OtherSubscriptionCount -isnot [int] -and $OtherSubscriptionCount -isnot [long]) -or
        $OtherSubscriptionCount -lt 0 -or $OtherSubscriptionCount -gt 63) {
        throw 'X_SETUP_READER_FAILED: Xの設定用Firefoxを閉じて、もう一度お試しください。ほかのサイトの通知件数を確認できませんでした。'
    }
    if ($OtherSubscriptionCount -eq 0) { return }
    $message = "このFirefoxには、X以外のサイトの通知設定も $OtherSubscriptionCount 件あります。`r`n`r`n" +
        "作成するファイルに入るのは、X用の通知情報と鍵だけです。`r`n`r`n" +
        "通知の受け取り先は共通なので、アップロード後に受信を始めると、ほかのサイトの暗号化された通知データや識別情報もサーバーへ届く可能性があります。受信したデータは、技術的には取得・保存できます。`r`n`r`n" +
        "現在は、ほかのサイトの通知を保存・復号・利用せず、受信時に破棄します。利用を始める際は、別途、明確な許可を確認します。`r`n" +
        "破棄した通知は、後からFirefoxなどで受け取れない場合があります。`r`n`r`n" +
        "この扱いを確認して、ファイルを作りますか？"
    if ($AllowOtherNotifications) {
        # CLIでは、この説明を読んで明示したスイッチを今回の保存にだけ適用します。
        # 状態やマーカーへ同意を保存しないので、次回は改めて指定が必要です。
        [Console]::Error.WriteLine($message)
        return
    }
    if (-not $PromptForOtherNotifications) {
        throw ('X_SETUP_OTHER_NOTIFICATIONS_CONSENT_REQUIRED: ' + $message +
            "`r`n説明を確認して作成する場合だけ、-AllowOtherNotifications を明示して再実行してください。")
    }
    if (-not (Show-XSetupOtherNotificationsConsent $message)) {
        throw 'X_SETUP_EXPORT_CANCELLED: ファイル作成をキャンセルしました。作成するときは、もう一度お試しください。'
    }
}

function Invoke-XSetupExport {
    param($Owner, [string] $OutputPath, [string] $FirefoxExecutable, [string] $CancellationPath,
        [switch] $AllowOtherNotifications, [switch] $PromptForOtherNotifications)
    $currentOwner = Get-Owner
    if ($null -eq $currentOwner -or $currentOwner.profileId -cne $Owner.profileId) { throw 'X_SETUP_OWNER_INVALID: このツールで準備した保存場所をご確認ください。保存場所の管理情報が一致しませんでした。' }
    $state = Get-LaunchState $Owner
    if ($state.active -or $state.locked) { throw 'X_SETUP_PROFILE_BUSY: 専用Firefoxを完全に閉じてから、もう一度実行してください。' }
    $lockPath = [IO.Path]::Combine($script:ProfilePath, 'parent.lock')
    Assert-SafePath $lockPath
    if ($null -eq (Get-PathAttributes $lockPath)) {
        throw 'X_SETUP_EXPORT_NO_SUBSCRIPTION: Xの設定用Firefoxで投稿通知とブラウザー通知を有効にし、Firefoxを閉じてからファイルを作成してください。'
    }
    $output = Get-LocalPath $OutputPath
    Assert-SafePath $output
    Initialize-XSetupReaderJob
    if (-not [XSetupNative.ReaderJob]::SupportsPrivateAcl($output)) { throw 'X_SETUP_OUTPUT_ACL_UNSUPPORTED: このPCの「ドキュメント」など、本人だけが読めるように保護できる保存先を選んでください。指定した保存先では、この保護を利用できません。' }
    if ((Test-InPath $output $script:Root) -or (Test-InPath $output $script:PackageRoot) -or
        $null -ne (Get-PathAttributes $output) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($output))) {
        throw 'X_SETUP_OUTPUT_PATH_REJECTED: 専用保存先と配布フォルダーの外に、まだ存在しないファイル名を指定してください。'
    }
    if (-not [string]::IsNullOrWhiteSpace($CancellationPath)) { $CancellationPath = Get-LocalPath $CancellationPath; Assert-SafePath $CancellationPath }
    if (-not [string]::IsNullOrWhiteSpace($CancellationPath) -and [IO.File]::Exists($CancellationPath)) {
        throw 'X_SETUP_EXPORT_CANCELLED: ファイル作成を中止しました。'
    }
    $token = [Guid]::NewGuid().ToString('N')
    $scratch = [IO.Path]::Combine($script:Root, ('export-scratch-' + $token))
    $job = $null
    $profileLease = $null
    $scratchCreated = $false
    $cleanupFailed = $false
    $document = $null
    $otherSubscriptionCount = $null
    try {
        Assert-SafePath $scratch
        $null = New-Item -ItemType Directory -Path $scratch -ErrorAction Stop
        Set-XSetupNewPathPrivateAcl $scratch
        Write-NewJson ([IO.Path]::Combine($scratch, 'scratch-owner.json')) ([ordered]@{ appId = $script:AppId; token = $token; profileId = $Owner.profileId })
        $scratchCreated = $true
        $profile = [IO.Path]::Combine($scratch, 'reader-profile')
        $application = [IO.Path]::Combine($scratch, 'reader-application')
        $resultPath = [IO.Path]::Combine($scratch, 'reader-result.json')
        $null = [IO.Directory]::CreateDirectory($profile)
        $lockPath = [IO.Path]::Combine($script:ProfilePath, 'parent.lock')
        Assert-SafePath $lockPath
        if ($null -eq (Get-PathAttributes $lockPath)) {
            throw 'X_SETUP_PUSH_NOT_READY: 専用FirefoxでXへログインして通知を手動設定し、ブラウザーを閉じてから実行してください。'
        }
        $copy = Copy-XSetupFirefoxApplication $FirefoxExecutable $application
        if (-not [string]::IsNullOrWhiteSpace($CancellationPath) -and [IO.File]::Exists($CancellationPath)) {
            throw 'X_SETUP_EXPORT_CANCELLED: ファイル作成を中止しました。'
        }
        # 元profileの既知ロックを共有不可で保持し、コピー中のFirefox再起動を防ぎます。
        try { $profileLease = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
        catch { throw 'X_SETUP_PROFILE_LOCK_FAILED: 専用Firefoxの停止状態を確認できません。専用ブラウザーを完全に閉じて再実行してください。' }
        $uaid = Get-XSetupOwnedUaid
        Copy-XSetupPushSnapshot $profile
        $profileLease.Dispose(); $profileLease = $null
        Write-XSetupReaderConfiguration $application $profile $resultPath $uaid
        $job = Start-XSetupReaderJob $copy $profile
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while (-not $job.WaitForExit(100)) {
            if (-not [string]::IsNullOrWhiteSpace($CancellationPath) -and [IO.File]::Exists($CancellationPath)) {
                throw 'X_SETUP_EXPORT_CANCELLED: ファイル作成を中止しました。'
            }
            if ([DateTime]::UtcNow -gt $deadline) { throw 'X_SETUP_EXPORT_TIMEOUT: 抽出処理が時間内に完了しませんでした。' }
        }
        # 結果を読み出す前に、Job内の子プロセスまで停止したことを確認します。
        $job.Stop(); $job.Dispose(); $job = $null
        if (-not [IO.File]::Exists($resultPath)) { throw 'X_SETUP_READER_FAILED: 抽出用ブラウザーから結果を受け取れませんでした。' }
        $result = Read-SmallJson $resultPath 65536
        if ($result.ok -isnot [bool]) { throw 'X_SETUP_READER_FAILED: 抽出結果の形式を確認できません。' }
        if (-not $result.ok) {
            # 固定の識別子だけで原因を案内します。Firefox側の例外文や通知データは転記しません。
            # 通知未設定・他サイト混在・未対応形式を区別し、利用者が次の操作を選べるようにします。
            $reason = $result.PSObject.Properties['errorCode']
            if ($null -ne $reason -and $reason.Value -is [string]) {
                switch -CaseSensitive ($reason.Value) {
                    'X_EXPORT_OTHER_SUBSCRIPTIONS' { throw 'X_SETUP_EXPORT_OTHER_SUBSCRIPTIONS: 通常のタブで設定したX通知をご利用ください。コンテナーなど、この版で読み取れる範囲と異なる設定が含まれています。' }
                    'X_EXPORT_TOO_MANY_SUBSCRIPTIONS' { throw 'X_SETUP_EXPORT_TOO_MANY_SUBSCRIPTIONS: Xの設定用Firefoxの通知設定をご確認ください。複数のX通知設定があり、保存する1件を特定できませんでした。' }
                    'X_EXPORT_NO_SUBSCRIPTION' { throw 'X_SETUP_EXPORT_NO_SUBSCRIPTION: Xの設定用Firefoxで通知を有効にし、閉じてからもう一度実行してください。' }
                    'X_EXPORT_DATABASE_MISSING' { throw 'X_SETUP_EXPORT_NO_SUBSCRIPTION: Xの設定用Firefoxで通知を有効にし、閉じてからもう一度実行してください。' }
                    'X_EXPORT_DATABASE_VERSION' { throw 'X_SETUP_EXPORT_BROWSER_UNSUPPORTED: 対応するFirefoxの版を配布元へご確認ください。今回の通知データは、このツールの対応する保存形式と異なります。' }
                    'X_EXPORT_BROWSER_UNSUPPORTED' { throw 'X_SETUP_EXPORT_BROWSER_UNSUPPORTED: 対応するFirefoxの版を配布元へご確認ください。選択中の版は、このツールの対応範囲外です。' }
                    'X_EXPORT_TIMEOUT' { throw 'X_SETUP_EXPORT_TIMEOUT: 通知情報の読み取りが時間内に完了しませんでした。Firefoxを閉じて、もう一度実行してください。' }
                }
            }
            throw 'X_SETUP_EXPORT_REJECTED: Xの設定用Firefoxの通知設定と、対応するFirefoxの版をご確認ください。今回は保存に必要な通知情報を読み取れませんでした。'
        }
        Assert-PropertyNames $result @('ok', 'export', 'otherSubscriptionCount')
        $otherSubscriptionCount = $result.otherSubscriptionCount
        if (($otherSubscriptionCount -isnot [int] -and $otherSubscriptionCount -isnot [long]) -or
            $otherSubscriptionCount -lt 0 -or $otherSubscriptionCount -gt 63) { throw 'X_SETUP_READER_FAILED: 通知件数を確認できません。' }
        if ($result.export.format -cne 'x-notification-subscription' -or $result.export.version -ne 1) { throw 'X_SETUP_READER_FAILED: 抽出結果の形式を確認できません。' }
        $document = ConvertTo-Json -InputObject $result.export -Depth 12
        if ($script:Utf8.GetByteCount($document) -gt 32768) { throw 'X_SETUP_READER_FAILED: 抽出結果が対応範囲を超えています。' }
    }
    finally {
        if ($null -ne $profileLease) { $profileLease.Dispose() }
        if ($null -ne $job) {
            try { $job.Stop() } catch { $cleanupFailed = $true }
            finally { $job.Dispose() }
        }
        if ($scratchCreated -and -not $cleanupFailed) {
            try { Remove-XSetupOwnedScratch $scratch $token $Owner.profileId } catch { $cleanupFailed = $true }
        }
        if ($cleanupFailed) { throw 'X_SETUP_EXPORT_CLEANUP_FAILED: 作業用ブラウザーまたは一時データの片付けを完了できませんでした。保護された専用保存先を確認してください。' }
    }
    if ($null -eq $document) { throw 'X_SETUP_READER_FAILED: 抽出結果を確認できませんでした。' }
    if (-not [string]::IsNullOrWhiteSpace($CancellationPath) -and [IO.File]::Exists($CancellationPath)) {
        throw 'X_SETUP_EXPORT_CANCELLED: ファイル作成を中止しました。'
    }
    # 同じ読み取り専用スナップショットから作ったdocumentと件数を保持したまま、保存直前に確認します。
    # 先に作業用Firefoxと一時コピーを片付けるので、確認中にFirefoxや秘密情報の一時ファイルが残りません。
    # 確認後に元profileを読み直さず、説明した内容と保存する内容の取り違えを防ぎます。
    Confirm-XSetupOtherNotifications -OtherSubscriptionCount $otherSubscriptionCount `
        -AllowOtherNotifications:$AllowOtherNotifications -PromptForOtherNotifications:$PromptForOtherNotifications
    if (-not [string]::IsNullOrWhiteSpace($CancellationPath) -and [IO.File]::Exists($CancellationPath)) {
        throw 'X_SETUP_EXPORT_CANCELLED: ファイル作成を中止しました。'
    }
    Write-XSetupProtectedExport $output $document
    return [pscustomobject]@{ fileCreated = $true; exportPath = $output; containsSensitiveData = $true; encrypted = $false; uploaded = $false }
}
