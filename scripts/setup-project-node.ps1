<#
.SYNOPSIS
保守担当者向け: このプロジェクト専用の検証済み Windows Node.js を用意します。
.DESCRIPTION
Firefox通知データの保存ツールを使う一般利用者には、この処理は不要です。
管理者権限、既存Node.jsの置換、PATHやレジストリの変更は行いません。
公式の固定URLからZIPをダウンロードし、固定SHA-256を確認してから展開します。
展開したnode.exeも固定SHA-256とOpenJS Foundationの有効な署名を確認します。
既に保存先がある場合は検証だけを行い、不明なファイルを上書き・削除しません。
失敗した実行を自動再試行したり、JIT無効化などの回避設定を付けたりしません。
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$nodeVersion = '24.21.0'
$releaseName = 'node-v24.21.0-win-x64'
$zipHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$exeHash = 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
$downloadUrl = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
$stagePath = $null
$stageToken = $null
$published = $false
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$previousOutputEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Assert-LocalPath {
    param([string] $Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]' -or
        $Value -match '[\x00-\x1f<>"|?*]' -or $Value.Substring(2).Contains(':')) {
        throw 'ローカルの実行環境の保存先を確認できません。'
    }
    foreach ($part in $Value.Substring(3).Split([char[]]@('\', '/'))) {
        if ($part -eq '.' -or $part -eq '..' -or $part -match '[ .]$') { throw '不正な保存先です。' }
    }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-NoLinks {
    param([string] $Value)
    $full = Assert-LocalPath $Value
    $current = [IO.Path]::GetPathRoot($full)
    $relative = $full.Substring($current.Length)
    foreach ($part in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
        if ($part.Length -eq 0) { continue }
        $current = [IO.Path]::Combine($current, $part)
        # Test-Path can report false for a broken junction. Query the directory
        # entry's attributes so a missing link target is never treated as a new
        # ordinary directory that this installer is allowed to create.
        try { $attributes = [IO.File]::GetAttributes($current) }
        catch [IO.FileNotFoundException] { continue }
        catch [IO.DirectoryNotFoundException] { continue }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw '保存先にリンクがあります。リンクをたどって実行環境を作成・削除することはできません。'
        }
    }
}

function Assert-VerifiedNode {
    param([string] $Executable)
    Assert-NoLinks $Executable
    if (-not [IO.File]::Exists($Executable)) { throw '保存済み実行環境が不完全です。上書きせず中止しました。' }
    if ((Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $exeHash) {
        throw 'node.exe のSHA-256が一致しません。既存ファイルは変更していません。'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Executable
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=OpenJS Foundation(,|$)') {
        throw 'OpenJS Foundationの有効な署名を確認できません。実行環境は有効化しません。'
    }
}

function Remove-OwnedStage {
    param([string] $Directory, [string] $Token, [string] $Root)
    # 削除対象は今回自分で作った、固定キャッシュ直下のGUID付き一時フォルダーだけです。
    # 再帰削除の前に絶対パス、所有マーカー、リンクがないことを確認します。
    $resolved = Assert-LocalPath $Directory
    $resolvedRoot = Assert-LocalPath $Root
    if (-not [IO.Path]::GetDirectoryName($resolved).Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notmatch '^\.node-v24\.21\.0-[0-9a-f]{32}\.tmp$') {
        throw '一時フォルダーの削除範囲を確認できません。'
    }
    Assert-NoLinks $resolved
    $marker = [IO.Path]::Combine($resolved, '.project-node-stage-owner')
    Assert-NoLinks $marker
    if (-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker) -cne $Token) {
        throw '一時フォルダーの所有確認に失敗したため、削除しません。'
    }
    function Remove-CheckedContents {
        param([string] $Current)
        foreach ($item in @(Get-ChildItem -LiteralPath $Current -Force)) {
            $target = Assert-LocalPath $item.FullName
            if (-not $target.StartsWith($resolved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '一時フォルダー内に不正な項目があるため、削除を中止しました。'
            }
            if ($item.PSIsContainer) { Remove-CheckedContents $target }
            Remove-Item -LiteralPath $target -Force
        }
    }
    Remove-CheckedContents $resolved
    Remove-Item -LiteralPath $resolved -Force
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
        throw 'このセットアップはWindows x64用です。'
    }
    # PowerShell 7から5.1を起動した場合、継承したPSModulePathが別版の
    # モジュールを先に指すことがあります。このホスト自身に付属する固定の
    # モジュールを読み込み、PATH/PSModulePathを恒久変更しません。
    foreach ($moduleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Archive')) {
        Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))) -ErrorAction Stop
    }
    $localRoot = Assert-LocalPath $env:LOCALAPPDATA
    $cacheRoot = [IO.Path]::Combine($localRoot, 'cbte-runtimes')
    $releasePath = [IO.Path]::Combine($cacheRoot, $releaseName)
    $executable = [IO.Path]::Combine($releasePath, $releaseName, 'node.exe')
    Assert-NoLinks $cacheRoot
    Assert-NoLinks $releasePath
    if (Test-Path -LiteralPath $releasePath) {
        Assert-VerifiedNode $executable
    }
    else {
        $null = [IO.Directory]::CreateDirectory($cacheRoot)
        Assert-NoLinks $cacheRoot
        $stageToken = [Guid]::NewGuid().ToString('N')
        $stagePath = [IO.Path]::Combine($cacheRoot, ('.node-v24.21.0-' + $stageToken + '.tmp'))
        if (Test-Path -LiteralPath $stagePath) { throw '一時保存先が既にあるため中止しました。' }
        $null = [IO.Directory]::CreateDirectory($stagePath)
        [IO.File]::WriteAllText([IO.Path]::Combine($stagePath, '.project-node-stage-owner'), $stageToken)
        $zipPath = [IO.Path]::Combine($stagePath, 'node.zip')
        $readyPath = [IO.Path]::Combine($stagePath, 'ready')
        # TLSの設定変更はこの保守用PowerShellプロセス内だけで、終了時に元へ戻します。
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing -MaximumRedirection 0
        if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $zipHash) {
            throw '公式ZIPのSHA-256が一致しません。展開・実行は行いません。'
        }
        $null = [IO.Directory]::CreateDirectory($readyPath)
        Expand-Archive -LiteralPath $zipPath -DestinationPath $readyPath
        Assert-VerifiedNode ([IO.Path]::Combine($readyPath, $releaseName, 'node.exe'))
        # 同一ボリューム上のDirectory.Moveは既存の保存先へマージしません。
        # 他のセットアップと競合した場合も、既存ファイルを上書きせず失敗します。
        Assert-NoLinks $cacheRoot
        Assert-NoLinks $releasePath
        [IO.Directory]::Move($readyPath, $releasePath)
        $published = $true
        Assert-VerifiedNode $executable
    }
    [ordered]@{ version = $nodeVersion; executable = $executable; sha256 = $exeHash;
        zipSha256 = $zipHash; globalNodeChanged = $false } | ConvertTo-Json
}
catch {
    [Console]::Error.WriteLine('プロジェクト専用Node.jsの準備を完了できませんでした。 ' + $_.Exception.Message)
    if ($published) { [Console]::Error.WriteLine('検証途中の保存先は自動削除していません。保守担当者が確認してください。') }
    exit 1
}
finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    [Console]::OutputEncoding = $previousOutputEncoding
    if ($null -ne $stagePath -and [IO.Directory]::Exists($stagePath)) {
        try { Remove-OwnedStage $stagePath $stageToken $cacheRoot }
        catch { [Console]::Error.WriteLine('今回の一時フォルダーを片付けられませんでした。 ' + $stagePath); exit 1 }
    }
}
