#requires -Version 5.1
<#
.SYNOPSIS
インストール済み Edge の通知接続形式を、一時的なテスト環境で確認します。
.DESCRIPTION
新しい専用フォルダーとローカルのテストページを使います。普段のブラウザーや
X の設定は開きません。確認後はプロセスを終了し、一時フォルダーを削除します。
このファイルを使う前に、呼び出し元で配布物のハッシュと専用フォルダーの
所有情報・アクセス権を確認してください。ファイルのアップロードは行いません。
#>
function Remove-XEdgeCalibration {
    param([Parameter(Mandatory=$true)][string] $CalibrationRoot, [Parameter(Mandatory=$true)][string] $Token)
    if ($Token -cnotmatch '^[0-9a-f]{32}$' -or $CalibrationRoot -cne [IO.Path]::Combine($script:Root, ('edge-calibration-' + $Token))) {
        throw 'X_EDGE_CALIBRATION_CLEANUP_FAILED: 一時保存先を確認できません。'
    }
    Assert-SafePath $CalibrationRoot
    $markerPath = [IO.Path]::Combine($CalibrationRoot, 'owner.json')
    $marker = Read-SmallJson $markerPath
    Assert-PropertyNames $marker @('appId', 'kind', 'token')
    if ($marker.appId -cne 'x-notification-setup' -or $marker.kind -cne 'edge-calibration-v1' -or $marker.token -cne $Token) {
        throw 'X_EDGE_CALIBRATION_CLEANUP_FAILED: 一時保存先の所有情報を確認できません。'
    }
    $directories = New-Object 'Collections.Generic.List[string]'
    $files = New-Object 'Collections.Generic.List[string]'
    $directories.Add($CalibrationRoot)
    for ($index = 0; $index -lt $directories.Count; $index++) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directories[$index])) {
            if (-not $entry.StartsWith($CalibrationRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'X_EDGE_CALIBRATION_CLEANUP_FAILED: 一時保存先を確認できません。' }
            Assert-SafePath $entry
            if ($directories.Count + $files.Count -ge 20000) { throw 'X_EDGE_CALIBRATION_CLEANUP_FAILED: 一時保存先の件数を確認できません。' }
            $attributes = [IO.File]::GetAttributes($entry)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'X_EDGE_CALIBRATION_CLEANUP_FAILED: 一時保存先を確認できません。' }
            if ($attributes -band [IO.FileAttributes]::Directory) { $directories.Add($entry) }
            elseif ($entry -cne $markerPath) { $files.Add($entry) }
        }
    }
    foreach ($file in $files) { [IO.File]::Delete($file) }
    for ($index = $directories.Count - 1; $index -gt 0; $index--) { [IO.Directory]::Delete($directories[$index], $false) }
    [IO.File]::Delete($markerPath)
    [IO.Directory]::Delete($CalibrationRoot, $false)
}

function Invoke-XEdgeCalibration {
    param([Parameter(Mandatory=$true)][string] $EdgePath, [Parameter(Mandatory=$true)][string] $BrowserVersion)
    if ($BrowserVersion -cnotmatch '^[0-9]{1,3}(\.[0-9]{1,5}){3}$') { throw 'X_EDGE_CALIBRATION_INVALID: ブラウザーの情報を確認できません。' }
    Assert-SafePath $script:Root
    Assert-PrivateDirectory $script:Root
    $token = [Guid]::NewGuid().ToString('N')
    $calibrationRoot = [IO.Path]::Combine($script:Root, ('edge-calibration-' + $token))
    Assert-SafePath $calibrationRoot
    if ($null -ne (Get-PathAttributes $calibrationRoot)) { throw 'X_EDGE_CALIBRATION_INVALID: 一時保存先を準備できません。' }
    $created = $false; $job = $null; $certificate = $null; $inputBytes = $null; $outputBytes = $null; $cleanupFailed = $false
    try {
        New-PrivateDirectory $calibrationRoot; $created = $true
        Assert-SafePath $calibrationRoot; Assert-PrivateDirectory $calibrationRoot
        Write-NewJson ([IO.Path]::Combine($calibrationRoot, 'owner.json')) ([ordered]@{
            appId = 'x-notification-setup'; kind = 'edge-calibration-v1'; token = $token
        })
        $profile = [IO.Path]::Combine($calibrationRoot, 'profile'); Assert-SafePath $profile
        $null = [IO.Directory]::CreateDirectory($profile)
        . ([IO.Path]::Combine($script:PackageRoot, 'EdgeEphemeralCertificate.ps1'))
        . ([IO.Path]::Combine($script:PackageRoot, 'EdgeCalibrationJob.ps1'))
        $certificate = New-XEdgeEphemeralCertificate
        Initialize-XEdgeCalibrationJob
        $inputObject = [ordered]@{ rootPath = $calibrationRoot; token = $token; edgePath = $EdgePath
            pfx = [Convert]::ToBase64String($certificate.pfx).TrimEnd('=').Replace('+','-').Replace('/','_')
            passphrase = $certificate.password
            certificate = [Convert]::ToBase64String($certificate.certificate).TrimEnd('=').Replace('+','-').Replace('/','_') }
        $inputBytes = $script:Utf8.GetBytes(($inputObject | ConvertTo-Json -Compress))
        if ($inputBytes.Length -gt 131072) { throw 'X_EDGE_CALIBRATION_INVALID: 接続情報を確認できません。' }
        # 親環境の Node 起動オプションは子プロセスへ渡しません。
        $items = New-Object 'Collections.Generic.List[string]'
        $environment = [Environment]::GetEnvironmentVariables('Process')
        foreach ($name in $environment.Keys) {
            if (-not ([string]$name).StartsWith('=') -and @('NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE') -notcontains [string]$name) {
                $items.Add(([string]$name + '=' + [string]$environment[$name]))
            }
        }
        $items.Sort([StringComparer]::OrdinalIgnoreCase)
        $block = ($items -join [char]0) + [char]0 + [char]0
        $runtime = [IO.Path]::Combine($script:PackageRoot, 'ChromeNode.exe')
        $helper = [IO.Path]::Combine($script:PackageRoot, 'EdgeCalibrate.cjs')
        Assert-SafePath $runtime; Assert-SafePath $helper
        $job = [XEdgeNative.CalibrationJob]::Start($runtime, (Quote-WindowsArgument $helper), $script:PackageRoot, $block)
        $read = $job.ReadLimitedAsync(16384); $write = $job.WriteAndCloseAsync($inputBytes)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not $job.WaitForExit(100)) {
            if ($read.IsFaulted -or $write.IsFaulted -or $clock.ElapsedMilliseconds -ge 90000) { throw 'X_EDGE_CALIBRATION_FAILED: 接続の確認に失敗しました。もう一度お試しください。' }
        }
        if (-not $write.Wait(5000) -or -not $read.Wait(5000)) { throw 'X_EDGE_CALIBRATION_FAILED: 接続の確認に失敗しました。もう一度お試しください。' }
        $null = $write.GetAwaiter().GetResult(); $outputBytes = $read.GetAwaiter().GetResult()
        if ($job.ExitCode -ne 0 -or $outputBytes.Length -eq 0) { throw 'X_EDGE_CALIBRATION_FAILED: 接続の確認に失敗しました。もう一度お試しください。' }
        $result = $script:Utf8.GetString($outputBytes) | ConvertFrom-Json
        Assert-PropertyNames $result @('ok', 'browserVersion', 'client')
        Assert-PropertyNames $result.client @('channel', 'protocolVersion', 'clientName', 'clientVersion')
        if ($result.ok -ne $true -or $result.browserVersion -cne $BrowserVersion -or
            $result.client.channel -cnotmatch '^[0-9a-fA-F]{1,16}$' -or
            $result.client.protocolVersion -cnotmatch '^[\x20-\x7e]{1,32}$' -or
            $result.client.clientName -cnotmatch '^[\x20-\x7e]{1,128}$' -or
            $result.client.clientVersion -cnotmatch '^[\x20-\x7e]{1,64}$' -or
            ($result.client.protocolVersion + $result.client.clientName + $result.client.clientVersion) -match '[<>&]') {
            throw 'X_EDGE_CALIBRATION_FAILED: 接続の確認に失敗しました。もう一度お試しください。'
        }
        $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        $locale = [Globalization.CultureInfo]::CurrentUICulture.Name
        $osVersion = [Environment]::OSVersion.Version.ToString()
        if ($architecture -cnotmatch '^[a-z0-9]{1,32}$' -or $locale -cnotmatch '^[A-Za-z0-9-]{1,64}$' -or $osVersion -cnotmatch '^[0-9.]{1,64}$') {
            throw 'X_EDGE_CALIBRATION_FAILED: この PC の情報を確認できません。'
        }
        return [pscustomobject]@{ client = $result.client; agent = [pscustomobject]@{ os = 'Windows'; osVersion = $osVersion; architecture = $architecture; locale = $locale } }
    } finally {
        if ($null -ne $job) {
            try { $job.Stop() } catch { $cleanupFailed = $true }
            try { $job.Dispose() } catch { $cleanupFailed = $true }
        }
        if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
        if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
        if ($null -ne $certificate) { [Array]::Clear($certificate.pfx, 0, $certificate.pfx.Length); [Array]::Clear($certificate.certificate, 0, $certificate.certificate.Length) }
        $inputObject = $null; $certificate = $null
        if ($created -and -not $cleanupFailed) { try { Remove-XEdgeCalibration -CalibrationRoot $calibrationRoot -Token $token } catch { $cleanupFailed = $true } }
        if ($cleanupFailed) { throw 'X_EDGE_CALIBRATION_CLEANUP_FAILED: 一時保存先を確認できません。サポートへご相談ください。' }
    }
}
