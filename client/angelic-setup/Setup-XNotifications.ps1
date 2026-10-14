#requires -Version 5.1
<#
.SYNOPSIS
X通知の受信に必要な情報を、このPCのファイルに保存します。

.DESCRIPTION
通常は、ZIPをすべて展開した後で「ダブルクリックで開始.cmd」を開いてください。
このファイルは、その画面から呼び出される実処理です。PowerShellから直接実行する
場合にも、同じ配布ファイルの検証、安全確認、専用フォルダーの確認を行います。

使い方:
  1. X通知を設定するための、Firefoxの保存場所を作ります。これを「専用環境」と呼びます。
     普段使いのFirefoxとは別の場所に用意します。
  2. 「Xの設定用Firefoxを開く」で https://x.com/ を開き、Xへログインします。
     対象アカウントの投稿通知とブラウザー通知を、ご本人が有効にしてください。
  3. そのFirefoxを閉じてから、X通知の情報を新しいJSONファイルに保存します。
  4. 作成したファイルをWebの登録画面で選び、アップロードします。
     送信は、ご本人がWeb画面で操作したときに行われます。

ファイルの扱い:
  ・ファイルには、X通知を受信して読むための大切な情報が入ります。
    ファイル自体は暗号化されていません。本人とWindowsシステムだけが読めるように保護します。
    ご自身の登録用として保管し、アップロード先にはサービスのWeb登録画面を選んでください。
  ・X以外の通知設定がある場合は、保存直前にデータの扱いを説明し、作成するか確認します。
  ・通知の受信状況は、アップロード後にWeb画面で確認してください。

検証状況:
  ・Firefoxの実保存形式を使った合成通知データで、コピーからの読み取りとファイル作成を検証済みです。
  ・実際のX通知の受信と、PCを閉じた後のサーバー受信は、今後の検証項目です。

読み取る範囲:
  ・配布フォルダー内の決められた9ファイルと package-manifest.json。
  ・指定した保存先の所有マーカーと、このツール自身が作った起動記録。
  ・同じ専用プロファイルの決められたロックファイルの属性と共有状態のみ。
    ロックファイルの本文を読む処理はありません。
  ・抽出を実行するときだけ、専用profileのprefs.jsを行単位で確認し、
    dom.push.userAgentIDの設定1件だけを採用します。それ以外の設定値は保存しません。
  ・同じ専用profileの既知Push DB関連ファイルだけを、保護した一時作業先へコピーします。
  ・利用者が選んだFirefoxアプリの署名とファイルを読み、専用の一時アプリコピーを作ります。

作成する範囲:
  ・既定では %LOCALAPPDATA%\XNotificationSetup\FirefoxSetupPreview 以下。
  ・owner.json、空の firefox-profile フォルダー、起動記録用 launches フォルダー。
  ・起動ごとの新しいJSON記録。既存ファイルは上書き・削除しません。
  ・専用フォルダーのアクセス権を本人とWindowsシステムだけに制限します。
  ・Exportでは保護した一時コピーを作り、抽出用ブラウザーの終了確認後に削除します。
  ・-OutputPathで明示した新しいJSONファイル。既存ファイルは上書きしません。

読み取りは、このツールで用意した専用環境の通知情報に限ります。
普段使いのFirefoxや、旧版の保存場所はそのまま残します。
Cookie、保存パスワード、閲覧履歴はファイルに含めません。
Windowsの通常の利用権限で使えます。処理に使うコードは、この配布物に同梱しています。

.PARAMETER Action
Status: 状態確認だけを行います。省略した場合もこの操作です。
Prepare: 新しい専用保存先を作ります。準備済みなら既存の状態を確認します。
OpenFirefox: 準備済みの専用Firefoxを開きます。初回は先にPrepareを行ってください。
Export: 停止済みの専用profileから通知情報を取り出し、-OutputPathに新しいファイルを保存します。
Transfer: 作成したファイルをWeb画面からアップロードする手順を案内します。

.PARAMETER PrivateRoot
専用保存先を変更したい場合だけ、新しいローカルフォルダーの絶対パスを指定します。
このツールが作った保存場所、または準備用の新しい場所を指定してください。

.PARAMETER FirefoxPath
Firefoxが通常のインストール先で見つからない場合、そのfirefox.exeを指定します。
指定しなければProgram Files内の決められた候補だけを確認します。

.PARAMETER OutputPath
Exportで作る新しいJSONファイルの絶対パスを指定します。
「ドキュメント」など、配布フォルダーと専用保存先の外に、新しい名前で保存します。
ファイルには、X通知を読むための秘密情報が入ります。

.PARAMETER CancellationPath
画面版から中止を伝えるためのファイルです。通常の利用では指定する必要はありません。

.PARAMETER AllowOtherNotifications
CLI向け。X以外の通知設定が同じ専用Firefoxにある場合、READMEの説明を確認したうえで、
今回のファイル作成を明示的に許可します。ファイルに入るのはX用の通知情報と鍵だけです。
通知の受け取り先が共通のため、手動アップロード後には、他サイトの暗号化された通知データや
識別情報もサーバーへ届く可能性があります。受信したデータは、技術的には取得・保存できます。
現在はX以外のデータを保存・復号・利用せず、受信時に破棄します。
ほかのサイトの通知を利用する際は、別途、明確な許可を確認します。
破棄した通知は、後からFirefoxなどで受け取れない場合があります。
このスイッチは今回のファイル作成にだけ適用します。次回も説明の確認が必要です。

.PARAMETER PromptForOtherNotifications
日本語画面からの呼び出し用。混在がある場合は、作業用コピーを片付けた後、
新規ファイルの作成直前に説明と確認を表示します。「いいえ」が初期選択です。

.EXAMPLE
.\Setup-XNotifications.ps1 -Action Status
フォルダーを作成せず、現在の準備状態を表示します。

.EXAMPLE
.\Setup-XNotifications.ps1 -Action Prepare -WhatIf
作成予定を確認します。保存先やプロファイルは作成しません。

.EXAMPLE
.\Setup-XNotifications.ps1 -Action Prepare
.\Setup-XNotifications.ps1 -Action OpenFirefox
専用フォルダーを用意した後、専用Firefoxを開きます。

.EXAMPLE
.\Setup-XNotifications.ps1 -Action Export -OutputPath C:\Users\自分の名前\Desktop\X通知.json -WhatIf
実行前に保存予定を確認します。-WhatIfを外すと新しいファイルを作成します。

.NOTES
Windows PowerShell 5.1 / PowerShell 7対応。日本語の説明を5.1でも読めるよう
UTF-8 BOM付きで保存します。終了コード: 0=成功、2=配布物の検証失敗、
3=保存先や所有情報の安全確認失敗、4=起動不可/使用中、5=抽出やファイル作成の失敗、6=送信機能なし。

配布物内のSHA-256一致は、配布物同士の整合性を確認するものです。
配布元の正当性を確認するには、別途公開されたZIPのSHA-256とも照合してください。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateSet('Status', 'Prepare', 'OpenFirefox', 'Export', 'Transfer')]
    [string] $Action = 'Status',
    [string] $PrivateRoot,
    [string] $FirefoxPath,
    [string] $OutputPath,
    [string] $CancellationPath,
    [switch] $AllowOtherNotifications,
    [switch] $PromptForOtherNotifications
)

Set-StrictMode -Version 2.0
# エラーを握りつぶして次へ進めないため、予期しない失敗も最上位で安全に停止します。
# 画面へ返す値には、ブラウザーに保存された秘密情報や例外の詳細を含めません。
$ErrorActionPreference = 'Stop'
$script:ExitCode = 3
$script:AppId = 'x-notification-setup'
$script:PackageVersion = '0.1.0-preview.4'
$script:OwnerName = 'owner.json'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
# 画面版や外部ツールが5.1の状態JSON/日本語エラーを同じ文字コードで読めるよう、
# このプロセスの出力だけをUTF-8にそろえます。Windows全体の設定は変更しません。
[Console]::OutputEncoding = $script:Utf8
$script:PackageRoot = $PSScriptRoot
$script:HeldMutex = $null
$script:UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$script:SystemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')

# 表示用のエラーと終了コードだけを設定します。低レベルの例外本文は表示しません。
function Stop-Safely {
    param([int] $Code, [string] $Id, [string] $Message)
    $script:ExitCode = $Code
    throw ($Id + ': ' + $Message)
}

# ネットワーク共有、相対パス、別データストリームなど、扱いの曖昧な指定を拒否します。
# 入力をコマンドとして評価しないので、空白・角括弧・&・$はパスの文字として扱います。
function Get-LocalPath {
    param([string] $Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]') {
        Stop-Safely 3 'X_SETUP_PATH_REJECTED' 'このPC内の保存場所を、C:\ などのドライブ名から指定してください。'
    }
    if ($Value.Substring(2).Contains(':') -or $Value.IndexOf([char]0) -ge 0) {
        Stop-Safely 3 'X_SETUP_PATH_REJECTED' '保存場所を選び直し、C:\ などのドライブ名から指定してください。'
    }
    foreach ($part in ($Value.Substring(3) -split '[\\/]')) {
        if ($part -eq '.' -or $part -eq '..' -or $part -match '[ .]$') {
            Stop-Safely 3 'X_SETUP_PATH_REJECTED' 'フォルダー名の末尾の空白やピリオドを取り除き、ドライブ名から保存場所を指定してください。'
        }
    }
    try {
        $fullPath = [IO.Path]::GetFullPath($Value)
        $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($fullPath))
        if ($drive.DriveType -eq [IO.DriveType]::Network -or $drive.DriveType -eq [IO.DriveType]::NoRootDirectory -or
            $drive.DriveType -eq [IO.DriveType]::Unknown) { throw 'Unsupported drive' }
        return $fullPath.TrimEnd([char]'\')
    }
    catch { Stop-Safely 3 'X_SETUP_PATH_REJECTED' 'このPC内の保存場所を選び直してください。指定した場所を確認できませんでした。' }
}

# ファイル本文は開かず、存在と属性だけを調べます。未作成だけは正常な状態として返します。
# 権限不足などを「存在しない」と読み替えて上書きすることはありません。
function Get-PathAttributes {
    param([string] $Path)
    try { return [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { return $null }
    catch [IO.DirectoryNotFoundException] { return $null }
}

# 指定先だけでなくドライブ直下からすべての親を確認します。
# ジャンクション/シンボリックリンク経由で別の場所を触ることを防ぎます。
function Assert-SafePath {
    param([string] $Path)
    $volume = [IO.Path]::GetPathRoot($Path)
    $current = $volume
    $parts = $Path.Substring($volume.Length) -split '\\'
    $attributes = Get-PathAttributes $current
    if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Stop-Safely 3 'X_SETUP_REPARSE_REJECTED' 'このPC内のフォルダーを、ショートカットやリンクを通さずに指定してください。'
    }
    foreach ($part in $parts) {
        if ($part.Length -eq 0) { continue }
        $current = [IO.Path]::Combine($current, $part)
        $attributes = Get-PathAttributes $current
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Stop-Safely 3 'X_SETUP_REPARSE_REJECTED' 'このPC内のフォルダーを、ショートカットやリンクを通さずに指定してください。'
        }
    }
}

# 配布フォルダーと専用保存先が重なると検証対象へデータが混ざるため、包含関係を調べます。
function Test-InPath {
    param([string] $Child, [string] $Parent)
    return ($Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
        $Child.StartsWith($Parent.TrimEnd([char]'\') + '\', [StringComparison]::OrdinalIgnoreCase))
}

function Protect-NewPrivateRoot {
    # Prepareで今作った専用フォルダーだけに適用します。既存フォルダーの権限は書き換えません。
    # 親が共有用フォルダーでも、その共有アクセス権を専用保存先へ引き継がせません。
    # 本人のSIDとWindowsシステムだけに、子フォルダー/ファイルへ継承する権限を与えます。
    # .NETを直接使うことで、別版PowerShellのモジュール環境を引き継いだ場合の
    # セキュリティモジュール自動読込の衝突も避けます。所有者や監査設定は変更しません。
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($identity in @($script:UserSid, $script:SystemSid)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $null = $acl.AddAccessRule($rule)
    }
    if ($PSVersionTable.PSVersion.Major -le 5) {
        (New-Object IO.DirectoryInfo($script:Root)).SetAccessControl($acl)
    }
    else {
        # PowerShell 7では同等の.NET拡張APIを使います。
        # 一部のSet-Aclで不要な監査権限を要求する問題を避け、アクセス権だけを保存します。
        [IO.FileSystemAclExtensions]::SetAccessControl((New-Object IO.DirectoryInfo($script:Root)), $acl)
    }
}

# 準備済みフォルダーでは、本人+Windowsシステムの制限が保たれているか読むだけです。
# 権限が変わっていた場合、自動で修復・上書きせず、安全のため停止します。
function Assert-PrivateRootAcl {
    $directory = New-Object IO.DirectoryInfo($script:Root)
    if ($PSVersionTable.PSVersion.Major -le 5) {
        $acl = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    }
    else {
        $acl = [IO.FileSystemAclExtensions]::GetAccessControl($directory, [Security.AccessControl.AccessControlSections]::Access)
    }
    if (-not $acl.AreAccessRulesProtected) { throw 'Private root inherits parent permissions.' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'Unexpected private root access rules.' }
    $identities = @()
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($rule in $rules) {
        if (($rule.IdentityReference.Value -ne $script:UserSid.Value -and $rule.IdentityReference.Value -ne $script:SystemSid.Value) -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $inheritance -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited) {
            throw 'Private root permissions mismatch.'
        }
        $identities += $rule.IdentityReference.Value
    }
    if ($identities -notcontains $script:UserSid.Value -or $identities -notcontains $script:SystemSid.Value) {
        throw 'Private root identity mismatch.'
    }
}

# 読み取りはこのツールの小さな管理JSONだけに使います。ブラウザーDBを読む関数ではありません。
# 大きすぎるファイルや空の記録は、途中失敗/改変の可能性があるため受け付けません。
function Read-SmallJson {
    param([string] $Path, [int] $MaxBytes = 16384)
    Assert-SafePath $Path
    $info = Get-Item -LiteralPath $Path -Force
    if ($info.PSIsContainer -or $info.Length -gt $MaxBytes -or $info.Length -eq 0) {
        Stop-Safely 3 'X_SETUP_METADATA_REJECTED' 'ツール用の保存場所をそのまま残して、サポートへご相談ください。管理用ファイルを読み取れませんでした。'
    }
    return ([IO.File]::ReadAllText($Path, $script:Utf8) | ConvertFrom-Json)
}

# JSONに必要な項目が過不足なくあるか確認します。未知の設定を暗黙に受け入れません。
function Assert-PropertyNames {
    param($Object, [string[]] $Expected)
    if ($null -eq $Object) { throw 'Invalid metadata object.' }
    $actual = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) { throw 'Invalid metadata properties.' }
    foreach ($name in $actual) {
        if ($Expected -cnotcontains $name) { throw 'Invalid metadata property.' }
    }
}

# すべての操作で最初に呼びます。ファイル作成、Firefox起動よりも先に検証を終えます。
# 配布物に余分なスクリプトやフォルダーがあっても停止します。ZIPへ手で追加しないでください。
function Assert-Package {
    $script:ExitCode = 2
    try {
        $script:PackageRoot = Get-LocalPath $PSScriptRoot
        Assert-SafePath $script:PackageRoot
        $packageFiles = @('Setup-XNotifications.ps1', 'Start-Setup.ps1', 'はじめに読んでください.txt', 'README-ja.md', 'LICENSE', 'ダブルクリックで開始.cmd', 'FirefoxReader.ps1', 'Export-XNotificationData.ps1', 'Read-PushSubscription.js')
        $allowed = $packageFiles + @('package-manifest.json')
        $entries = @(Get-ChildItem -LiteralPath $script:PackageRoot -Force)
        if ($entries.Count -ne $allowed.Count) { throw 'Package file count mismatch.' }
        foreach ($entry in $entries) {
            if ($entry.PSIsContainer -or $allowed -cnotcontains $entry.Name) { throw 'Unexpected package entry.' }
            Assert-SafePath $entry.FullName
        }
        $manifest = Read-SmallJson ([IO.Path]::Combine($script:PackageRoot, 'package-manifest.json'))
        Assert-PropertyNames $manifest @('schemaVersion', 'packageId', 'version', 'capabilities', 'files')
        if ($manifest.schemaVersion -ne 1 -or $manifest.packageId -cne $script:AppId -or
            $manifest.version -cne $script:PackageVersion) { throw 'Unsupported package identity.' }
        Assert-PropertyNames $manifest.capabilities @('prepareProfile', 'openFirefox', 'realPushExport', 'serverTransfer')
        if ($manifest.capabilities.prepareProfile -isnot [bool] -or -not $manifest.capabilities.prepareProfile -or
            $manifest.capabilities.openFirefox -isnot [bool] -or -not $manifest.capabilities.openFirefox -or
            $manifest.capabilities.realPushExport -isnot [bool] -or -not $manifest.capabilities.realPushExport -or
            $manifest.capabilities.serverTransfer -isnot [bool] -or $manifest.capabilities.serverTransfer) {
            throw 'Capability mismatch.'
        }
        Assert-PropertyNames $manifest.files $packageFiles
        foreach ($name in $packageFiles) {
            $expected = $manifest.files.PSObject.Properties[$name].Value
            if ($expected -isnot [string] -or $expected -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid checksum.' }
            $path = [IO.Path]::Combine($script:PackageRoot, $name)
            # 配布ファイルの本文だけを読み、SHA-256を照合します。
            # PowerShell 5.1のGet-FileHash内部処理は親の-WhatIfに影響されるため、
            # 参照のみの検証が省略されないよう.NETで直接計算します。
            $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
            $fileStream = [IO.File]::OpenRead($path)
            try { $actual = [BitConverter]::ToString($hashAlgorithm.ComputeHash($fileStream)).Replace('-', '').ToLowerInvariant() }
            finally { $fileStream.Dispose(); $hashAlgorithm.Dispose() }
            if ($actual -cne $expected) { throw 'Checksum mismatch.' }
        }
    }
    catch { Stop-Safely 2 'X_SETUP_PACKAGE_INVALID' 'ZIPを新しくダウンロードし、空のフォルダーへ展開してください。配布元のZIPの照合値（SHA256）でも、正しいファイルか確認できます。' }
    $script:ExitCode = 3
}

# 指定先がなければ「未準備」です。存在する場合は、まず自作マーカーの存在を調べます。
# マーカーのない既存フォルダーは、中を走査せず拒否します。普段使いのプロファイルは使いません。
function Get-Owner {
    Assert-SafePath $script:Root
    $attributes = Get-PathAttributes $script:Root
    if ($null -eq $attributes) { return $null }
    if (-not ($attributes -band [IO.FileAttributes]::Directory)) {
        Stop-Safely 3 'X_SETUP_NOT_OWNED' 'このツールで準備した保存場所を指定してください。初めて使う場合は、新しい場所を指定してPrepareを実行します。'
    }
    $ownerPath = [IO.Path]::Combine($script:Root, $script:OwnerName)
    if ($null -eq (Get-PathAttributes $ownerPath)) {
        Stop-Safely 3 'X_SETUP_NOT_OWNED' 'これから新しく作るフォルダー名を指定してください。指定先には、すでに別のフォルダーがあります。'
    }
    try {
        Assert-PrivateRootAcl
        $owner = Read-SmallJson $ownerPath
        Assert-PropertyNames $owner @('schemaVersion', 'appId', 'profileId', 'rootPath', 'profilePath', 'createdUtc')
        $profileGuid = [Guid]::Empty
        if ($owner.schemaVersion -ne 1 -or $owner.appId -cne $script:AppId -or
            -not [Guid]::TryParseExact([string]$owner.profileId, 'D', [ref]$profileGuid) -or
            $owner.rootPath -cne $script:Root -or $owner.profilePath -cne $script:ProfilePath) {
            throw 'Ownership mismatch.'
        }
        foreach ($path in @($script:ProfilePath, $script:LaunchRoot)) {
            Assert-SafePath $path
            $attributes = Get-PathAttributes $path
            if ($null -eq $attributes -or -not ($attributes -band [IO.FileAttributes]::Directory)) {
                throw 'Owned directory missing.'
            }
        }
        return $owner
    }
    catch { Stop-Safely 3 'X_SETUP_OWNER_INVALID' 'ツール用の保存場所をそのまま残して、サポートへご相談ください。このツールで作った保存場所か確認できませんでした。' }
}

# 新規専用保存先に管理JSONを作るための関数です。CreateNewにより既存ファイルは上書きしません。
function Write-NewJson {
    param([string] $Path, $Value)
    Assert-SafePath $Path
    $bytes = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 8))
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
    finally { $stream.Dispose() }
}

# 同じ専用保存先を二つのウィンドウが同時操作しないよう、Windowsの一時ロックを取得します。
# ディスクへロック用ファイルを増やさず、スクリプト終了時に解放します。
function Enter-ActionMutex {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($script:Utf8.GetBytes($script:Root.ToUpperInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    $script:HeldMutex = New-Object Threading.Mutex($false, ('Local\XNotificationSetup-' + $hash))
    try { $acquired = $script:HeldMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        $script:HeldMutex.Dispose()
        $script:HeldMutex = $null
        Stop-Safely 4 'X_SETUP_ACTION_BUSY' '先に始めた処理が終わるまでお待ちください。同じ保存場所で作業中です。'
    }
}

# 調べるのは自作launchesフォルダー内の記録だけです。PC全体のプロセス一覧は取得しません。
# 記録されたPIDと起動時刻を照合し、PIDが別のアプリに再利用された場合を区別します。
function Get-LaunchState {
    param($Owner)
    $active = $false
    $count = 0
    foreach ($entry in @(Get-ChildItem -LiteralPath $script:LaunchRoot -Force)) {
        if ($entry.PSIsContainer -or $entry.Name -cnotmatch '^launch-[0-9a-f-]{36}\.json$') {
            Stop-Safely 3 'X_SETUP_LAUNCH_METADATA_INVALID' 'ツール用の保存場所をそのまま残して、サポートへご相談ください。Firefoxの起動記録を確認できませんでした。'
        }
        try {
            $record = Read-SmallJson $entry.FullName
            Assert-PropertyNames $record @('schemaVersion', 'appId', 'profileId', 'pid', 'processStartedUtc', 'launchedUtc', 'state')
            if ($record.schemaVersion -ne 1 -or $record.appId -cne $script:AppId -or
                $record.profileId -cne $Owner.profileId -or $record.state -cne 'started' -or
                ($record.pid -isnot [int] -and $record.pid -isnot [long]) -or
                $record.pid -le 0 -or $record.pid -gt [int]::MaxValue) { throw 'Invalid launch record.' }
            $recordStarted = [DateTime]::MinValue
            if ($record.processStartedUtc -is [DateTime]) { $recordStarted = $record.processStartedUtc.ToUniversalTime() }
            elseif (-not [DateTime]::TryParseExact([string]$record.processStartedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind, [ref]$recordStarted)) { throw 'Invalid process start time.' }
            $knownProcess = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
            if ($null -ne $knownProcess) {
                try {
                    if ($knownProcess.StartTime.ToUniversalTime().Ticks -eq $recordStarted.ToUniversalTime().Ticks) { $active = $true }
                }
                finally { $knownProcess.Dispose() }
            }
        }
        catch { Stop-Safely 3 'X_SETUP_LAUNCH_METADATA_INVALID' 'ツール用の保存場所をそのまま残して、サポートへご相談ください。Firefoxの起動記録の確認が必要です。' }
        $count++
    }
    $locked = $false
    foreach ($name in @('parent.lock', '.parentlock', 'lock')) {
        $path = [IO.Path]::Combine($script:ProfilePath, $name)
        Assert-SafePath $path
        if ($null -ne (Get-PathAttributes $path)) {
            # 終了後にもFirefoxのロックファイルが残ることがあります。
            # 共有できるかの確認だけを行い、本文の読み取り・書き込み・作成・削除は行いません。
            $lockStream = $null
            try { $lockStream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
            catch { $locked = $true }
            finally { if ($null -ne $lockStream) { $lockStream.Dispose() } }
        }
    }
    return [pscustomobject]@{ active = $active; locked = $locked; launchCount = $count }
}

# 利用者が明示した実行ファイルを優先します。未指定なら通常の決められた配置だけを確認します。
# ディスク全体、PATH、Firefoxの設定一覧、普段使いのプロファイルは検索しません。
function Get-FirefoxExecutable {
    if (-not [string]::IsNullOrWhiteSpace($FirefoxPath)) { $candidates = @($FirefoxPath) }
    else {
        $candidates = @()
        foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (-not [string]::IsNullOrWhiteSpace($base)) { $candidates += [IO.Path]::Combine($base, 'Mozilla Firefox', 'firefox.exe') }
        }
        $candidates = @($candidates | Select-Object -Unique)
    }
    foreach ($candidate in $candidates) {
        $path = Get-LocalPath $candidate
        Assert-SafePath $path
        if ([IO.Path]::GetExtension($path) -ine '.exe') {
            Stop-Safely 4 'X_SETUP_FIREFOX_INVALID' 'Firefoxをインストールしたフォルダーにあるfirefox.exeを指定してください。'
        }
        $attributes = Get-PathAttributes $path
        if ($null -ne $attributes -and -not ($attributes -band [IO.FileAttributes]::Directory)) { return $path }
    }
    Stop-Safely 4 'X_SETUP_FIREFOX_NOT_FOUND' '-FirefoxPathで、Firefox本体のfirefox.exeを指定してください。Firefoxをお持ちでない場合は、公式Firefoxをインストールしてください。'
}

function ConvertTo-WindowsArgument {
    param([string] $Value)
    # Windowsの引数規則に合わせ、引用符前と末尾のバックスラッシュを正しく二重化します。
    # パスに空白や&や$があっても、シェルの命令や別の引数に変化させず、そのまま渡します。
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

try {
    # 最初に配布物を検証します。失敗時は保存先の作成もブラウザー起動も行いません。
    Assert-Package
    # このツールは外部送信しません。Transferは案内だけで、保存先の参照前に終了します。
    if ($Action -eq 'Transfer') { Stop-Safely 6 'X_SETUP_TRANSFER_NOT_AVAILABLE' '作成したファイルをWebの登録画面で選び、ご自身でアップロードしてください。' }
    if ($Action -eq 'Export' -and [string]::IsNullOrWhiteSpace($OutputPath)) {
        Stop-Safely 5 'X_SETUP_OUTPUT_REQUIRED' '保存する新しいJSONファイルの絶対パスを-OutputPathで指定してください。'
    }
    if ([string]::IsNullOrWhiteSpace($PrivateRoot)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Stop-Safely 3 'X_SETUP_LOCALAPPDATA_MISSING' 'LOCALAPPDATAを確認できません。-PrivateRootを指定してください。' }
        # 旧版の保存先は探しません。この版の新しい専用保存先だけを対象にします。
        $PrivateRoot = [IO.Path]::Combine($env:LOCALAPPDATA, 'XNotificationSetup', 'FirefoxSetupPreview')
    }
    $script:Root = Get-LocalPath $PrivateRoot
    if ($script:Root.Length -le 3 -or (Test-InPath $script:Root $script:PackageRoot) -or (Test-InPath $script:PackageRoot $script:Root)) {
        Stop-Safely 3 'X_SETUP_PRIVATE_ROOT_REJECTED' '専用フォルダーは配布フォルダーと独立した新しいパスにしてください。'
    }
    $script:ProfilePath = [IO.Path]::Combine($script:Root, 'firefox-profile')
    $script:LaunchRoot = [IO.Path]::Combine($script:Root, 'launches')
    if ($Action -eq 'Prepare' -or $Action -eq 'OpenFirefox' -or $Action -eq 'Export') { Enter-ActionMutex }
    $owner = Get-Owner
    $exportSummary = $null
    if ($Action -eq 'Prepare') {
        # -WhatIfのときは予定表示だけです。承認された場合だけ、新しいフォルダーを作成します。
        # アクセス権の制限を完了してから、プロファイルや所有マーカーを作成します。
        if ($null -eq $owner -and $PSCmdlet.ShouldProcess($script:Root, '専用Firefoxプロファイルと所有マーカーを新規作成')) {
            Assert-SafePath $script:Root
            $null = New-Item -ItemType Directory -Path $script:Root -ErrorAction Stop
            Assert-SafePath $script:Root
            Protect-NewPrivateRoot
            Assert-PrivateRootAcl
            $null = New-Item -ItemType Directory -Path $script:ProfilePath -ErrorAction Stop
            $null = New-Item -ItemType Directory -Path $script:LaunchRoot -ErrorAction Stop
            $newOwner = [ordered]@{
                schemaVersion = 1; appId = $script:AppId; profileId = [Guid]::NewGuid().ToString('D')
                rootPath = $script:Root; profilePath = $script:ProfilePath; createdUtc = [DateTime]::UtcNow.ToString('o')
            }
            Write-NewJson ([IO.Path]::Combine($script:Root, $script:OwnerName)) $newOwner
            $owner = Get-Owner
        }
    }
    if ($Action -eq 'OpenFirefox') {
        # 起動はこの操作を選んだときだけです。PrepareやStatusだけでは外部サイトを開きません。
        # 使用中のPIDや実ロックがあれば拒否し、他のプロセスを終了させることはありません。
        if ($null -eq $owner) { Stop-Safely 3 'X_SETUP_PROFILE_NOT_PREPARED' '先に-Action Prepareで専用プロファイルを作成してください。' }
        $state = Get-LaunchState $owner
        if ($state.active -or $state.locked) { Stop-Safely 4 'X_SETUP_PROFILE_BUSY' 'このツールで開いたFirefoxをすべて閉じてから、もう一度実行してください。現在、X通知用の設定を使用中です。' }
        $executable = Get-FirefoxExecutable
        if ($PSCmdlet.ShouldProcess($script:ProfilePath, 'Xの設定用Firefoxを開く（ログインと通知設定はご本人が操作）')) {
            Assert-SafePath $script:Root
            Assert-SafePath $executable
            $launchPath = [IO.Path]::Combine($script:LaunchRoot, ('launch-' + [Guid]::NewGuid().ToString('D') + '.json'))
            Assert-SafePath $launchPath
            # 起動前に新しい記録ファイルを予約します。途中で失敗して不完全な記録が残った場合も、
            # 次回はその記録を検出して起動を止めます。安全確認なしに重複起動させません。
            $stream = [IO.File]::Open($launchPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $startInfo = New-Object Diagnostics.ProcessStartInfo
                $startInfo.FileName = $executable
                $startInfo.UseShellExecute = $false
                $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($executable)
                # Firefox自身の再起動用環境変数は--profileより優先する場合があるため除去します。
                # 手動閲覧では通常のAPPDATA等は維持し、専用profile選択を上書きする値だけ遮断します。
                foreach ($name in @($startInfo.EnvironmentVariables.Keys)) {
                    if (([string]$name).StartsWith('XRE_', [StringComparison]::OrdinalIgnoreCase) -or
                        ([string]$name).StartsWith('XUL_', [StringComparison]::OrdinalIgnoreCase) -or
                        ([string]$name).StartsWith('MOZ_', [StringComparison]::OrdinalIgnoreCase) -or
                        ([string]$name).StartsWith('NSPR_', [StringComparison]::OrdinalIgnoreCase) -or
                        ([string]$name).StartsWith('SELECTABLE_PROFILE_RESET_', [StringComparison]::OrdinalIgnoreCase)) {
                        $startInfo.EnvironmentVariables.Remove([string]$name)
                    }
                }
                # 自分の専用プロファイルとXのURLだけを指定します。
                # X画面の自動操作、ログイン情報の取得、通知設定の自動変更は行いません。
                $startInfo.Arguments = (@('-no-remote', '-profile', $script:ProfilePath, 'https://x.com/') | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
                $process = [Diagnostics.Process]::Start($startInfo)
                if ($null -eq $process) { throw 'No process handle.' }
                try {
                    $record = [ordered]@{ schemaVersion = 1; appId = $script:AppId; profileId = $owner.profileId; pid = [int]$process.Id; processStartedUtc = $process.StartTime.ToUniversalTime().ToString('o'); launchedUtc = [DateTime]::UtcNow.ToString('o'); state = 'started' }
                    $bytes = $script:Utf8.GetBytes(($record | ConvertTo-Json -Depth 4))
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                }
                finally { $process.Dispose() }
            }
            catch { Stop-Safely 4 'X_SETUP_FIREFOX_LAUNCH_FAILED' 'このツールで開いたFirefoxを閉じ、もう一度お試しください。起動できない場合は、現在の保存場所をそのまま残してサポートへご相談ください。' }
            finally { $stream.Dispose() }
        }
    }
    if ($Action -eq 'Export') {
        if ($null -eq $owner) { Stop-Safely 3 'X_SETUP_PROFILE_NOT_PREPARED' '専用Firefoxを準備し、Xの通知を手動設定してから閉じてください。' }
        $state = Get-LaunchState $owner
        if ($state.active -or $state.locked) { Stop-Safely 4 'X_SETUP_PROFILE_BUSY' '専用Firefoxを完全に閉じてから、ファイル作成を実行してください。' }
        $script:ExitCode = 5
        $target = Get-LocalPath $OutputPath
        Assert-SafePath $target
        if ((Test-InPath $target $script:Root) -or (Test-InPath $target $script:PackageRoot) -or
            $null -ne (Get-PathAttributes $target) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($target))) {
            Stop-Safely 5 'X_SETUP_OUTPUT_PATH_REJECTED' '配布フォルダーと専用保存先の外に、新しいファイル名を指定してください。'
        }
        $executable = Get-FirefoxExecutable
        if ($PSCmdlet.ShouldProcess($target, 'X通知を受信して読むための情報を、このPCの新しいJSONファイルへ保存')) {
            # 配布物の全ハッシュは既に検証済みです。補助コードは固定ファイルだけを読み込みます。
            . ([IO.Path]::Combine($script:PackageRoot, 'FirefoxReader.ps1'))
            . ([IO.Path]::Combine($script:PackageRoot, 'Export-XNotificationData.ps1'))
            $exportSummary = Invoke-XSetupExport -Owner $owner -OutputPath $target -FirefoxExecutable $executable -CancellationPath $CancellationPath `
                -AllowOtherNotifications:$AllowOtherNotifications -PromptForOtherNotifications:$PromptForOtherNotifications
        }
    }
    $state = $null
    if ($null -ne $owner) { $state = Get-LaunchState $owner }
    # 画面とCLIで共通利用する安全な状態JSONです。Push情報・秘密鍵・Cookie等は含みません。
    [ordered]@{
        displayName = 'X通知データの保存ツール'
        appId = $script:AppId; version = $script:PackageVersion; action = $Action
        packageVerified = $true; prepared = ($null -ne $owner); privateRoot = $script:Root
        profilePath = $script:ProfilePath; firefoxActive = ($null -ne $state -and $state.active)
        profileLocked = ($null -ne $state -and $state.locked)
        capabilities = [ordered]@{ prepareProfile = $true; openFirefox = $true; realPushExport = $true; serverTransfer = $false }
        realPushExport = 'Available'; serverTransfer = 'NotAvailable'
        fileCreated = ($null -ne $exportSummary -and $exportSummary.fileCreated)
        exportPath = $(if ($null -ne $exportSummary) { $exportSummary.exportPath } else { $null })
    } | ConvertTo-Json -Depth 4
    $script:ExitCode = 0
}
catch {
    # 予期したエラーは理解できる説明だけを返します。
    # 想定外の例外にはパスや環境情報が混ざり得るため、例外全文/スタックは画面へ出しません。
    $message = [string]$_.Exception.Message
    if ($message -notmatch '^X_SETUP_[A-Z_]+:') { $message = 'X_SETUP_OPERATION_FAILED: 説明の手順を確認して、もう一度お試しください。解決しない場合は、現在のデータをそのまま残してサポートへご相談ください。' }
    [Console]::Error.WriteLine($message)
}
finally {
    # 成功・中断・失敗のいずれでも、自分が取得した一時ロックだけを解放します。
    if ($null -ne $script:HeldMutex) {
        try { $script:HeldMutex.ReleaseMutex() } catch { }
        $script:HeldMutex.Dispose()
    }
}
exit $script:ExitCode
