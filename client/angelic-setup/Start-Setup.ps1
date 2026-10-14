#requires -Version 5.1
<#
.SYNOPSIS
X通知の準備を、コマンド入力なしで案内する画面です。

.DESCRIPTION
このファイルは画面と説明だけを担当します。Firefoxの専用環境を作る実処理は、
同じ配布物にある Setup-XNotifications.ps1 を別プロセスで呼び出します。

このツールは「Xの通知を設定する → 通知情報をこのPCのファイルへ保存する」
という作業を案内します。作成したファイルは、利用者本人がWebの登録画面で
選び、アップロードします。アップロードの操作はWeb画面で行います。

「専用環境」は、このツールでX通知を設定するためのFirefoxの保存場所です。
普段使いのFirefoxとは別に用意し、設定後にその通知情報だけを読み取ります。
実際の通知情報を確認し、保存できる状態になった時点で作成ボタンを有効にします。

画面を開く前と各操作の前に、配布ファイルの内容を照合します。
配布元が案内したZIPのSHA256も確認すると、正しい配布物か確かめられます。
#>
[CmdletBinding()]
param(
    # 通常は指定不要です。手動で指定した場合も、実処理側が新規専用フォルダーか検証します。
    [string] $PrivateRoot,
    [string] $FirefoxPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Title = 'X通知データの保存ツール'
$script:AppId = 'x-notification-setup'
$script:Version = '0.1.0-preview.4'
$script:Utf8 = New-Object Text.UTF8Encoding($false)
$script:PackageRoot = $PSScriptRoot
$script:PackageCapabilities = $null
$script:Prepared = $false
$script:ExportAvailable = $false
$script:CreatedFile = $null
$script:Busy = $false
$script:FirefoxPath = $FirefoxPath
$script:GuiExitCode = 2
$script:Form = $null

function Get-LocalPath {
    param([string] $Value)
    # UNC、デバイスパス、別データストリーム、相対要素を受け付けません。
    # パス文字列をコマンドとして評価することもありません。
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]') { throw 'Invalid local path.' }
    if ($Value.Substring(2).Contains(':') -or $Value.IndexOf([char]0) -ge 0) { throw 'Invalid local path.' }
    foreach ($part in ($Value.Substring(3) -split '[\\/]')) {
        if ($part -eq '.' -or $part -eq '..' -or $part -match '[ .]$') { throw 'Invalid local path component.' }
    }
    return [IO.Path]::GetFullPath($Value).TrimEnd([char]'\')
}

function Assert-NoReparsePoint {
    param([string] $Path)
    # 配布フォルダーそのものだけでなく、全ての親フォルダーも確認します。
    # 見た目と違う場所へ誘導するジャンクションやシンボリックリンクは使用しません。
    $volume = [IO.Path]::GetPathRoot($Path)
    $current = $volume
    foreach ($part in @('') + @($Path.Substring($volume.Length) -split '\\')) {
        if ($part.Length -gt 0) { $current = [IO.Path]::Combine($current, $part) }
        try { $attributes = [IO.File]::GetAttributes($current) }
        catch [IO.FileNotFoundException] { continue }
        catch [IO.DirectoryNotFoundException] { continue }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point rejected.' }
    }
}

function Assert-PropertyNames {
    param($Object, [string[]] $Names)
    if ($null -eq $Object) { throw 'Missing metadata.' }
    $actual = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Names.Count) { throw 'Unexpected metadata.' }
    foreach ($name in $actual) { if ($Names -cnotcontains $name) { throw 'Unexpected metadata.' } }
}

function Assert-Distribution {
    # 決められた公開テキストだけを許可します。余分なファイルも許可しないので、
    # 普段使いのデータや、利用後のプロファイルを配布物へ混ぜないでください。
    $script:PackageRoot = Get-LocalPath $PSScriptRoot
    Assert-NoReparsePoint $script:PackageRoot
    $files = @('Setup-XNotifications.ps1', 'Start-Setup.ps1', 'FirefoxReader.ps1', 'Export-XNotificationData.ps1', 'Read-PushSubscription.js', 'はじめに読んでください.txt', 'README-ja.md', 'LICENSE', 'ダブルクリックで開始.cmd')
    $allowed = $files + @('package-manifest.json')
    $entries = @(Get-ChildItem -LiteralPath $script:PackageRoot -Force)
    if ($entries.Count -ne $allowed.Count) { throw 'Unexpected package entries.' }
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or $allowed -cnotcontains $entry.Name) { throw 'Unexpected package entry.' }
        Assert-NoReparsePoint $entry.FullName
    }
    $manifestPath = [IO.Path]::Combine($script:PackageRoot, 'package-manifest.json')
    $manifestInfo = Get-Item -LiteralPath $manifestPath -Force
    if ($manifestInfo.Length -eq 0 -or $manifestInfo.Length -gt 16384) { throw 'Invalid package manifest.' }
    $manifest = [IO.File]::ReadAllText($manifestPath, $script:Utf8) | ConvertFrom-Json
    Assert-PropertyNames $manifest @('schemaVersion', 'packageId', 'version', 'capabilities', 'files')
    if ($manifest.schemaVersion -ne 1 -or $manifest.packageId -cne $script:AppId -or $manifest.version -cne $script:Version) {
        throw 'Unexpected package identity.'
    }
    Assert-PropertyNames $manifest.capabilities @('prepareProfile', 'openFirefox', 'realPushExport', 'serverTransfer')
    foreach ($name in @('prepareProfile', 'openFirefox', 'realPushExport', 'serverTransfer')) {
        if ($manifest.capabilities.PSObject.Properties[$name].Value -isnot [bool]) { throw 'Invalid capability.' }
    }
    if (-not $manifest.capabilities.prepareProfile -or -not $manifest.capabilities.openFirefox -or $manifest.capabilities.serverTransfer) {
        throw 'Unexpected capability.'
    }
    Assert-PropertyNames $manifest.files $files
    foreach ($name in $files) {
        $expected = $manifest.files.PSObject.Properties[$name].Value
        if ($expected -isnot [string] -or $expected -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid file digest.' }
        $filePath = [IO.Path]::Combine($script:PackageRoot, $name)
        $info = Get-Item -LiteralPath $filePath -Force
        if ($info.Length -eq 0 -or $info.Length -gt 1048576) { throw 'Invalid package file.' }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead($filePath)
        try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $algorithm.Dispose() }
        if ($actual -cne $expected) { throw 'Changed package file.' }
    }
    $script:PackageCapabilities = $manifest.capabilities
}

function ConvertTo-WindowsArgument {
    param([string] $Value)
    # ProcessStartInfo.Arguments は文字列なので、Windowsの引用規則で各引数を包みます。
    # 空白、&、$、かっこなどを含む保存先も、追加コマンドとして解釈されません。
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-SetupAction {
    param([string] $Action, [string] $OutputPath)
    # 実処理を呼ぶ直前にも再照合します。画面を開いた後で配布ファイルが変わった場合、
    # そのファイルを実行せず、再取得を案内します。
    try { Assert-Distribution }
    catch { return [pscustomobject]@{ Code = 2; Data = $null; Reason = 'Package' } }
    $executableName = 'powershell.exe'
    if ($PSVersionTable.PSVersion.Major -ge 6) { $executableName = 'pwsh.exe' }
    $executable = Get-LocalPath ([IO.Path]::Combine($PSHOME, $executableName))
    Assert-NoReparsePoint $executable
    $arguments = @('-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
        [IO.Path]::Combine($script:PackageRoot, 'Setup-XNotifications.ps1'), '-Action', $Action, '-PrivateRoot', $script:PrivateRoot)
    if (-not [string]::IsNullOrWhiteSpace($script:FirefoxPath)) { $arguments += @('-FirefoxPath', $script:FirefoxPath) }
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) { $arguments += @('-OutputPath', $OutputPath) }
    # 一時コピーの抽出と片付けを終えてから、混在を検出した場合だけ保存直前に説明します。
    # 画面側で包括同意を渡さず、利用者がその場で「はい」を選ぶ必要があります。
    if ($Action -eq 'Export') { $arguments += '-PromptForOtherNotifications' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $executable
    $start.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.WorkingDirectory = $script:PackageRoot
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # 保存先に日本語が含まれていても、実処理から返るJSONのパスを同じ文字で照合します。
    # 実処理もUTF-8を明示し、Windowsの既定文字コードには依存しません。
    $start.StandardOutputEncoding = $script:Utf8
    $start.StandardErrorEncoding = $script:Utf8
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        # 両方の出力を非同期で回収し、片方の出力待ちで止まることを防ぎます。
        # 生のJSON、例外、エラー全文は利用者へ表示しません。
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        # 抽出は、専用の一時Firefoxの終了と一時データの消去まで実処理側で行います。
        # GUIが先に強制終了すると掃除処理が飛ばされるため、抽出側の期限管理に任せ、
        # 画面を応答させながら終了を待ちます。DoEvents中の二重操作はBusyで防ぎます。
        $finished = $false
        if ($Action -eq 'Export') {
            while (-not $process.HasExited) {
                [Windows.Forms.Application]::DoEvents()
                [Threading.Thread]::Sleep(50)
            }
            $finished = $true
        }
        else { $finished = $process.WaitForExit(30000) }
        if (-not $finished) {
            # 終了するのは、この画面自身が作った実処理用PowerShellだけです。
            # Firefoxや、以前から動いている他のプロセスは終了しません。
            try { $process.Kill() } catch { }
            return [pscustomobject]@{ Code = 4; Data = $null; Reason = 'Timeout' }
        }
        $process.WaitForExit()
        $stdout = $output.GetAwaiter().GetResult()
        $stderr = $errors.GetAwaiter().GetResult()
        $code = $process.ExitCode
        if ($code -ne 0) {
            # エラー識別子だけを許可リストで分類します。実際の例外文や秘密値は捨てます。
            $reason = 'Other'
            foreach ($candidate in @('FIREFOX_NOT_FOUND', 'FIREFOX_INVALID', 'PROFILE_BUSY', 'ACTION_BUSY', 'FIREFOX_LAUNCH_FAILED',
                'FIREFOX_SIGNATURE_INVALID', 'FIREFOX_CUSTOM_CONFIG', 'FIREFOX_COPY_LIMIT', 'FIREFOX_COPY_INVALID',
                'OUTPUT_PATH_REJECTED', 'EXPORT_FILE_FAILED', 'UAID_UNAVAILABLE', 'UAID_INVALID', 'PREF_FORMAT_REJECTED',
                'PUSH_DATABASE_MISSING', 'PUSH_DATABASE_INVALID', 'PUSH_DATABASE_TOO_LARGE', 'EXPORT_TIMEOUT',
                'EXPORT_CANCELLED', 'EXPORT_REJECTED', 'READER_FAILED', 'EXPORT_CLEANUP_FAILED', 'OTHER_NOTIFICATIONS_CONSENT_REQUIRED',
                'EXPORT_OTHER_SUBSCRIPTIONS', 'EXPORT_TOO_MANY_SUBSCRIPTIONS', 'EXPORT_NO_SUBSCRIPTION', 'EXPORT_BROWSER_UNSUPPORTED',
                'REPARSE_REJECTED', 'PATH_REJECTED',
                'EXPORT_DATABASE_UNSUPPORTED', 'EXPORT_INVALID_KEYS', 'OUTPUT_ACL_UNSUPPORTED', 'OUTPUT_REQUIRED')) {
                if ($stderr -match ('X_SETUP_' + $candidate + ':')) { $reason = $candidate; break }
            }
            return [pscustomobject]@{ Code = $code; Data = $null; Reason = $reason }
        }
        try { $data = $stdout | ConvertFrom-Json }
        catch { return [pscustomobject]@{ Code = 3; Data = $null; Reason = 'InvalidResult' } }
        return [pscustomobject]@{ Code = 0; Data = $data; Reason = '' }
    }
    catch { return [pscustomobject]@{ Code = 4; Data = $null; Reason = 'Other' } }
    finally { $process.Dispose() }
}

function Set-Result {
    param([string] $Text, [bool] $IsError = $false)
    $script:ResultLabel.Text = $Text
    if ($IsError) { $script:ResultLabel.ForeColor = [Drawing.Color]::Maroon }
    else { $script:ResultLabel.ForeColor = [Drawing.Color]::FromArgb(25, 65, 100) }
}

function Set-BusyState {
    param([bool] $Value)
    # 抽出中のキャンセルは、一時Firefoxの残留や半端なファイルの原因になります。
    # 画面は動かせるままにし、二重実行・別操作・閉じる操作だけを一時的に禁止します。
    $script:Busy = $Value
    $script:Form.UseWaitCursor = $Value
    $script:PrepareButton.Enabled = -not $Value
    $script:OpenFirefoxButton.Enabled = (-not $Value -and $script:Prepared)
    $script:ExportButton.Enabled = (-not $Value -and $script:Prepared -and $script:ExportAvailable)
    $script:FolderButton.Enabled = (-not $Value -and $null -ne $script:CreatedFile)
    $script:CloseButton.Enabled = -not $Value
    $script:HelpButton.Enabled = -not $Value
    $script:ChooseFirefoxButton.Enabled = -not $Value
}

function Get-FriendlyFailure {
    param($Result)
    # 実処理の安全な分類だけを使い、ブラウザーの例外文や抽出した値は表示しません。
    # 抽出エラーは終了コードが同じでも対処が異なるため、分類を先に案内へ変換します。
    switch ($Result.Reason) {
        'OUTPUT_REQUIRED' { return '「アップロード用ファイルを作る」を押して、保存先と新しいファイル名を選んでください。' }
        'OUTPUT_ACL_UNSUPPORTED' { return 'このPCの「ドキュメント」など、本人だけが読めるように保護できる保存先を選んでください。共有フォルダーやUSBメモリーでは保護できない場合があります。' }
        'PROFILE_BUSY' { return 'このツールで開いたFirefoxをすべて閉じてから、もう一度ファイルを作ってください。現在、そのFirefoxを使用中です。' }
        'ACTION_BUSY' { return '先に始めた処理が終わるまでお待ちください。同じ保存場所で作業中です。' }
        'OUTPUT_PATH_REJECTED' { return '「ドキュメント」など、このツールのフォルダーとは別の場所に、新しいファイル名で保存してください。' }
        'REPARSE_REJECTED' { return 'このPC内にあるフォルダーを直接選んでください。ショートカットやリンクを通さずに保存すると、保存先を確認できます。' }
        'PATH_REJECTED' { return 'このPCの「ドキュメント」など、PC内のフォルダーを保存先に選んでください。' }
        'EXPORT_FILE_FAILED' { return '保存先の空き容量と書き込み権限を確認し、新しいファイル名でお試しください。今回は保存を完了できませんでした。' }
        'UAID_UNAVAILABLE' { return '「Xの設定用Firefoxを開く」からXにログインし、投稿通知とブラウザー通知を有効にしてください。設定後にFirefoxを閉じると、ファイルを作成できます。' }
        'PUSH_DATABASE_MISSING' { return 'Xの設定用Firefoxで投稿通知とブラウザー通知を有効にし、Firefoxを閉じてから、もう一度ファイルを作ってください。' }
        'EXPORT_NO_SUBSCRIPTION' { return 'Xの設定用Firefoxで投稿通知とブラウザー通知を有効にし、Firefoxを閉じてから、もう一度ファイルを作ってください。' }
        'EXPORT_OTHER_SUBSCRIPTIONS' { return '通常のタブで設定したX通知をご利用ください。コンテナーなど、この版で読み取れる範囲と異なる設定が含まれています。詳しい対応環境は配布元へご確認ください。' }
        'OTHER_NOTIFICATIONS_CONSENT_REQUIRED' { return 'もう一度ファイル作成を選ぶと、ほかのサイトの通知の扱いを確認できます。内容を確認して「はい」を選ぶと保存へ進みます。' }
        'EXPORT_TOO_MANY_SUBSCRIPTIONS' { return 'Xの設定用Firefoxの通知設定を確認してください。複数のX通知設定があり、保存する1件を特定できませんでした。' }
        'FIREFOX_SIGNATURE_INVALID' { return '公式Firefoxを選び直してください。選択したファイルが公式のものか確認できませんでした。対応する版は配布元の案内で確認できます。' }
        'FIREFOX_COPY_INVALID' { return '公式Firefoxを選び、ディスクの空き容量を確認してからお試しください。読み取り用Firefoxの準備でエラーが発生しました。' }
        'FIREFOX_CUSTOM_CONFIG' { return '標準設定の公式Firefoxをご利用ください。このFirefoxには独自の設定が含まれています。' }
        'FIREFOX_COPY_LIMIT' { return '対応するFirefoxの版とインストール方法を配布元へご確認ください。このFirefoxは、読み取り用に準備できる大きさやファイル数を超えています。' }
        'EXPORT_BROWSER_UNSUPPORTED' { return '対応するFirefoxの版を配布元の案内で確認し、その版をお選びください。選択中の版は、このツールの対応範囲外です。' }
        'EXPORT_DATABASE_UNSUPPORTED' { return '対応するFirefoxの版を配布元へご確認ください。このFirefoxの通知データは、この版のツールとは保存形式が異なります。' }
        'PREF_FORMAT_REJECTED' { return '対応するFirefoxの版と設定方法を配布元へご確認ください。通知に必要な設定を読み取れませんでした。' }
        'PUSH_DATABASE_TOO_LARGE' { return '配布元へ、通知データのサイズが上限を超えたことをご相談ください。元の通知データはそのまま保存されています。' }
        'EXPORT_TIMEOUT' { return 'Xの設定用Firefoxを閉じ、ディスクの空き容量を確認してからお試しください。読み取りに時間がかかったため、今回の処理を終了しました。' }
        'EXPORT_CANCELLED' { return 'ファイル作成をキャンセルしました。作成したいときは「アップロード用ファイルを作る」から再開できます。' }
        'EXPORT_CLEANUP_FAILED' { return 'この画面を閉じて、作業用データの片付けでエラーが出たことをサポートへご相談ください。調査のため、ツール用の保存場所はそのままにしてください。ファイルの保存は保留しました。' }
        'EXPORT_REJECTED' { return 'Xの設定用Firefoxで通知設定を確認し、閉じてからお試しください。今回は保存に必要なX通知の情報を確認できませんでした。' }
        'EXPORT_INVALID_KEYS' { return 'Xの設定用Firefoxで通知設定を確認し、閉じてからお試しください。通知を読むための情報に不整合がありました。サポートへの相談には、画面の案内文だけをお伝えください。' }
        'UAID_INVALID' { return 'Xの設定用Firefoxで通知設定を確認し、閉じてからお試しください。通知の受け取り先を確認できませんでした。' }
        'PUSH_DATABASE_INVALID' { return '対応するFirefoxの版を配布元へご確認ください。今回の通知データは、読み取れる保存形式と異なります。' }
        'READER_FAILED' { return 'Xの設定用Firefoxを閉じ、対応する版を選んでからお試しください。今回の通知情報の読み取りは完了しませんでした。' }
    }
    switch ($Result.Code) {
        2 { return 'ZIPを新しい空のフォルダーへ展開し直してください。配布元が案内したZIPの照合値（SHA256）でも、正しいファイルか確認できます。' }
        3 { return '「説明を読む」で保存場所の案内をご確認ください。設定済みのフォルダーをそのまま残してサポートへ相談すると、現在の状態を確認できます。' }
        4 {
            if ($Result.Reason -eq 'FIREFOX_NOT_FOUND' -or $Result.Reason -eq 'FIREFOX_INVALID') {
                return '「Firefoxを選ぶ」からFirefox本体のfirefox.exeを選んでください。Firefoxをお持ちでない場合は、公式Firefoxをインストールしてから進めてください。'
            }
            if ($Result.Reason -eq 'PROFILE_BUSY' -or $Result.Reason -eq 'ACTION_BUSY') {
                return 'このツールで開いたFirefoxを閉じ、準備中の処理が終わってからお試しください。現在、通知設定を使用中です。'
            }
            if ($Result.Reason -eq 'Timeout') { return 'このツールで開いたFirefoxを閉じ、少し待ってからお試しください。今回の処理は待ち時間の上限に達しました。' }
            return 'Firefoxのインストール先を選び直し、このツールで開いたFirefoxを閉じてからお試しください。今回はFirefoxの起動を完了できませんでした。'
        }
        5 { return '保存先とXの通知設定を「説明を読む」の手順に沿ってご確認ください。今回はファイル作成に必要な情報を確認できませんでした。' }
        6 { return '作成したファイルをWebの登録画面で選び、ご自身でアップロードしてください。' }
        default { return '「説明を読む」の手順を確認し、もう一度お試しください。解決しない場合は、現在のデータをそのまま残してサポートへご相談ください。' }
    }
}

function Update-ReadyState {
    param($Data)
    # 配布物の宣言と実処理の宣言が一致しない場合は、作成可能と誤認させません。
    if ($null -eq $Data -or $Data.appId -cne $script:AppId -or $Data.version -cne $script:Version -or
        $Data.packageVerified -isnot [bool] -or -not $Data.packageVerified -or $Data.prepared -isnot [bool]) {
        throw 'Unexpected setup result.'
    }
    Assert-PropertyNames $Data.capabilities @('prepareProfile', 'openFirefox', 'realPushExport', 'serverTransfer')
    foreach ($name in @('prepareProfile', 'openFirefox', 'realPushExport', 'serverTransfer')) {
        $value = $Data.capabilities.PSObject.Properties[$name].Value
        if ($value -isnot [bool] -or $value -ne $script:PackageCapabilities.PSObject.Properties[$name].Value) { throw 'Capability mismatch.' }
    }
    $script:Prepared = $Data.prepared
    $script:ExportAvailable = $Data.capabilities.realPushExport
    $script:OpenFirefoxButton.Enabled = $script:Prepared
    $script:ExportButton.Enabled = ($script:Prepared -and $script:ExportAvailable)
    if ($script:Prepared) { $script:PreparationLabel.Text = 'X通知用のFirefoxは準備済みです。「Xの設定用Firefoxを開く」からログインし、通知を設定してください。設定済みの方は、Firefoxを閉じてファイルを作成できます。' }
    else { $script:PreparationLabel.Text = '「専用環境を準備する」で、X通知用の保存場所を作ります。普段使いのFirefoxとは別の場所に用意します。' }
    if ($script:ExportAvailable) {
        $script:LimitationLabel.Text = 'このPCでファイルを作成し、Webの登録画面からご自身でアップロードします。通知の受信状況は、アップロード後にWeb画面で確認してください。'
    }
    else { $script:LimitationLabel.Text = 'この版では、X通知用の保存場所の準備とFirefoxの起動を利用できます。ファイル作成は、対応版を入手してから進めてください。' }
}

function Invoke-VisibleAction {
    param([string] $Action)
    if ($script:Busy) { return }
    Set-BusyState $true
    try {
        Set-Result '処理しています。しばらくお待ちください。'
        $script:Form.Refresh()
        $result = Invoke-SetupAction $Action
        if ($result.Code -ne 0) {
            $script:GuiExitCode = $result.Code
            if ($Action -eq 'Status') {
                $script:Prepared = $false
                $script:ExportAvailable = $false
                $script:LimitationLabel.Text = '下の案内に沿って、X通知用の保存場所をご確認ください。確認が済むと、次の操作へ進めます。'
            }
            Set-Result (Get-FriendlyFailure $result) $true
            return
        }
        Update-ReadyState $result.Data
        $script:GuiExitCode = 0
        if ($Action -eq 'Prepare') { Set-Result 'X通知用の保存場所を準備しました。次は「Xの設定用Firefoxを開く」を押し、Xへのログインと通知設定を進めてください。' }
        elseif ($Action -eq 'OpenFirefox') { Set-Result 'Xの設定用Firefoxを開きました。ログインして対象アカウントの投稿通知とブラウザー通知を有効にし、Firefoxを閉じてください。その後、ファイルを作成できます。' }
        else { Set-Result '保存場所を確認しました。初めての方は「専用環境を準備する」から、設定済みの方はファイル作成へ進んでください。' }
    }
    catch { $script:GuiExitCode = 3; Set-Result '「説明を読む」の手順を確認して、もう一度お試しください。今回は処理結果を確認できませんでした。解決しない場合はサポートへご相談ください。' $true }
    finally {
        Set-BusyState $false
    }
}

function Set-SelectedFirefox {
    param([string] $Path)
    # ファイルを選ぶだけでは起動しません。ショートカットや別の実行ファイルを誤選択せず、
    # 実在するFirefox本体の通常ファイルだけを、次の操作で使う候補として保持します。
    $selected = Get-LocalPath $Path
    Assert-NoReparsePoint $selected
    if ([IO.Path]::GetFileName($selected) -ine 'firefox.exe' -or [IO.Path]::GetExtension($selected) -ine '.exe') {
        throw 'Select the Firefox executable.'
    }
    $info = Get-Item -LiteralPath $selected -Force
    if ($info.PSIsContainer -or $info.Length -le 0) { throw 'Select a regular Firefox executable.' }
    $script:FirefoxPath = $selected
}

function Set-WindowWithinWorkingArea {
    param($Window, [int] $Width, [int] $Height, [int] $MinimumWidth, [int] $MinimumHeight)
    # 画面の作業領域という寸法情報だけを使います。他のアプリの情報や画面は読みません。
    # タスクバーを除く領域に収め、768px級のノートPCでも閉じるボタンが画面外に出ないようにします。
    $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $widthLimit = [Math]::Max(1, $area.Width - 32)
    $heightLimit = [Math]::Max(1, $area.Height - 32)
    $actualWidth = [Math]::Min($Width, $widthLimit)
    $actualHeight = [Math]::Min($Height, $heightLimit)
    $Window.MinimumSize = New-Object Drawing.Size([Math]::Min($MinimumWidth, $actualWidth), [Math]::Min($MinimumHeight, $actualHeight))
    $Window.Size = New-Object Drawing.Size($actualWidth, $actualHeight)
    $Window.StartPosition = 'Manual'
    $Window.Location = New-Object Drawing.Point(($area.Left + [int](($area.Width - $actualWidth) / 2)), ($area.Top + [int](($area.Height - $actualHeight) / 2)))
}

function New-SetupForm {
    param([string] $RootPath)
    # 画面の組み立てと表示を分けます。この関数だけでは、専用環境の作成、
    # Firefoxの起動、ファイルの抽出は行いません。
    $script:Prepared = $false
    $script:ExportAvailable = $false
    $script:CreatedFile = $null
    $script:Busy = $false
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) { throw 'STA required.' }
    [Windows.Forms.Application]::EnableVisualStyles()
    if ([string]::IsNullOrWhiteSpace($RootPath)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'Missing local application directory.' }
        $RootPath = [IO.Path]::Combine($env:LOCALAPPDATA, 'XNotificationSetup', 'FirefoxSetupPreview')
    }
    $script:PrivateRoot = Get-LocalPath $RootPath
    Assert-NoReparsePoint $script:PrivateRoot

    $script:Form = New-Object Windows.Forms.Form
    $script:Form.Name = 'XNotificationSetupForm'
    $script:Form.Text = $script:Title
    $script:Form.Font = New-Object Drawing.Font('Yu Gothic UI', 10)
    $script:Form.AutoScaleMode = 'Font'
    Set-WindowWithinWorkingArea $script:Form 850 820 620 520

    $layout = New-Object Windows.Forms.TableLayoutPanel
    $layout.Dock = 'Fill'; $layout.Padding = New-Object Windows.Forms.Padding(20)
    $layout.ColumnCount = 1; $layout.RowCount = 7; $layout.AutoScroll = $true
    # 本文だけをスクロール可能にし、下の「閉じる」「説明」「Firefox選択」は常時見える場所に置きます。
    $layout.AutoScrollMinSize = New-Object Drawing.Size(800, 746)
    foreach ($height in @(38, 82, 75, 120, 140, 66, 85)) {
        $null = $layout.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute, $height)))
    }
    $script:Form.Controls.Add($layout)

    $titleLabel = New-Object Windows.Forms.Label
    $titleLabel.Text = 'X通知データをファイルに保存する'
    $titleLabel.Font = New-Object Drawing.Font('Yu Gothic UI', 16, [Drawing.FontStyle]::Bold)
    $titleLabel.Dock = 'Fill'; $layout.Controls.Add($titleLabel, 0, 0)
    $intro = New-Object Windows.Forms.Label
    $intro.Name = 'IntroductionLabel'; $intro.Dock = 'Fill'
    $intro.Text = "Xの通知をサーバーへ引き継ぐためのファイルを、このPCに作ります。`r`n① X通知用のFirefoxを準備 → ② ログインして通知を設定 → ③ ファイルを作成`r`n作成後はWebの登録画面で、ご自身がファイルを選んで送信します。"
    $layout.Controls.Add($intro, 0, 1)
    $script:LimitationLabel = New-Object Windows.Forms.Label
    $script:LimitationLabel.Name = 'LimitationLabel'; $script:LimitationLabel.Dock = 'Fill'
    $script:LimitationLabel.ForeColor = [Drawing.Color]::Maroon
    $script:LimitationLabel.Text = 'X通知用の保存場所を確認しています。確認が済むと、利用できるボタンが表示されます。'
    $layout.Controls.Add($script:LimitationLabel, 0, 2)

    $exportGroup = New-Object Windows.Forms.GroupBox
    $exportGroup.Text = 'アップロード用ファイル'; $exportGroup.Dock = 'Fill'
    $exportText = New-Object Windows.Forms.Label
    $exportText.Text = 'Xの設定用Firefoxを閉じてから、ファイルを作成します。ファイルに保存するのは、X通知の受信に必要な情報です。'
    $exportText.Location = New-Object Drawing.Point(12, 24); $exportText.Size = New-Object Drawing.Size(740, 38)
    $exportGroup.Controls.Add($exportText)
    $script:ExportButton = New-Object Windows.Forms.Button
    $script:ExportButton.Name = 'ExportButton'; $script:ExportButton.Text = 'アップロード用ファイルを作る'
    $script:ExportButton.Location = New-Object Drawing.Point(12, 66); $script:ExportButton.Size = New-Object Drawing.Size(290, 38)
    $script:ExportButton.Enabled = $false; $exportGroup.Controls.Add($script:ExportButton)
    $script:FolderButton = New-Object Windows.Forms.Button
    $script:FolderButton.Name = 'FolderButton'; $script:FolderButton.Text = '作成したファイルの保存先を開く'
    $script:FolderButton.Location = New-Object Drawing.Point(314, 66); $script:FolderButton.Size = New-Object Drawing.Size(290, 38)
    $script:FolderButton.Enabled = $false; $exportGroup.Controls.Add($script:FolderButton)
    $layout.Controls.Add($exportGroup, 0, 3)

    $prepareGroup = New-Object Windows.Forms.GroupBox
    $prepareGroup.Text = '初めての方・Xの通知設定をする方'; $prepareGroup.Dock = 'Fill'
    $script:PreparationLabel = New-Object Windows.Forms.Label
    $script:PreparationLabel.Name = 'PreparationLabel'; $script:PreparationLabel.Location = New-Object Drawing.Point(12, 24)
    $script:PreparationLabel.Size = New-Object Drawing.Size(740, 48)
    $script:PreparationLabel.Text = '「専用環境を準備する」で、X通知用の保存場所を作ります。普段使いのFirefoxとは別の場所に用意します。'
    $prepareGroup.Controls.Add($script:PreparationLabel)
    $script:PrepareButton = New-Object Windows.Forms.Button
    $script:PrepareButton.Name = 'PrepareButton'; $script:PrepareButton.Text = '1. 専用環境を準備する'
    $script:PrepareButton.Location = New-Object Drawing.Point(12, 84); $script:PrepareButton.Size = New-Object Drawing.Size(290, 38)
    $prepareGroup.Controls.Add($script:PrepareButton)
    $script:OpenFirefoxButton = New-Object Windows.Forms.Button
    $script:OpenFirefoxButton.Name = 'OpenFirefoxButton'; $script:OpenFirefoxButton.Text = '2. Xの設定用Firefoxを開く'
    $script:OpenFirefoxButton.Location = New-Object Drawing.Point(314, 84); $script:OpenFirefoxButton.Size = New-Object Drawing.Size(290, 38)
    $script:OpenFirefoxButton.Enabled = $false; $prepareGroup.Controls.Add($script:OpenFirefoxButton)
    $layout.Controls.Add($prepareGroup, 0, 4)
    $script:LocationLabel = New-Object Windows.Forms.Label
    $script:LocationLabel.Name = 'LocationLabel'; $script:LocationLabel.Dock = 'Fill'
    $script:LocationLabel.Text = "X通知用Firefoxの保存場所（このツールの「専用環境」です）`r`n" + $script:PrivateRoot
    $layout.Controls.Add($script:LocationLabel, 0, 5)
    $script:ResultLabel = New-Object Windows.Forms.Label
    $script:ResultLabel.Name = 'ResultLabel'; $script:ResultLabel.Dock = 'Fill'
    $script:ResultLabel.Padding = New-Object Windows.Forms.Padding(10)
    $script:ResultLabel.BorderStyle = 'FixedSingle'
    $script:ResultLabel.BackColor = [Drawing.Color]::FromArgb(243, 248, 252)
    $layout.Controls.Add($script:ResultLabel, 0, 6)
    $footer = New-Object Windows.Forms.FlowLayoutPanel
    $footer.Dock = 'Bottom'; $footer.Height = 56; $footer.Padding = New-Object Windows.Forms.Padding(12, 6, 12, 6)
    $footer.FlowDirection = 'RightToLeft'
    $script:CloseButton = New-Object Windows.Forms.Button
    $script:CloseButton.Name = 'CloseButton'; $script:CloseButton.Text = '閉じる'; $script:CloseButton.Size = New-Object Drawing.Size(120, 36)
    $script:CloseButton.Add_Click({ if (-not $script:Busy) { $script:Form.Close() } }); $footer.Controls.Add($script:CloseButton)
    $script:HelpButton = New-Object Windows.Forms.Button
    $script:HelpButton.Name = 'ReadHelpButton'; $script:HelpButton.Text = '説明を読む'; $script:HelpButton.Size = New-Object Drawing.Size(150, 36)
    $footer.Controls.Add($script:HelpButton)
    $script:ChooseFirefoxButton = New-Object Windows.Forms.Button
    $script:ChooseFirefoxButton.Name = 'ChooseFirefoxButton'; $script:ChooseFirefoxButton.Text = 'Firefoxを選ぶ'
    $script:ChooseFirefoxButton.Size = New-Object Drawing.Size(170, 36)
    $footer.Controls.Add($script:ChooseFirefoxButton)
    $script:Form.Controls.Add($footer)
    $script:Form.CancelButton = $script:CloseButton
    $script:Form.Add_FormClosing({
        param($sender, $eventArgs)
        if ($script:Busy) {
            $eventArgs.Cancel = $true
            Set-Result '作業用データの片付けまで終わると、この画面を閉じられます。完了までそのままお待ちください。'
        }
    })

    $script:PrepareButton.Add_Click({
        $message = "このPCに、X通知を設定するためのFirefoxの保存場所を作ります。これを「専用環境」と呼びます。`r`n`r`n保存先:`r`n" + $script:PrivateRoot +
            "`r`n`r`nFirefoxの設定を保存するフォルダーと、このツール用の管理情報を作成します。普段使いのFirefoxとは別に用意します。`r`n`r`n専用環境を準備しますか？"
        if ([Windows.Forms.MessageBox]::Show($script:Form, $message, '専用環境を作る前の確認', 'YesNo', 'Question', 'Button2') -eq 'Yes') {
            Invoke-VisibleAction 'Prepare'
        }
    })
    $script:OpenFirefoxButton.Add_Click({
        $message = "X通知の設定用にFirefoxを開き、Xへ接続します。FirefoxはXやMozillaなどと通常の通信を行います。`r`n`r`n1. Xにログインします。`r`n2. 対象アカウントの投稿通知とブラウザー通知を有効にします。`r`n3. 設定を終えたらFirefoxを閉じ、この画面でファイルを作成します。`r`n`r`nXの設定用Firefoxを開きますか？"
        if ([Windows.Forms.MessageBox]::Show($script:Form, $message, 'Firefoxを開く前の確認', 'YesNo', 'Question', 'Button2') -eq 'Yes') {
            Invoke-VisibleAction 'OpenFirefox'
        }
    })
    $script:HelpButton.Add_Click({
        try {
            Assert-Distribution
            $help = New-Object Windows.Forms.Form
            $help.Text = 'はじめにお読みください'; $help.Font = $script:Form.Font
            Set-WindowWithinWorkingArea $help 740 620 400 300
            $text = New-Object Windows.Forms.TextBox
            $text.Multiline = $true; $text.ReadOnly = $true; $text.ScrollBars = 'Vertical'; $text.Dock = 'Fill'
            $text.Text = [IO.File]::ReadAllText([IO.Path]::Combine($script:PackageRoot, 'はじめに読んでください.txt'), $script:Utf8)
            $help.Controls.Add($text)
            try { $null = $help.ShowDialog($script:Form) } finally { $help.Dispose() }
        }
        catch { Set-Result 'ZIPを新しい空のフォルダーへ展開し直すと、説明を開けます。今回は説明ファイルを確認できませんでした。' $true }
    })
    $script:ChooseFirefoxButton.Add_Click({
        if ($script:Busy) { return }
        $dialog = New-Object Windows.Forms.OpenFileDialog
        $dialog.Title = 'Firefox本体のfirefox.exeを選ぶ'
        $dialog.Filter = 'Firefox本体 (firefox.exe)|firefox.exe'
        $dialog.FileName = 'firefox.exe'; $dialog.CheckFileExists = $true; $dialog.Multiselect = $false
        try {
            if ($dialog.ShowDialog($script:Form) -ne 'OK') { return }
            Set-SelectedFirefox $dialog.FileName
            Set-Result 'Firefoxを選びました。次に、使いたい操作のボタンを押してください。この画面を開いている間は、選んだFirefoxを使います。'
        }
        catch { Set-Result '公式Firefoxをインストールしたフォルダーにあるfirefox.exeを選んでください。ショートカットの場合は、その参照先のフォルダーを開くと本体を選べます。' $true }
        finally { $dialog.Dispose() }
    })
    $script:ExportButton.Add_Click({
        # 配布物と実処理の両方で抽出対応を確認し、専用環境の所有を確認できた場合だけ、
        # 利用者が選ぶ新規ファイルへ書き出します。元データの再起動・変更はしません。
        if ($script:Busy -or -not $script:ExportAvailable -or -not $script:Prepared) { return }
        $dialog = New-Object Windows.Forms.SaveFileDialog
        $dialog.Title = 'アップロード用ファイルの保存先'
        $dialog.Filter = '通知引継ぎ用ファイル (*.json)|*.json'
        $dialog.DefaultExt = 'json'; $dialog.AddExtension = $true; $dialog.OverwritePrompt = $false
        $dialog.FileName = 'X通知引継ぎ.json'; $dialog.CheckPathExists = $true
        # 展開した配布フォルダーを保存先の初期値にしないよう、通常のドキュメントを案内します。
        # フォルダーを新しく作ったり、この時点でファイルを書いたりはしません。
        $documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
        if (-not [string]::IsNullOrWhiteSpace($documents) -and [IO.Directory]::Exists($documents)) {
            $dialog.InitialDirectory = $documents
        }
        try {
            if ($dialog.ShowDialog($script:Form) -ne 'OK') { return }
            $selected = Get-LocalPath $dialog.FileName
            Assert-NoReparsePoint $selected
            if ([IO.File]::Exists($selected) -or [IO.Directory]::Exists($selected)) {
                Set-Result '別の新しいファイル名を選んでください。同じ名前のファイルが保存済みです。' $true
                return
            }
            $message = "Xの設定用Firefoxから通知情報を読み取り、アップロード用のファイルを作ります。読み取りは作業用のコピーで行い、元の設定をそのまま残します。`r`n`r`n保存先:`r`n" + $selected +
                "`r`n`r`nファイルには、X通知を受信して読むための大切な情報が入ります。Cookie・保存パスワード・閲覧履歴は含めません。`r`nファイル自体は暗号化されていません。このPCでは、本人とWindowsシステムだけが読めるように保護します。`r`n`r`n作成後は、ご自身でWebの登録画面へアップロードしてください。このファイルはご自身の登録用として保管し、メールやSNSでの共有はお控えください。`r`n`r`nファイルを作りますか？"
            if ([Windows.Forms.MessageBox]::Show($script:Form, $message, 'ファイルを作る前の確認', 'YesNo', 'Warning', 'Button2') -ne 'Yes') { return }
            $script:CreatedFile = $null
            Set-BusyState $true
            Set-Result 'X通知の情報を読み取り、アップロード用ファイルを作成しています。作業用データの片付けまで終えるので、完了までそのままお待ちください。'
            $script:Form.Refresh()
            $result = Invoke-SetupAction 'Export' $selected
            if ($result.Code -ne 0) { $script:GuiExitCode = $result.Code; Set-Result (Get-FriendlyFailure $result) $true; return }
            if ($null -eq $result.Data -or $result.Data.fileCreated -isnot [bool] -or -not $result.Data.fileCreated -or
                $result.Data.exportPath -isnot [string] -or
                -not (Get-LocalPath $result.Data.exportPath).Equals($selected, [StringComparison]::OrdinalIgnoreCase) -or
                -not [IO.File]::Exists($selected)) { throw 'Export result not verified.' }
            Assert-NoReparsePoint $selected
            $createdInfo = New-Object IO.FileInfo($selected)
            if ($createdInfo.Length -le 0 -or $createdInfo.Length -gt 32768) { throw 'Export file size not verified.' }
            $script:CreatedFile = $selected
            $script:FolderButton.Enabled = $true
            $script:GuiExitCode = 0
            Set-Result 'ファイルを作りました。次はWebの登録画面で、このファイルを選んでアップロードしてください。「作成したファイルの保存先を開く」からファイルを確認できます。'
        }
        catch { $script:GuiExitCode = 3; Set-Result '保存先をご確認ください。ファイル作成の完了を確認できませんでした。もう一度作成する場合は、新しいファイル名を選んでください。' $true }
        finally { $dialog.Dispose(); Set-BusyState $false }
    })
    $script:FolderButton.Add_Click({
        try {
            if ($null -eq $script:CreatedFile) { return }
            $folder = Get-LocalPath ([IO.Path]::GetDirectoryName($script:CreatedFile))
            Assert-NoReparsePoint $folder
            $explorer = [IO.Path]::Combine($env:SystemRoot, 'explorer.exe')
            $start = New-Object Diagnostics.ProcessStartInfo
            $start.FileName = $explorer; $start.UseShellExecute = $false
            $start.Arguments = ConvertTo-WindowsArgument $folder
            $opened = [Diagnostics.Process]::Start($start)
            if ($null -ne $opened) { $opened.Dispose() }
        }
        catch { Set-Result 'エクスプローラーから、ファイルの保存場所を開いてください。今回は保存先を自動で開けませんでした。' $true }
    })

    return $script:Form
}

function Start-SetupWindow {
    try {
        # 最初に検証し、未確認の配布物では通常の操作画面を表示しません。
        Assert-Distribution
        $script:GuiExitCode = 3
        $window = New-SetupForm -RootPath $PrivateRoot
        # 状態確認は作成・起動をしません。安全な状態だけを画面へ反映します。
        Invoke-VisibleAction 'Status'
        $null = $window.ShowDialog()
    }
    catch {
        # 例外全文は表示しません。利用者が行える対処だけを案内し、内部情報を隠します。
        $message = 'ZIPを新しい空のフォルダーへ展開し直し、「ダブルクリックで開始.cmd」を開いてください。配布元が案内したZIPの照合値（SHA256）でも、正しい配布物か確認できます。今回は起動画面を開けませんでした。'
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $null = [Windows.Forms.MessageBox]::Show($message, $script:Title, 'OK', 'Error')
        }
        catch {
            # Forms自体を読み込めない場合も、非表示のコンソールだけにエラーを残さず、
            # Windows標準の説明ダイアログを試します。外部プログラムは取得しません。
            try { $shell = New-Object -ComObject WScript.Shell; $null = $shell.Popup($message, 0, $script:Title, 16) }
            catch { [Console]::Error.WriteLine('画面を開けませんでした。配布物の説明をご確認ください。') }
        }
    }
    finally { if ($null -ne $script:Form) { $script:Form.Dispose() } }
    return $script:GuiExitCode
}

# 直接実行したときだけ画面を開きます。dot-sourceは関数を読み込む標準操作として残し、
# 別のスクリプトから画面を組み立てて確認しても、実処理を勝手に開始しません。
if ($MyInvocation.InvocationName -ne '.') { exit (Start-SetupWindow) }
